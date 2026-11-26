// 管理页的后端：只给本机同源页面用，读写 config.json、回传上次扫描到的会话列表。
// 路由前缀 /dsh-wechat-avatar（webServer.register kind="prefix"）。
import { loadConfig, saveConfig } from "./config.js";
import { loadState, saveState, dropChatSession } from "./state.js";
import { normalizeWorkspaces, addWorkspace, updateWorkspace, removeWorkspace, addTask, setTaskStatus, removeTask, stats } from "./workspaces.js";
import { add as lessonAdd } from "./lessons.js";

export const API_PREFIX = "/dsh-wechat-avatar";

// 总览：面板一次拉走计数、需要我处理的、正在干的、按群统计和异常
function overviewOf() {
  const cfg = loadConfig();
  const st = loadState();
  const rows = [];
  for (const w of cfg.workspaces || []) for (const t of w.tasks || []) rows.push({ ws: w, t });
  const today = new Date().toISOString().slice(0, 10);
  const brief = ({ ws, t }) => ({
    task_id: t.id,
    ws_id: ws.id,
    ws_name: ws.name,
    chat: (t.source && t.source.chat_name) || "",
    chat_id: (t.source && t.source.chat_id) || "",
    sender: (t.source && t.source.sender) || "",
    title: t.title || "",
    status: t.status || "todo",
    kind: t.kind || "task",
    need: t.need || "",
    ask: t.ask || "",
    reply: t.reply ? String(t.reply).slice(0, 400) : "",
    session_id: t.session_id || "",
    at: (t.source && t.source.ts) || "",
    created_at: t.created_at || "",
    kb_hit: t.kb_hit || null,
  });
  const needYou = rows.filter((x) => x.t.kind === "needs_you" || x.t.status === "need_info").map(brief);
  const waiting = rows.filter((x) => x.t.status === "waiting" && !x.t.reply).map(brief);
  const doing = rows.filter((x) => x.t.session_id && !x.t.reply && x.t.status !== "done" && x.t.status !== "need_info").map(brief);
  const todayNew = rows.filter((x) => String((x.t.source && x.t.source.ts) || "").slice(0, 10) === today);
  const byChat = new Map();
  for (const r of rows) {
    const k = (r.t.source && r.t.source.chat_name) || "未知";
    byChat.set(k, (byChat.get(k) || 0) + 1);
  }
  const ai = st.ai || {};
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    counts: {
      need_info: needYou.length, waiting: waiting.length, doing: doing.length,
      today_new: todayNew.length,
      done: rows.filter((x) => x.t.status === "done").length,
      total: rows.length,
    },
    need_you: needYou.slice(0, 20),
    waiting: waiting.slice(0, 20),
    doing: doing.slice(0, 20),
    lessons: Array.isArray(st.lessons) ? st.lessons.length : 0,
    by_chat: [...byChat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([chat, n]) => ({ chat, count: n })),
    anomalies: {
      scan_error: st.scan_error || "", scan_at: st.scanned_at || "",
      ai_error: ai.last_error || "", ai_at: ai.at || "",
    },
  };
}

// 交给 DSH 的钩子：由宿主半（lib/index.js）注入，api.js 自己不认识 DSH 会话。
let handoffFn = null;
export function setHandoff(fn) {
  handoffFn = typeof fn === "function" ? fn : null;
}
// 「立即扫描」：宿主半注入 scanOnce，管理页点一下就跑一轮
let scanFn = null;
export function setScan(fn) {
  scanFn = typeof fn === "function" ? fn : null;
}
// DSH 自己的工作区列表：宿主半注入（api.js 拿不到宿主 ctx），管理页用它填下拉
let dshWsFn = null;
export function setDshWs(fn) {
  dshWsFn = typeof fn === "function" ? fn : null;
}
const MAX_BODY = 256 * 1024;
const GATES = new Set(["always", "mention", "mention_only", "off"]);

const cleanArr = (v) =>
  Array.isArray(v)
    ? [...new Set(v.map((x) => String(x ?? "").trim()).filter(Boolean).map((s) => s.slice(0, 40)))]
    : null;
// 监听范围用更长上限：群名可能长，chat_id 也可能带长串
const cleanWatch = (v) =>
  Array.isArray(v)
    ? [...new Set(v.map((x) => String(x ?? "").trim()).filter(Boolean).map((s) => s.slice(0, 120)))].slice(0, 300)
    : null;

