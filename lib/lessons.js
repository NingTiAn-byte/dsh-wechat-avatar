// 删除任务的否例：你在面板上删掉的任务记在这里。
// 之后扫描到形似的消息直接跳过，AI 复核也会被告知「这些已经被否过」。
import { loadState, saveState } from "./state.js";

const MAX = 200;

/** 去掉空白和标点，只留正文，用来比相似度 */
export function norm(text) {
  return String(text || "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/** 两条消息像不像：完全相同 / 一条包住另一条（够长）/ 二元组重合度 ≥ 0.6 */
export function similar(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const short = x.length <= y.length ? x : y;
  const long = short === x ? y : x;
  if (short.length >= 8 && long.indexOf(short) >= 0) return true;
  if (x.length < 4 || y.length < 4) return false;
  const A = bigrams(x);
  const B = bigrams(y);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  const union = A.size + B.size - inter;
  return union > 0 && inter / union >= 0.6;
}

export function all(dir) {
  const st = loadState(dir);
  return Array.isArray(st.lessons) ? st.lessons : [];
}

/** 记一条否例；已有形似的就只更新时间和命中次数 */
export function add(entry = {}, dir) {
  const text = String(entry.text || "").trim();
  if (!text) return null;
  const st = loadState(dir);
  st.lessons = Array.isArray(st.lessons) ? st.lessons : [];
  const chat_id = String(entry.chat_id || "");
  const exist = st.lessons.find((l) => String(l.chat_id || "") === chat_id && similar(l.text, text));
  if (exist) {
    exist.at = new Date().toISOString();
    exist.hits = (Number(exist.hits) || 1) + 1;
    saveState(st, dir);
    return exist;
  }
  const rec = {
    text: text.slice(0, 300),
    chat_id,
    chat: String(entry.chat || ""),
    sender: String(entry.sender || ""),
    kind: String(entry.kind || ""),
    at: new Date().toISOString(),
    hits: 1,
  };
  st.lessons.unshift(rec);
  if (st.lessons.length > MAX) st.lessons.length = MAX;
  saveState(st, dir);
  return rec;
}

/** 这条消息是不是以前被否掉过的同类 */
export function hit(chat_id, text, dir) {
  const t = String(text || "");
  if (!t) return null;
  for (const l of all(dir)) {
    if (chat_id && l.chat_id && String(l.chat_id) !== String(chat_id)) continue;
    if (similar(l.text, t)) return l;
  }
  return null;
}
