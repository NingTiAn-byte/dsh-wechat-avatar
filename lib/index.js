// 宿主半（DSH 插件入口）：注册一个工具 + 可选定时轮询。只扫不做：发现算我的活，也只记待办。

import { WeChatAdapter, PLATFORM } from "./wechat.js";
import { judgeAll } from "./judge.js";
import { loadState, saveState, takeFresh, recordDecision, getChatSession, setChatSession } from "./state.js";
import { loadConfig, saveConfig, applyCliOverrides } from "./config.js";
import { gateOf } from "./policy.js";
import { namesForChat } from "./names.js";
import { workspaceFor, ensureGroup, addTask, stats as wsStats, describeWorkspace } from "./workspaces.js";
import { handler as apiHandler, API_PREFIX, setHandoff, setScan, setDshWs } from "./api.js";
import { handoffToDsh, readSessionReply, sessionCwd, userMessage } from "./handoff.js";
import { buildPrompt, parseVerdicts, entryOf, transcriptOf, waitReply } from "./ai.js";
import { nextDelay, nextFails, normalizePoll, describePoll } from "./schedule.js";

export const name = "dsh-wechat-avatar";
export const inject = ["tools"];

let whoCache = { key: "", who: null };
let aiPump = null;   // 真正的复核要会话服务，由 apply() 注入
let aiBusy = false;

/** 把等复核的消息排进 state.ai.pending（id 用任务 id，天然去重） */
function queueAi(entries) {
  if (!Array.isArray(entries) || !entries.length) return;
  const st = loadState();
  st.ai = st.ai || { session: "", pending: [], last_error: "", at: "" };
  const have = new Set((st.ai.pending || []).map((e) => e.id));
  for (const e of entries) if (e && e.id && !have.has(e.id)) { st.ai.pending.push(e); have.add(e.id); }
  st.ai.pending = (st.ai.pending || []).slice(-24);
  saveState(st);
  if (aiPump) setTimeout(() => { void aiPump(); }, 10);
}