/** 只接受认识的字段，值越界就丢掉——管理页写坏配置比没有管理页更糟 */
export function sanitizePatch(patch = {}) {
  const out = {};
  if (patch && patch.self && typeof patch.self === "object") {
    const self = {};
    const names = cleanArr(patch.self.names);
    if (names) self.names = names;
    if (patch.self.byChat && typeof patch.self.byChat === "object" && !Array.isArray(patch.self.byChat)) {
      const byChat = {};
      for (const [k, v] of Object.entries(patch.self.byChat)) {
        const key = String(k || "").trim().slice(0, 120);
        const arr = cleanArr(v);
        if (key && arr && arr.length) byChat[key] = arr;
      }
      self.byChat = byChat;
    }
    if (Object.keys(self).length) out.self = self;
  }
  if (patch && patch.policy && typeof patch.policy === "object") {
    const p = {};
    if (GATES.has(patch.policy.dm)) p.dm = patch.policy.dm;
    if (GATES.has(patch.policy.group)) p.group = patch.policy.group;
    if (typeof patch.policy.nick === "boolean") p.nick = patch.policy.nick;
    if (patch.policy.overrides && typeof patch.policy.overrides === "object") {
      const o = {};
      for (const [k, v] of Object.entries(patch.policy.overrides)) if (GATES.has(v)) o[String(k).slice(0, 120)] = v;
      p.overrides = o;
    }
    if (Object.keys(p).length) out.policy = p;
  }
  if (patch && patch.answer && typeof patch.answer === "object") {
    const an = {};
    if (typeof patch.answer.auto === "boolean") an.auto = patch.answer.auto;
    if (Object.keys(an).length) out.answer = an;
  }
  if (patch && patch.ai && typeof patch.ai === "object") {
    const ai = {};
    if (typeof patch.ai.enabled === "boolean") ai.enabled = patch.ai.enabled;
    const n = Number(patch.ai.perRound);
    if (Number.isFinite(n)) ai.perRound = Math.max(1, Math.min(12, Math.round(n)));
    if (Object.keys(ai).length) out.ai = ai;
  }
  if (patch && patch.poll && typeof patch.poll === "object") {
    const poll = {};
    const num = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : null);
    const sec = num(patch.poll.sec, 0, 3600);
    if (sec !== null) poll.sec = sec;
    const jitter = num(patch.poll.jitter, 0, 0.5);
    if (jitter !== null) poll.jitter = jitter;
    const backoff = num(patch.poll.backoff_max_sec, 60, 3600);
    if (backoff !== null) poll.backoff_max_sec = backoff;
    if (Object.keys(poll).length) out.poll = poll;
  }
  if (patch && patch.handoff && typeof patch.handoff === "object") {
    const ho = {};
    if (typeof patch.handoff.auto === "boolean") ho.auto = patch.handoff.auto;
    const max = Number(patch.handoff.maxPerScan);
    if (Number.isFinite(max)) ho.maxPerScan = Math.min(5, Math.max(0, Math.round(max)));
    if (Object.keys(ho).length) out.handoff = ho;
  }
  if (typeof patch.group_auto === "boolean") out.group_auto = patch.group_auto;
  if (typeof patch.default_dsh_workspace === "string") out.default_dsh_workspace = patch.default_dsh_workspace.trim().slice(0, 120);
  if (typeof patch.default_dsh_workspace_path === "string") out.default_dsh_workspace_path = patch.default_dsh_workspace_path.trim().slice(0, 400);
  if (patch && Array.isArray(patch.watch)) out.watch = cleanWatch(patch.watch) || [];
  if (patch && Array.isArray(patch.workspaces)) out.workspaces = normalizeWorkspaces(patch.workspaces);
  return out;
}

