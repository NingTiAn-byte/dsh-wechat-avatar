// 宿主半（DSH 插件入口）：注册一个工具 + 可选定时轮询。只扫不做：发现算我的活，也只记待办。

import { WeChatAdapter, PLATFORM } from "./wechat.js";
import { judgeAll } from "./judge.js";
import { loadState, saveState, takeFresh, recordDecision } from "./state.js";
import { loadConfig, saveConfig, applyCliOverrides } from "./config.js";
import { gateOf } from "./policy.js";
import { namesForChat } from "./names.js";
import { workspaceFor, addTask, stats as wsStats, describeWorkspace } from "./workspaces.js";
import { handler as apiHandler, API_PREFIX, setHandoff, setScan } from "./api.js";
import { handoffToDsh } from "./handoff.js";
import { nextDelay, nextFails, normalizePoll, describePoll } from "./schedule.js";

export const name = "dsh-wechat-avatar";
export const inject = ["tools"];

let whoCache = { key: "", who: null };

async function scanOnce(config = {}) {
  const mock = !!config.mock;
  const cfg = loadConfig();
  const watch = Array.isArray(cfg.watch) ? cfg.watch.map((x) => String(x || "").trim()).filter(Boolean) : [];
  const policy = { ...cfg.policy, ...(config.policy || {}) };
  const im = new WeChatAdapter({
    mock,
    cli: config.cli || "weflow-cli",
    selfId: config.selfId || cfg.self?.id || (mock ? "wxid_me" : ""),
    selfNames: config.selfNames || (mock ? ["我"] : []),
  });
  // whoami 只打一次：结果按 cli 缓存，别每 60 秒多起一个进程
  const key = (mock ? "mock:" : "cli:") + (config.cli || "weflow-cli");
  if (whoCache.key !== key) whoCache = { key, who: await im.whoami().catch(() => ({ ok: false })) };
  const who = whoCache.who || {};
  let selfId = im.selfId || who.self_id || "";
  const state = loadState();
  const since = new Date(Date.now() - (config.lookbackMin ?? 120) * 60000).toISOString();

  const listed = await im.listChats(watch.length ? 200 : 50);
  const ids = config.chats?.length ? config.chats : null;
  const all = listed.items || [];
  const chats = all.filter((c) => {
    if (ids) return ids.includes(c.chat_id);
    if (!watch.length) return true;
    return watch.includes(c.chat_id) || watch.includes(c.name);
  });
  // 留给管理页：最近一次扫描看到的会话，别再让用户手抄 chat_id。
  // 列表读失败时别把上一次的结果清空——面板靠它出下拉。
  if (all.length) {
    state.chat_list = all.map((c) => ({ chat_id: c.chat_id, name: c.name, kind: c.kind, member_count: c.member_count ?? 0 }));
    state.scan_error = "";
  } else {
    state.chat_list = state.chat_list || [];
    state.scan_error = listed.ok ? "" : (listed.error || "会话列表为空");
  }
  state.who = { self_id: selfId, self_name: who.self_name || "" };
  state.scanned_at = new Date().toISOString();

  const out = [];
  let filed = 0;
  for (const chat of chats) {
    const gate = gateOf(chat, policy);
    if (gate === "off") { out.push({ chat: chat.name, chat_id: chat.chat_id, kind: chat.kind, gate, skipped: "未开启值守" }); continue; }
    const r = await im.fetchMessages(chat.chat_id, { limit: 30, since });
    if (!r.ok) { out.push({ chat: chat.name, chat_id: chat.chat_id, kind: chat.kind, gate, ok: false, error: r.error }); continue; }
    // whoami 拿不到账号时，fetchMessages 会从自己发的那条消息里认领 wxid，这一轮就补上
    if (!selfId && im.selfId) selfId = im.selfId;
    const fresh = takeFresh(state, chat.chat_id, r.messages);
    const selfNames = namesForChat(cfg.self, chat, who.self_name || "");   // 全局 + 这个群自己的称呼
    const decisions = judgeAll(fresh, { selfId, selfNames, chat, gate, nick: policy.nick !== false });
    for (const d of decisions) recordDecision(state, d);
    // 派给我的活自动落进绑定了这个会话的工作区；同一个 msg_id 只记一次
    const ws = workspaceFor(cfg.workspaces, chat);
    if (ws) {
      for (const d of decisions) {
        if (!d.assigned) continue;
        const added = addTask(ws, {
          title: d.task || d.content || "",
          source: { chat_id: chat.chat_id, chat_name: chat.name, msg_id: d.evidence?.msg_id, sender: d.evidence?.sender, ts: d.evidence?.ts },
          deadline: d.deadline, reply_needed: d.reply_needed, confidence: d.confidence,
        });
        if (added) filed++;
      }
    }
    out.push({
      chat: chat.name, chat_id: chat.chat_id, kind: chat.kind, gate,
      fetched: r.messages.length, fresh: fresh.length,
      decisions: decisions.map((d) => ({
        assigned: d.assigned, reply_needed: d.reply_needed, owner: d.owner,
        task: d.task, deadline: d.deadline, confidence: d.confidence, reason: d.reason,
      })),
    });
  }
  saveState(state);
  if (filed) saveConfig(cfg);   // 新任务落盘；没新任务就不碰配置文件
  return {
    platform: PLATFORM, mock, policy, scanned_at: new Date().toISOString(), chats: out,
    filed, workspaces: (cfg.workspaces || []).map(describeWorkspace), task_stats: wsStats(cfg.workspaces),
  };
}

