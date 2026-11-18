// 工作区 = 一组会话 + 一组任务。群里判定为「派给我的活」时，自动落到绑定了该会话的工作区。
// 纯数据层：不碰 io，方便单测；落盘由 config.js 负责。

import { randomBytes } from "node:crypto";

export const TASK_STATUS = ["todo", "doing", "done"];
export const TASK_CAP = 200;   // 每个工作区最多留 200 条，超了丢最老的
export const WS_CAP = 30;

const clean = (v, n) => String(v ?? "").trim().slice(0, n);

export function wsId(name = "") {
  const slug = clean(name, 20)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return "ws_" + (slug || "x") + "_" + randomBytes(2).toString("hex");
}

export function newTaskId() {
  return "t_" + randomBytes(3).toString("hex");
}

export function normalizeTask(t = {}) {
  const src = t.source && typeof t.source === "object" ? t.source : {};
  return {
    id: clean(t.id, 40) || newTaskId(),
    title: clean(t.title, 200),
    status: TASK_STATUS.includes(t.status) ? t.status : "todo",
    source: {
      chat_id: clean(src.chat_id, 120),
      chat_name: clean(src.chat_name, 60),
      msg_id: clean(src.msg_id, 120),
      sender: clean(src.sender, 60),
      ts: clean(src.ts, 40),
    },
    deadline: clean(t.deadline, 40),
    note: clean(t.note, 500),
    reply_needed: !!t.reply_needed,
    confidence: Number.isFinite(Number(t.confidence)) ? Number(t.confidence) : 0,
    created_at: clean(t.created_at, 40) || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export function normalizeWorkspace(w = {}) {
  const tasks = Array.isArray(w.tasks)
    ? w.tasks.map(normalizeTask).filter((t) => t.title).slice(-TASK_CAP)
    : [];
  return {
    id: clean(w.id, 40) || wsId(w.name),
    name: clean(w.name, 60) || "未命名工作区",
    chats: Array.isArray(w.chats) ? [...new Set(w.chats.map((c) => clean(c, 120)).filter(Boolean))] : [],
    tasks,
  };
}

export function normalizeWorkspaces(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const w of list.slice(0, WS_CAP)) {
    const ws = normalizeWorkspace(w);
    if (seen.has(ws.id)) continue;
    seen.add(ws.id);
    out.push(ws);
  }
  return out;
}

/** 这条会话归哪个工作区（第一个绑定了它的） */
export function workspaceForChat(workspaces, chatId) {
  const id = clean(chatId, 120);
  if (!id) return null;
  return (workspaces || []).find((w) => (w.chats || []).includes(id)) || null;
}

/** 绑定既可以是 chat_id，也可以是群名——管理页里人更容易填名字 */
export function workspaceFor(workspaces, chat = {}) {
  const id = clean(chat.chat_id, 120);
  const nm = clean(chat.name, 60);
  return (workspaces || []).find((w) => {
    const cs = w.chats || [];
    return (id && cs.includes(id)) || (nm && cs.includes(nm));
  }) || null;
}

/** 记一条任务；同一个 msg_id 只落一次，重复返回 null */
export function addTask(ws, msg = {}) {
  const title = clean(msg.title, 200);
  if (!ws || !title) return null;
  const src = msg.source && typeof msg.source === "object" ? msg.source : {};
  const msgId = clean(src.msg_id, 120);
  if (msgId && (ws.tasks || []).some((t) => t.source && t.source.msg_id === msgId)) return null;
  const task = normalizeTask({ ...msg, id: "", title, status: "todo", created_at: new Date().toISOString() });
  ws.tasks = [...(ws.tasks || []), task].slice(-TASK_CAP);
  return task;
}

export function setTaskStatus(ws, taskId, status) {
  const t = (ws?.tasks || []).find((x) => x.id === String(taskId || ""));
  if (!t) return null;
  t.status = TASK_STATUS.includes(status) ? status : t.status;
  t.updated_at = new Date().toISOString();
  return t;
}

export function removeTask(ws, taskId) {
  if (!ws) return 0;
  const before = (ws.tasks || []).length;
  ws.tasks = (ws.tasks || []).filter((t) => t.id !== String(taskId || ""));
  return before - ws.tasks.length;
}

export function addWorkspace(list, { name, chats } = {}) {
  const ws = normalizeWorkspace({ name: clean(name, 60) || "新工作区", chats: chats || [] });
  list.push(ws);
  return ws;
}

export function updateWorkspace(list, id, patch = {}) {
  const ws = (list || []).find((w) => w.id === String(id || ""));
  if (!ws) return null;
  if (patch.name !== undefined) ws.name = clean(patch.name, 60) || ws.name;
  if (patch.chats !== undefined) {
    ws.chats = Array.isArray(patch.chats) ? [...new Set(patch.chats.map((c) => clean(c, 120)).filter(Boolean))] : [];
  }
  return ws;
}

export function removeWorkspace(list, id) {
  const i = (list || []).findIndex((w) => w.id === String(id || ""));
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
}

export function stats(workspaces) {
  const out = { todo: 0, doing: 0, done: 0, total: 0 };
  for (const w of workspaces || []) {
    for (const t of w.tasks || []) {
      out.total++;
      if (t.status === "done") out.done++;
      else if (t.status === "doing") out.doing++;
      else out.todo++;
    }
  }
  return out;
}

/** 一句话讲清某个工作区现在在干什么（给工具输出用） */
export function describeWorkspace(ws) {
  const s = stats([ws]);
  const bound = (ws.chats || []).length ? (ws.chats || []).join("、") : "未绑定会话";
  return ws.name + "｜" + bound + "｜待办 " + s.todo + " · 进行 " + s.doing + " · 完成 " + s.done;
}