/** 合并补丁：byChat / overrides 整表替换（页面每次提交完整表），其余浅合并 */
export function mergePatch(cfg, patch) {
  const next = {
    ...cfg,
    self: { ...(cfg.self || {}), ...(patch.self || {}) },
    policy: { ...(cfg.policy || {}), ...(patch.policy || {}) },
    poll: { ...(cfg.poll || {}), ...(patch.poll || {}) },
    handoff: { ...(cfg.handoff || {}), ...(patch.handoff || {}) },
    ai: { ...(cfg.ai || {}), ...(patch.ai || {}) },
    answer: { ...(cfg.answer || {}), ...(patch.answer || {}) },
  };
  if (patch.self && patch.self.byChat) next.self.byChat = patch.self.byChat;
  if (patch.policy && patch.policy.overrides) next.policy.overrides = patch.policy.overrides;
  if (typeof patch.group_auto === "boolean") next.group_auto = patch.group_auto;
  if (typeof patch.default_dsh_workspace === "string") next.default_dsh_workspace = patch.default_dsh_workspace;
  if (typeof patch.default_dsh_workspace_path === "string") next.default_dsh_workspace_path = patch.default_dsh_workspace_path;
  if (patch.watch) next.watch = patch.watch;
  if (patch.workspaces) next.workspaces = patch.workspaces;
  return next;
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("请求体过大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 读 JSON 体；坏了直接回 400 并返回 null */
async function readJson(req, res) {
  const raw = await readBody(req);
  try {
    const body = JSON.parse(raw || "{}");
    return body && typeof body === "object" ? body : (send(res, 400, { ok: false, error: "请求体必须是对象" }), null);
  } catch {
    send(res, 400, { ok: false, error: "不是合法 JSON" });
    return null;
  }
}

function isLocalAddress(addr) {
  const a = String(addr || "");
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

/** 只服务本机页面：拒绝非回环来源，以及跨站 Origin 的写请求 */
function trusted(req) {
  if (!isLocalAddress(req.socket && req.socket.remoteAddress)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;                                  // 同源 fetch 在某些宿主里不带 Origin
  try {
    const u = new URL(origin);
    return u.host.toLowerCase() === String(req.headers.host || "").toLowerCase();
  } catch {
    return false;
  }
}

export async function handler(req, res) {
  if (!trusted(req)) return send(res, 403, { ok: false, error: "只对本机页面开放" });
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const path = url.pathname;
    const cfgUrl = API_PREFIX + "/api/config";
    if (path === cfgUrl) {
      if (req.method === "GET") {
        const cfg = loadConfig();
        const state = loadState();
        return send(res, 200, {
          ok: true,
          config: cfg,
          chats: state.chat_list || [],
          who: state.who || null,
          ai: state.ai || null,
          saved_at: state.scanned_at || "",
        });
      }
      if (req.method === "POST") {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw || "{}"); } catch { return send(res, 400, { ok: false, error: "不是合法 JSON" }); }
        const patch = sanitizePatch(body);
        const next = mergePatch(loadConfig(), patch);
        saveConfig(next);
        return send(res, 200, { ok: true, config: next });
      }
      return send(res, 405, { ok: false, error: "method_not_allowed" });
    }
    if (path === API_PREFIX + "/api/workspace") {
      if (req.method !== "POST") return send(res, 405, { ok: false, error: "method_not_allowed" });
      const body = await readJson(req, res);
      if (!body) return;
      const cfg = loadConfig();
      cfg.workspaces = normalizeWorkspaces(cfg.workspaces);
      const action = String(body.action || "");
      if (action === "add") addWorkspace(cfg.workspaces, { name: body.name, chats: body.chats, dsh_workspace: body.dsh_workspace, dsh_workspace_path: body.dsh_workspace_path });
      else if (action === "update") {
        if (!updateWorkspace(cfg.workspaces, body.id, { name: body.name, chats: body.chats, dsh_workspace: body.dsh_workspace, dsh_workspace_path: body.dsh_workspace_path })) {
          return send(res, 404, { ok: false, error: "工作区不存在" });
        }
      } else if (action === "remove") {
        if (!removeWorkspace(cfg.workspaces, body.id)) return send(res, 404, { ok: false, error: "工作区不存在" });
      } else {
        return send(res, 400, { ok: false, error: "action 只能是 add / update / remove" });
      }
      saveConfig(cfg);
      return send(res, 200, { ok: true, config: cfg, stats: stats(cfg.workspaces) });
    }
    if (path === API_PREFIX + "/api/kb") {
      if (req.method !== "GET") return send(res, 405, { ok: false, error: "method_not_allowed" });
      const kb = await import("./kb.js");
      if (url.searchParams.get("stats")) return send(res, 200, { ok: true, stats: kb.stats() });
      const q = url.searchParams.get("q") || "";
      const chat = url.searchParams.get("chat") || "";
      const limit = Number(url.searchParams.get("limit") || 10);
      return send(res, 200, { ok: true, items: kb.search(q, { chat, limit }), stats: kb.stats() });
    }
    if (path === API_PREFIX + "/api/overview") {
      if (req.method !== "GET") return send(res, 405, { ok: false, error: "method_not_allowed" });
      try { return send(res, 200, overviewOf()); }
      catch (e) { return send(res, 500, { ok: false, error: String((e && e.message) || e) }); }
    }
    if (path === API_PREFIX + "/api/dshws") {
      if (req.method !== "GET") return send(res, 405, { ok: false, error: "method_not_allowed" });
      let items = [];
      let error = "";
      if (!dshWsFn) error = "宿主半还没加载工作区列表：重启 DSH 之后再试";
      else {
        try { items = dshWsFn() || []; } catch (e) { error = String((e && e.message) || e); }
      }
      return send(res, 200, { ok: true, available: !!dshWsFn, items: Array.isArray(items) ? items : [], error });
    }
    if (path === API_PREFIX + "/api/scan") {
      if (req.method !== "POST") return send(res, 405, { ok: false, error: "method_not_allowed" });
      if (!scanFn) return send(res, 501, { ok: false, error: "宿主半还没加载手动扫描：重启 DSH 之后再点" });
      let r = null;
      try { r = await scanFn({}); } catch (e) { return send(res, 500, { ok: false, error: String((e && e.message) || e) }); }
      const chats = (r && r.chats) || [];
      return send(res, 200, {
        ok: true,
        filed: (r && r.filed) || 0,
        scanned_at: (r && r.scanned_at) || "",
        chats: chats.map((c) => ({
          chat: c.chat, chat_id: c.chat_id, kind: c.kind, gate: c.gate,
          fetched: c.fetched ?? 0, fresh: c.fresh ?? 0,
          error: c.error || "", skipped: c.skipped || "",
          assigned: (c.decisions || []).filter((d) => d.assigned).length,
        })),
      });
    }
    if (path === API_PREFIX + "/api/handoff") {
      if (req.method !== "POST") return send(res, 405, { ok: false, error: "method_not_allowed" });
      const body = await readJson(req, res);
      if (!body) return;
      if (!handoffFn) return send(res, 501, { ok: false, error: "这个 DSH 部署没有会话服务，交不了" });
      const cfg = loadConfig();
      cfg.workspaces = normalizeWorkspaces(cfg.workspaces);
      const ws = (cfg.workspaces || []).find((w) => w.id === String(body.wsId || ""));
      if (!ws) return send(res, 404, { ok: false, error: "工作区不存在" });
      const task = (ws.tasks || []).find((t) => t.id === String(body.taskId || ""));
      if (!task) return send(res, 404, { ok: false, error: "任务不存在" });
      const r = await handoffFn(task, ws);
      if (!r || !r.ok) return send(res, 502, { ok: false, error: (r && r.error) || "交给 DSH 失败", sessionId: (r && r.sessionId) || "" });
      task.session_id = r.sessionId;
      task.handed_at = new Date().toISOString();
      if (task.status !== "done") setTaskStatus(ws, task.id, "doing");
      saveConfig(cfg);
      return send(res, 200, { ok: true, sessionId: r.sessionId, reused: !!r.reused, config: cfg, stats: stats(cfg.workspaces) });
    }
    if (path === API_PREFIX + "/api/session") {
      if (req.method !== "POST") return send(res, 405, { ok: false, error: "method_not_allowed" });
      const body = await readJson(req, res);
      if (!body) return;
      const chatId = String(body.chat_id || "").trim().slice(0, 120);
      if (!chatId) return send(res, 400, { ok: false, error: "chat_id_required" });
      const st = loadState();
      dropChatSession(st, chatId);
      saveState(st);
      return send(res, 200, { ok: true, chat_id: chatId });
    }
    if (path === API_PREFIX + "/api/task") {
      if (req.method !== "POST") return send(res, 405, { ok: false, error: "method_not_allowed" });
      const body = await readJson(req, res);
      if (!body) return;
      const cfg = loadConfig();
      cfg.workspaces = normalizeWorkspaces(cfg.workspaces);
      const ws = (cfg.workspaces || []).find((w) => w.id === String(body.wsId || ""));
      if (!ws) return send(res, 404, { ok: false, error: "工作区不存在" });
      const action = String(body.action || "add");
      let task = null;
      if (action === "add") {
        task = addTask(ws, { title: body.title, source: body.source, deadline: body.deadline, note: body.note, confidence: body.confidence, reply_needed: body.reply_needed });
        if (!task) return send(res, 400, { ok: false, error: "任务标题不能为空，或这条消息已经记过" });
      } else if (action === "status") {
        task = setTaskStatus(ws, body.taskId, body.status);
        if (!task) return send(res, 404, { ok: false, error: "任务不存在" });
      } else if (action === "remove") {
        if (!removeTask(ws, body.taskId)) return send(res, 404, { ok: false, error: "任务不存在" });
      } else if (action === "dismiss") {
        // 叉掉 = 删任务 + 记否例，之后扫描到形似的消息不再当活
        const gone = (ws.tasks || []).find((t) => t.id === String(body.taskId || ""));
        if (!removeTask(ws, body.taskId)) return send(res, 404, { ok: false, error: "任务不存在" });
        if (gone) {
          lessonAdd({
            text: gone.title || gone.need || "",
            chat_id: gone.source && gone.source.chat_id,
            chat: gone.source && gone.source.chat_name,
            sender: gone.source && gone.source.sender,
            kind: gone.kind,
          });
        }
      } else {
        return send(res, 400, { ok: false, error: "action 只能是 add / status / remove / dismiss" });
      }
      saveConfig(cfg);
      return send(res, 200, { ok: true, config: cfg, task, stats: stats(cfg.workspaces) });
    }
    return send(res, 404, { ok: false, error: "not_found" });
  } catch (e) {
    return send(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}
