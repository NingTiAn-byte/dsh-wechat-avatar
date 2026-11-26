// AI 复核：规则先判一遍，把「像活」的消息连同会话上下文交给 DSH 里的 agent 再看一眼。
// 只用一段纯文本 prompt，要求回 JSON；解析失败就当没判过，不阻断规则结果。

export const AI_TIMEOUT_MS = 120000;

function clip(text, n) {
  const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/** 把一条消息前后的一小段对话压成几行，让模型能看见「谁在跟谁说话」 */
export function transcriptOf(messages = [], selfId = "", chat = {}, limit = 12) {
  const rows = [];
  for (const m of messages.slice(-limit)) {
    const who = m.is_self || (selfId && String(m.sender_id) === selfId) ? "我" : (m.sender_name || m.sender_id || "对方");
    const text = clip(m.content, 120);
    if (text) rows.push("  " + who + "：" + text);
  }
  return { chat: chat.name || chat.chat_id || "", kind: chat.kind === "dm" ? "私聊" : "群聊", rows };
}

/** 一条待复核的消息（id 只在本轮有意义） */
export function entryOf(id, msg, chat, ctx, taskId = "") {
  return {
    id,
    task_id: String(taskId || ""),
    chat_id: String(chat.chat_id || ""),
    chat: String(chat.name || chat.chat_id || ""),
    kind: chat.kind === "dm" ? "私聊" : "群聊",
    sender: String(msg.sender_name || msg.sender_id || ""),
    text: clip(msg.content, 400),
    ts: Number(msg.ts_epoch || msg.createTime * 1000 || 0),
    transcript: ctx,
  };
}

/** 拼给 agent 的判定请求：一批里面可能混着几个会话的消息 */
export function buildPrompt(entries = [], opt = {}) {
  const self = opt.selfName ? `${opt.selfName}（${opt.selfId || "我"}）` : (opt.selfId || "我");
  const blocks = entries.map((e, i) => {
    const ctx = e.transcript && e.transcript.rows && e.transcript.rows.length
      ? `\n最近对话（最后一行是要判定的这条）：\n${e.transcript.rows.join("\n")}`
      : "";
    const type = e.work_kind === "info" ? "问答案" : "派活";
    return `[${i + 1}] id=${e.id}\n会话：${e.chat || "(未知)"}（${e.kind}）\n发送人：${e.sender || "对方"}${ctx}\n类型：${type}\n待判定：${e.text}`;
  });
  return [
    `你在帮一个微信值守插件判断：下面 ${entries.length} 条消息里，哪些是「派给我（${self}）的活」。`,
    "",
    "判定标准：",
    "- 是活：明确要求我做某事——做事、看东西、确认、安排、交付、给结论、改东西；哪怕语气客气。",
    "- 不是活：寒暄、表情、闲聊、通知/公告、别人之间对话、对我已经回复的确认（如「好的」「收到」）、纯陈述。",
    "- 群聊里如果明确 @ 了别人、没叫我，不算我的活。",
    "- 拿不准就给出较低 confidence，并倾向 false。",
    ...(opt.avoid && opt.avoid.length ? ["", "下面这些是本人已经明确否掉过的消息（不是活），形似的也别再算，直接给 false：", ...opt.avoid.map((t) => "- " + t)] : []),
    "- 标着「问答案」的条目：对方在问一个东西，请从上下文判断他问的是什么，给出可以直接发回去的答案（简洁、说人话、别客套）。基于已知信息回答；真不知道就写「这个我这边没记录，我确认一下再回你」。",
    "",
    "对每条输出一个对象，严格按这个形状：",
    '{"id":"条目里的 id","is_work":true/false,"title":"要做什么，不超过30字，不是活就留空","deadline":"有就写，没有留空","confidence":0到1,"reason":"一句话理由","answer":"仅当类型是问答案时填：可以直接发回去的回复，不超过300字"}',
    "",
    "只输出一个 JSON 数组，不要解释、不要代码块、不要多余文字。",
    "",
    "条目：",
    ...blocks,
  ].join("\n");
}

/** 从模型的回复里抠出 JSON 数组；带代码块、带前后废话都能忍 */
export function parseVerdicts(text) {
  const raw = String(text || "");
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return { ok: false, error: "没找到 JSON 数组", items: [] };
  let arr;
  try {
    arr = JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    return { ok: false, error: "JSON 解析失败：" + ((e && e.message) || e), items: [] };
  }
  if (!Array.isArray(arr)) return { ok: false, error: "不是一个数组", items: [] };
  const items = [];
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const id = String(it.id || "").trim();
    if (!id) continue;
    const conf = Number(it.confidence);
    items.push({
      id,
      is_work: it.is_work === true,
      title: clip(it.title || "", 40),
      deadline: clip(it.deadline || "", 20),
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
      reason: clip(it.reason || "", 80),
      answer: clip(it.answer || "", 600),
    });
  }
  if (!items.length) return { ok: false, error: "数组里没有可用的条目", items: [] };
  return { ok: true, items };
}

/** 等会话这一轮说完，最多等 timeoutMs；中途会话被关掉就返回错误 */
export async function waitReply(handoffCtx, sessionId, opt = {}) {
  const { readSessionReply } = opt.reader || {};
  const timeoutMs = Math.max(1000, Number(opt.timeoutMs) || AI_TIMEOUT_MS);
  const pollMs = Math.max(200, Number(opt.pollMs) || 1500);
  const sleep = opt.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const r = await readSessionReply(handoffCtx, sessionId);
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || "读不到会话" };
    if (r.ended && r.text) return { ok: true, text: r.text };
    last = r.text || last;
    await sleep(pollMs);
  }
  return { ok: false, error: "等超时了", text: last };
}