export function apply(ctx, config = {}) {
  const run = async (args = {}) => {
    const res = await scanOnce({ ...config, ...args });
    const hits = res.chats.flatMap((c) => (c.decisions || []).filter((d) => d.assigned));
    return { ...res, summary: hits.length ? "发现 " + hits.length + " 条派给你的活" : "没有新派活" };
  };

  ctx?.tools?.register?.({
    name: "wechat_duty_scan",
    description: "扫描微信值守会话，判定哪些消息是派给本人的活（私聊默认算，群聊默认要 @我；规则判定，默认示例数据）",
    parameters: {
      type: "object",
      properties: {
        mock: { type: "boolean", description: "用内置示例数据演示" },
        chats: { type: "array", items: { type: "string" }, description: "要值守的会话 id 列表" },
        lookbackMin: { type: "number", description: "回看多少分钟" },
        policy: {
          type: "object",
          description: "覆盖 config.json：dm=always|mention|off，group=mention_only|always|off，overrides={chat_id: always|mention_only|off}",
        },
      },
      required: [],
    },
    output: {
      schema: { type: "object" },
      render: (_args, value) => {
        const v = value || {};
        const chats = Array.isArray(v.chats) ? v.chats : [];
        const lines = [];
        lines.push(`扫描 ${chats.length} 个会话；派给我的活 ${v.filed ?? 0} 条新落盘`);
        for (const c of chats) {
          const dec = Array.isArray(c.decisions) ? c.decisions : [];
          lines.push("");
          lines.push(`${c.chat}（${c.kind}，闸门=${c.gate}）拉到 ${c.fetched ?? 0} 条，新增 ${c.fresh ?? 0} 条`);
          if (c.error) { lines.push(`  读取失败：${c.error}`); continue; }
          if (c.skipped) { lines.push(`  跳过：${c.skipped}`); continue; }
          for (const d of dec) {
            const tag = d.assigned ? "PASS" : d.reply_needed ? "REPLY" : "--  ";
            lines.push(`  ${tag} conf=${d.confidence} ${d.owner}：${d.task || d.reason || ""}`);
          }
        }
        if (v.summary) { lines.push(""); lines.push(v.summary); }
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args) { return run(args); },
    timeoutMs: 120000,
  });

  // 管理页「立即扫描」：手动跑一轮，不用等下一次轮询
  try {
    setScan((args = {}) => scanOnce({ ...config, ...args }));
    ctx?.on?.("dispose", () => setScan(null));
  } catch (e) {
    console.warn("[wechat-avatar] 手动扫描注册失败:", e && e.message);
  }

  // 管理页接口：/dsh-wechat-avatar/api/*（只对本机同源页面开放，见 lib/api.js）
  try {
    ctx.inject(["webServer"], (webCtx) => {
      try {
        webCtx.effect(() => webCtx.webServer.register({ kind: "prefix", path: API_PREFIX, handler: apiHandler }));
      } catch (e) {
        console.warn("[wechat-avatar] 管理页路由注册失败:", e && e.message);
      }
    });
  } catch (e) {
    console.warn("[wechat-avatar] webServer 服务不可用:", e && e.message);
  }

  // 「交给 DSH」：管理页点按钮 → 新建会话 → 把任务作为用户消息投给 agent（等你确认后才动手）
  try {
    ctx.inject(["sessionController"], (scCtx) => {
      scCtx.effect(() => {
        setHandoff((task, ws) => handoffToDsh(scCtx, task, ws));
        return () => setHandoff(null);
      });
    });
  } catch (e) {
    console.warn("[wechat-avatar] sessionController 服务不可用，交不了任务:", e && e.message);
  }

  // 自动轮询：默认 60 秒一轮，失败按 2^n 退避，最多 10 分钟一轮
  const poll = normalizePoll({ ...(loadConfig().poll || {}), ...(config.poll || {}) });
  let timer = null;
  let fails = 0;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    let ok = true;
    try { await run({}); } catch { ok = false; }
    fails = nextFails(fails, ok);
    if (stopped) return;
    const delay = nextDelay(fails, poll);
    if (!delay) return;
    timer = setTimeout(tick, delay);
    if (timer?.unref) timer.unref();
  };

  if (poll.sec > 0 && config.autoPoll !== false) {
    timer = setTimeout(tick, nextDelay(0, poll));
    if (timer?.unref) timer.unref();
    ctx?.on?.("dispose", () => { stopped = true; if (timer) clearTimeout(timer); });
  }
}

export { scanOnce, applyCliOverrides, describePoll };