/** 把 AI 的判定落到任务上：不是活就删掉并留档，是活就打上标记 */
function applyAiVerdicts(items, batch) {
  const cfg = loadConfig();
  const st = loadState();
  st.ai = st.ai || { session: "", pending: [], last_error: "", at: "" };
  const byId = new Map((batch || []).map((e) => [e.id, e]));
  let changed = 0;
  let dropped = 0;
  for (const v of items || []) {
    const entry = byId.get(v.id);
    if (!entry || !entry.task_id) continue;
    let ws = null;
    let task = null;
    for (const w of cfg.workspaces || []) {
      const t = (w.tasks || []).find((x) => x.id === entry.task_id);
      if (t) { ws = w; task = t; break; }
    }
    if (!task) continue;
    if (!v.is_work) {
      ws.tasks = (ws.tasks || []).filter((x) => x.id !== task.id);
      st.ai.dismissed = [...(st.ai.dismissed || []), {
        title: task.title, chat: entry.chat, reason: v.reason, at: new Date().toISOString(),
      }].slice(-50);
      dropped += 1;
    } else {
      task.ai = { is_work: true, reason: v.reason, confidence: v.confidence, at: new Date().toISOString() };
      if (v.deadline && !task.deadline) task.deadline = v.deadline;
      if (v.confidence > Number(task.confidence || 0)) task.confidence = v.confidence;
    }
    changed += 1;
  }
  if (changed) saveConfig(cfg);
  saveState(st);
  return { changed, dropped };
}

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
  const newTasks = [];
  const aiEntries = [];
  let filed = 0;
  let groupsCreated = 0;
  let cfgDirty = false;
  for (const chat of chats) {
    const gate = gateOf(chat, policy);
    if (gate === "off") { out.push({ chat: chat.name, chat_id: chat.chat_id, kind: chat.kind, gate, skipped: "未开启值守" }); continue; }
    const r = await im.fetchMessages(chat.chat_id, { limit: 30, since });
    if (!r.ok) { out.push({ chat: chat.name, chat_id: chat.chat_id, kind: chat.kind, gate, ok: false, error: r.error }); continue; }
    // whoami 拿不到账号时，fetchMessages 会从自己发的那条消息里认领 wxid，这一轮就补上
    if (!selfId && im.selfId) selfId = im.selfId;
    // 认领到的 wxid 存进配置，下一轮 whoami 再抽风也不怕漏掉自己发的消息
    if (selfId && !(cfg.self && cfg.self.id)) {
      cfg.self = { ...(cfg.self || {}), id: selfId };
      cfgDirty = true;
    }
    const fresh = takeFresh(state, chat.chat_id, r.messages);
    const selfNames = namesForChat(cfg.self, chat, who.self_name || "");   // 全局 + 这个群自己的称呼
    const decisions = judgeAll(fresh, { selfId, selfNames, chat, gate, nick: policy.nick !== false });
    for (const d of decisions) recordDecision(state, d);
    // 派给我的活自动落进所属任务组；没有组就按会话名自动建一个（自动归组）
    let ws = workspaceFor(cfg.workspaces, chat);
    if (!ws && cfg.group_auto !== false && decisions.some((d) => d.assigned)) {
      const made = ensureGroup(cfg.workspaces, chat, {
        dsh_workspace: cfg.default_dsh_workspace,
        dsh_workspace_path: cfg.default_dsh_workspace_path,
      });
      if (made && made.ws) {
        ws = made.ws;
        if (made.created) groupsCreated += 1;
      }
    }
    if (ws) {
      for (const d of decisions) {
        if (!d.assigned) continue;
        const added = addTask(ws, {
          title: d.task || d.content || "",
          source: { chat_id: chat.chat_id, chat_name: chat.name, msg_id: d.evidence?.msg_id, sender: d.evidence?.sender, ts: d.evidence?.ts },
          deadline: d.deadline, reply_needed: d.reply_needed, confidence: d.confidence,
        });
        if (added) {
          filed++;
          newTasks.push({ ws: ws.id, task: added.id, title: added.title });
          // 开了 AI 复核：把这条消息连同它前后的对话一起排队，等下交给 agent 再看一眼
          if (cfg.ai && cfg.ai.enabled) {
            const msg = fresh.find((m) => String(m.msg_id) === String(d.evidence && d.evidence.msg_id)) || {};
            const tr = transcriptOf(r.messages, selfId, chat, 12);
            aiEntries.push(entryOf("c_" + added.id, msg, chat, tr, added.id));
          }
        }
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
  state.who = { self_id: selfId, self_name: who.self_name || "" };
  saveState(state);
  if (aiEntries.length) queueAi(aiEntries);
  if (filed || groupsCreated || cfgDirty) saveConfig(cfg);   // 新任务 / 新任务组 / 认领到 self.id 才落盘
  return {
    platform: PLATFORM, mock, policy, scanned_at: new Date().toISOString(), chats: out,
    filed, newTasks, groups_created: groupsCreated, workspaces: (cfg.workspaces || []).map(describeWorkspace), task_stats: wsStats(cfg.workspaces),
  };
}

export function apply(ctx, config = {}) {
  // 交给 DSH 用到的会话服务；没注入成功就退回「只扫不做」
  let handoffCtx = null;

  // 交给 DSH：同一个群复用同一个会话（没有就新建），会话的 cwd 是 <DSH 工作区>\<群名>
  const handoffTask = async (task, ws = {}) => {
    if (!handoffCtx) return { ok: false, error: "宿主还没接上 DSH 会话服务" };
    const chatId = String((task.source && task.source.chat_id) || "");
    const st = loadState();
    const prev = chatId ? getChatSession(st, chatId) : null;
    const cwd = sessionCwd(ws, task.source || {});
    const r = await handoffToDsh(handoffCtx, task, ws, { sessionId: prev && prev.session_id, cwd });
    if (r && r.ok && r.sessionId && chatId) {
      const s2 = loadState();
      setChatSession(s2, chatId, { session_id: r.sessionId, reused: !!r.reused, cwd: r.cwd || cwd || "" });
      saveState(s2);
    }
    return r;
  };

  // 自动交付：config.handoff.auto=true 时，把这一轮新落的任务交给 agent
  const autoHandoff = async (res) => {
    const list = Array.isArray(res && res.newTasks) ? res.newTasks : [];
    if (!handoffCtx || !list.length) return 0;
    const cfg = loadConfig();
    if (!cfg.handoff || !cfg.handoff.auto) return 0;
    const cap = Math.max(0, Math.min(5, Math.round(Number(cfg.handoff.maxPerScan ?? 2) || 0)));
    // 同一个群同时只跑一条：上一条还没回执就先排队，下一轮再交
    const busy = new Set();
    for (const w of cfg.workspaces || []) {
      for (const t of w.tasks || []) {
        if (t.session_id && !t.reply && t.status !== "done") busy.add(String((t.source && t.source.chat_id) || ""));
      }
    }
    let done = 0;
    for (const item of list.slice(0, cap)) {
      const ws = (cfg.workspaces || []).find((w) => w.id === item.ws);
      const task = ws && (ws.tasks || []).find((t) => t.id === item.task);
      if (!task || task.session_id) continue;
      if (busy.has(String((task.source && task.source.chat_id) || ""))) continue;
      const r = await handoffTask(task, ws);
      if (!r || !r.ok) {
        console.warn("[wechat-avatar] 自动交给 DSH 失败:", (r && r.error) || "未知原因");
        continue;
      }
      task.session_id = r.sessionId;
      task.handed_at = new Date().toISOString();
      if (task.status !== "done") task.status = "doing";
      done += 1;
    }
    if (done) saveConfig(cfg);
    return done;
  };

  // 回执：agent 这一轮收尾后，把最终回复写进任务，管理页里能直接复制
  const syncReplies = async () => {
    if (!handoffCtx) return 0;
    const cfg = loadConfig();
    let changed = 0;
    for (const ws of cfg.workspaces || []) {
      for (const t of ws.tasks || []) {
        if (!t.session_id || t.reply || t.status === "done") continue;
        const r = await readSessionReply(handoffCtx, t.session_id);
        if (!r.ok || !r.ended || !r.text) continue;
        t.reply = r.text.slice(0, 4000);
        t.replied_at = new Date().toISOString();
        t.status = "done";
        changed += 1;
      }
    }
    if (changed) saveConfig(cfg);
    return changed;
  };

  const run = async (args = {}) => {
    const res = await scanOnce({ ...config, ...args });
    try {
      const handed = await autoHandoff(res);
      if (handed) res.auto_handed = handed;
      const replied = await syncReplies();
      if (replied) res.replied = replied;
    } catch (e) {
      console.warn("[wechat-avatar] 自动交付/回执出错:", e && e.message);
    }
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
    setScan((args = {}) => run({ ...args }));
    ctx?.on?.("dispose", () => setScan(null));
  } catch (e) {
    console.warn("[wechat-avatar] 手动扫描注册失败:", e && e.message);
  }

  // 管理页的「默认 DSH 工作区」下拉：从宿主注册表读（客户端 ctx.get("workspaces") 读的时候常常还是空的）
  try {
    ctx.inject(["workspaceRegistry"], (regCtx) => {
      setDshWs(() => {
        const reg = regCtx.workspaceRegistry;
        const list = reg && typeof reg.list === "function" ? reg.list() : [];
        return (list || [])
          .map((w) => ({
            workspaceId: String((w && w.id) || ""),
            title: String((w && w.title) || ""),
            path: String((w && w.path) || ""),
          }))
          .filter((w) => w.workspaceId);
      });
      regCtx.effect(() => () => setDshWs(null));
    });
  } catch (e) {
    console.warn("[wechat-avatar] DSH 工作区列表注册失败:", e && e.message);
  }

  // AI 复核：规则判完后把候选消息连同上下文交给一个专用 DSH 会话，让它判「是不是真活」。
  // 只做「删错任务 / 给对的打标记」，不会自己发消息；失败就记在 state.ai.last_error 里，规则结果保留。
  const reviewAi = async () => {
    if (aiBusy || !handoffCtx) return;
    const cfg = loadConfig();
    if (!cfg.ai || !cfg.ai.enabled) return;
    const sc = handoffCtx.sessionController;
    if (!sc || typeof sc.create !== "function") return;
    const st0 = loadState();
    const pending = Array.isArray(st0.ai && st0.ai.pending) ? st0.ai.pending.slice() : [];
    if (!pending.length) return;
    aiBusy = true;
    try {
      let sid = (st0.ai && st0.ai.session) || "";
      let alive = false;
      if (sid) {
        const r = await readSessionReply(handoffCtx, sid);
        alive = !!(r && r.ok);
      }
      if (!alive) {
        const created = await sc.create(cfg.default_dsh_workspace ? { workspaceId: cfg.default_dsh_workspace } : {});
        sid = created && created.sessionId;
        if (!sid) throw new Error("开不了判定会话");
        const st = loadState();
        st.ai = st.ai || {};
        st.ai.session = sid;
        saveState(st);
      }
      const per = Math.max(1, Math.min(12, Number(cfg.ai.perRound) || 8));
      const batch = pending.slice(0, per);
      const selfId = (st0.who && st0.who.self_id) || (cfg.self && cfg.self.id) || "";
      const selfName = (st0.who && st0.who.self_name) || ((cfg.self && cfg.self.names && cfg.self.names[0]) || "");
      const prompt = buildPrompt(batch, { selfId, selfName });
      const resolved = await sc.resolveAgent(sid);
      if (!resolved || !resolved.agent) throw new Error("判定会话拿不到 agent");
      resolved.agent.followup(userMessage(prompt));
      const rr = await waitReply(handoffCtx, sid, { reader: { readSessionReply }, timeoutMs: 120000 });
      if (!rr || !rr.ok) throw new Error((rr && rr.error) || "AI 没回话");
      const parsed = parseVerdicts(rr.text);
      if (!parsed.ok) throw new Error(parsed.error || "AI 的回复不是 JSON");
      const done = applyAiVerdicts(parsed.items, batch);
      const st2 = loadState();
      const used = new Set(batch.map((e) => e.id));
      st2.ai = st2.ai || {};
      st2.ai.pending = (st2.ai.pending || []).filter((e) => !used.has(e.id));
      st2.ai.last_error = "";
      st2.ai.at = new Date().toISOString();
      saveState(st2);
      console.log("[wechat-avatar] AI 复核:", done.changed, "条，丢掉", done.dropped, "条误判");
    } catch (e) {
      const st3 = loadState();
      st3.ai = st3.ai || {};
      st3.ai.last_error = (e && e.message) || String(e);
      saveState(st3);
      console.warn("[wechat-avatar] AI 复核失败:", st3.ai.last_error);
    } finally {
      aiBusy = false;
    }
    const left = await Promise.resolve((loadState().ai && loadState().ai.pending) || []);
    if (left.length) setTimeout(() => { void reviewAi(); }, 1500);
  };
  aiPump = reviewAi;

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
        handoffCtx = scCtx;
        setHandoff((task, ws) => handoffTask(task, ws));
        return () => { handoffCtx = null; setHandoff(null); aiPump = null; };
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
