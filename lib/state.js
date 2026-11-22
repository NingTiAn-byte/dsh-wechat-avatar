// 检查点：按会话记录"已经看过的消息"，落盘到 ~/.wechat-standin/state.json。
// 断点续跑、去重都靠它；seen 只保留最近 500 条，避免文件无限膨胀。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 装进 DSH 后可改成 ~/.wechat-standin；demo 阶段放仓库内，免得往家目录写（本机家目录只读）
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_DIR = process.env.WECHAT_STANDIN_DIR || path.join(ROOT, ".state");
const SEEN_CAP = 500;

export function statePath(dir = DEFAULT_DIR) {
  return path.join(dir, "state.json");
}

export function loadState(dir = DEFAULT_DIR) {
  const empty = { version: 1, chats: {}, decisions: [], sessions: {} };
  try {
    const raw = fs.readFileSync(statePath(dir), "utf8");
    const j = JSON.parse(raw);
    return { ...empty, ...j, chats: j.chats || {}, decisions: j.decisions || [], sessions: j.sessions || {} };
  } catch {
    return empty;
  }
}

export function saveState(s, dir = DEFAULT_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath(dir), JSON.stringify(s, null, 2));
  return statePath(dir);
}

/** 拿到该会话的游标，没有就初始化 */
export function chatCursor(s, chatId) {
  const id = String(chatId);
  if (!s.chats[id]) s.chats[id] = { last_epoch: 0, seen: [] };
  return s.chats[id];
}

/** 只看没见过的；返回 fresh 列表并同步写入检查点 */
export function takeFresh(s, chatId, messages) {
  const cur = chatCursor(s, chatId);
  const seen = new Set(cur.seen);
  const fresh = [];
  for (const m of messages) {
    if (!m || !m.msg_id || seen.has(m.msg_id)) continue;
    seen.add(m.msg_id);
    fresh.push(m);
  }
  cur.seen = [...seen].slice(-SEEN_CAP);
  const maxEpoch = messages.reduce((a, m) => Math.max(a, Number(m.ts_epoch) || 0), cur.last_epoch || 0);
  cur.last_epoch = maxEpoch;
  return fresh;
}

/** 群 → 会话：同一个群有多条任务时接着用同一个会话 */
export function getChatSession(s, chatId) {
  const id = String(chatId || "");
  return (s.sessions || {})[id] || null;
}

export function setChatSession(s, chatId, info = {}) {
  const id = String(chatId || "");
  if (!id) return null;
  s.sessions = { ...(s.sessions || {}), [id]: { ...info, updated_at: info.updated_at || new Date().toISOString() } };
  return s.sessions[id];
}

export function dropChatSession(s, chatId) {
  const id = String(chatId || "");
  if (s.sessions) delete s.sessions[id];
  return s.sessions || {};
}

export function recordDecision(s, decision) {
  s.decisions = [...(s.decisions || []), decision].slice(-200);
}
