// 工作记录 / 知识库：每个群一个 Markdown 文件，索引放在 knowledge/index.json。
// 只落「这个群派过什么活、当时怎么说的、最后怎么回的」，给下次派活时当上下文用。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
let DIR = process.env.WECHAT_AVATAR_KB_DIR || path.join(ROOT, "knowledge");
const MAX_ENTRIES = 2000;

const clean = (v, n = 400) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);

export function kbDir() {
  return DIR;
}

/** 测试用：换一个目录，别往仓库里写 */
export function setKbDir(dir) {
  DIR = String(dir || "").trim() || DIR;
}

const indexPath = () => path.join(DIR, "index.json");

function ensure() {
  fs.mkdirSync(DIR, { recursive: true });
}

export function loadIndex() {
  try {
    const j = JSON.parse(fs.readFileSync(indexPath(), "utf8"));
    return { version: 1, entries: Array.isArray(j.entries) ? j.entries : [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

export function saveIndex(idx) {
  ensure();
  const entries = (idx.entries || []).slice(-MAX_ENTRIES);
  fs.writeFileSync(indexPath(), JSON.stringify({ version: 1, entries }, null, 2), "utf8");
  return entries.length;
}

function fileNameOf(chat) {
  const name = clean(chat, 60) || "未命名";
  return name.replace(/[\\/:*?"<>|]/g, "_") + ".md";
}

// 把这个会话的所有记录重写成一份 Markdown（条目不多，整写最省心）
export function writeChatFile(idx, chatName) {
  ensure();
  const rows = (idx.entries || [])
    .filter((e) => e.chat === chatName)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const lines = [`# ${chatName}`, "", `共 ${rows.length} 条记录，最后更新 ${new Date().toISOString()}`, ""];
  for (const e of rows) {
    lines.push(`## ${String(e.created_at || "").slice(0, 16).replace("T", " ")} · ${clean(e.title, 120) || "(没写标题)"}`);
    lines.push("");
    lines.push(`- 谁派的：${clean(e.sender, 40) || "未知"}`);
    lines.push(`- 状态：${e.status || "todo"}${e.session_id ? ` · 会话 ${clean(e.session_id, 60)}` : ""}`);
    if (e.need) lines.push(`- 原话：${clean(e.need, 600)}`);
    if (e.reply) lines.push(`- 回执：${clean(e.reply, 1200)}`);
    if (Array.isArray(e.tags) && e.tags.length) lines.push(`- 标签：${e.tags.map((t) => clean(t, 20)).join("、")}`);
    lines.push("");
  }
  const file = path.join(DIR, fileNameOf(chatName));
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  return file;
}

// 建一条或更新一条（按 task_id 去重）；返回最新条目
export function record(info = {}) {
  if (!info || !info.task_id) return null;
  ensure();
  const idx = loadIndex();
  const now = new Date().toISOString();
  const prev = idx.entries.find((e) => String(e.task_id) === String(info.task_id));
  const chat = clean(info.chat, 60) || (prev && prev.chat) || "未知";
  const entry = {
    ...(prev || {}),
    task_id: String(info.task_id),
    created_at: (prev && prev.created_at) || now,
    updated_at: now,
    chat,
    chat_id: clean(info.chat_id, 120) || (prev && prev.chat_id) || "",
    sender: clean(info.sender, 40) || (prev && prev.sender) || "",
    title: clean(info.title, 200) || (prev && prev.title) || "",
    need: clean(info.need, 600) || (prev && prev.need) || "",
    status: clean(info.status, 20) || (prev && prev.status) || "todo",
    session_id: clean(info.session_id, 80) || (prev && prev.session_id) || "",
    reply: clean(info.reply, 1200) || (prev && prev.reply) || "",
    tags: Array.isArray(info.tags) ? info.tags.slice(0, 8) : (prev && prev.tags) || [],
  };
  if (prev) Object.assign(prev, entry);
  else idx.entries.push(entry);
  saveIndex(idx);
  writeChatFile(idx, chat);
  return entry;
}

// 检索：关键词按空格拆，全部命中才算；可按群过滤
export function search(q = "", opts = {}) {
  const idx = loadIndex();
  const words = clean(q, 200).toLowerCase().split(/\s+/).filter(Boolean);
  const chat = clean(opts.chat, 60);
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 10));
  const hits = [];
  for (const e of idx.entries.slice().reverse()) {
    if (chat && e.chat !== chat) continue;
    const hay = [e.title, e.need, e.reply, e.chat, e.sender, (e.tags || []).join(" ")].join(" ").toLowerCase();
    if (words.length && !words.every((w) => hay.includes(w))) continue;
    hits.push(e);
    if (hits.length >= limit) break;
  }
  return hits;
}

export function recentForChat(chatIdOrName, n = 5) {
  const idx = loadIndex();
  const key = clean(chatIdOrName, 120);
  if (!key) return [];
  return idx.entries
    .filter((e) => e.chat_id === key || e.chat === key)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, Math.max(1, Math.min(20, Number(n) || 5)));
}

export function stats() {
  const idx = loadIndex();
  const chats = new Set(idx.entries.map((e) => e.chat));
  return { entries: idx.entries.length, chats: chats.size, dir: DIR };
}
