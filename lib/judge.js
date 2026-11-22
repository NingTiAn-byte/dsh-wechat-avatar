// 判定层：先规则，后模型。闸门由 policy 决定——
//   私聊默认 always：对方发来的一段话就当活（除非寒暄/回执）。
//   群聊默认 mention：没 @我 的一律不算，@了才算。
// 输出形状固定，上层直接落待办。

const ASSIGN_VERBS = [
  "帮", "帮忙", "麻烦", "辛苦", "汇总", "整理", "核对", "导出", "排查", "更新", "起草",
  "写一份", "出一份", "拉个", "发我", "给我", "跟进", "处理一下", "看下", "看一下", "弄一下",
];
const DIRECT_ADDRESS = /你(在|来|去|那边|负责|看|处理|整理|汇总|核对|跟进|弄|写|发|帮)/;
const DEADLINE = /(今天|今晚|明天|后天|本周|这周|下周|周[一二三四五六日天]|月底|月初|下班前|上班前|上午|中午|下午|晚上|\d{1,2}[点时](半)?)/;
const QUESTION = /[?？]|(吗|呢|怎么样|如何|能不能|可不可以|有没有|什么时候|啥时候)/;
const NOISE_TOKENS = ["收到", "好的", "好", "嗯", "ok", "OK", "已发", "已阅", "谢谢", "多谢", "感谢", "辛苦了", "辛苦", "在的", "👍", "1", "行", "可以", "没问题", "不客气", "早上好", "早", "中午好", "下午好", "晚上好", "晚安", "午安"];

/** 整条消息只由寒暄/回执碎片拼成 → 不算活（"好的谢谢" 这种也算） */
function isNoise(content) {
  let s = String(content || "").replace(/[\s。.!！,，~～?？:：]/g, "");
  if (!s) return true;
  for (let guard = 0; s && guard < 20; guard++) {
    const t = NOISE_TOKENS.find((x) => s.startsWith(x));
    if (!t) break;
    s = s.slice(t.length);
  }
  return s === "";
}
const TEAM_WORDS = /(你们|贵司|各位|大家)/;

// 「叫我」的昵称：≥2 字、不能是泛称代词（否则「我」「你」这种会把所有消息判成在叫我）
const GENERIC_NAMES = new Set(["我", "你", "他", "她", "它", "我们", "你们", "他们", "自己", "本人", "大家", "各位"]);
const CJK = /[\u4e00-\u9fa5]/;

export function nickNames(selfNames = []) {
  return (selfNames || [])
    .map((x) => clean(x))
    .filter((n) => n && n.length >= 2 && !GENERIC_NAMES.has(n));
}

/** 正文里直呼其名（不带 @ 的裸称呼）；拉丁名按词边界，避免 "Li" 命中 "List" */
function containsName(content, name) {
  if (!name) return false;
  const body = String(content || "");
  if (CJK.test(name)) return body.includes(name);
  const re = new RegExp("(^|[^a-z0-9])" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-z0-9]|$)", "i");
  return re.test(body);
}

const clamp = (v, lo = 0, hi = 0.95) => Math.max(lo, Math.min(hi, v));
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

function mentionedNames(content) {
  const out = [];
  const re = /@([^\s@，,。:：]+)/g;
  let m;
  while ((m = re.exec(content))) out.push(clean(m[1]));
  return out;
}

/**
 * @param msg  统一消息 {msg_id, sender_id, sender_name, content, ts_epoch}
 * @param opt  {selfId, selfNames[], chat:{chat_id,name,kind}, gate:"always"|"mention"|"off"}
 */
export function judge(msg, opt = {}) {
  const selfId = String(opt.selfId || "");
  const selfNames = (opt.selfNames || []).map((x) => clean(x)).filter(Boolean);
  const gate = opt.gate || (opt.chat?.kind === "dm" ? "always" : "mention");
  const content = clean(msg.content);
  const base = {
    gate,
    assigned: false, reply_needed: false, owner: msg.sender_name || "",
    task: "", deadline: "", confidence: 0, reason: "", evidence: {
      msg_id: String(msg.msg_id || ""), chat: opt.chat?.name || opt.chat?.chat_id || "",
      sender: msg.sender_name || "", text: content, ts: msg.ts_epoch || 0,
    },
  };

  if (gate === "off") return { ...base, reason: "该会话未开启值守" };
  if (!content) return { ...base, reason: "空消息" };
  // isSend=1 的消息一定是自己发的，不依赖 selfId 是否拿到
  if (msg.is_self === true) return { ...base, reason: "自己发的" };
  if (selfId && String(msg.sender_id) === selfId) return { ...base, reason: "自己发的" };
  if (isNoise(content)) return { ...base, reason: "寒暄/回执" };

  const ats = mentionedNames(content).concat(
    Array.isArray(msg.mentions) ? msg.mentions.map((x) => clean(typeof x === "string" ? x : x?.name)) : []
  );
  const atMe = ats.some((n) => (selfId && n === selfId) || selfNames.includes(n));
  const atOthers = ats.filter((n) => !((selfId && n === selfId) || selfNames.includes(n)));

  // 群里不用 @，直接喊名字（"雷哥，帮我看下…"）也算叫我——可用 opt.nick=false 关掉
  const nickName = opt.nick === false ? "" : nickNames(selfNames).find((n) => containsName(content, n)) || "";

  const verb = ASSIGN_VERBS.find((v) => content.includes(v)) || "";
  const direct = DIRECT_ADDRESS.test(content);
  const team = TEAM_WORDS.test(content);
  const dl = content.match(DEADLINE)?.[0] || "";
  const ask = QUESTION.test(content);
  const task = content.replace(/^@[^\s]+\s*/, "").slice(0, 140);

  // 群聊里明确 @ 了别人、没 @ 我 —— 不是我的活
  if (gate === "mention" && !atMe && !nickName && atOthers.length) {
    return { ...base, reason: "对话对象是 " + atOthers.join("/"), confidence: 0.1 };
  }

  let conf = 0;
  let assigned = false;
  if (gate === "always") {
    assigned = true;                       // 私聊：不看 @，发了就算
    conf = 0.7 + (verb ? 0.1 : 0) + (dl ? 0.1 : 0) + (atMe ? 0.05 : 0);
  } else {
    // 群聊：@我 或 直接喊我昵称，二者之一就算叫我
    assigned = atMe || !!nickName;
    conf = atMe
      ? 0.8 + (verb ? 0.1 : 0) + (dl ? 0.05 : 0)
      : nickName
        ? 0.76 + (verb ? 0.1 : 0) + (dl ? 0.05 : 0)
        : 0.2 + (verb ? 0.15 : 0) + (direct ? 0.2 : 0) + (dl ? 0.1 : 0) + (ask ? 0.05 : 0);
  }

  const replyNeeded = !assigned && ask && (atMe || nickName || team || direct);

  const reasons = [
    gate === "always" && (opt.chat?.kind === "dm" ? "私聊" : "该会话设为不设门槛"),
    atMe && "被 @",
    !atMe && nickName && "被叫到「" + nickName + "」",
    direct && "直接称你",
    verb && "派活动词「" + verb + "」",
    dl && "期限「" + dl + "」",
    ask && "疑问句",
  ].filter(Boolean);

  return {
    ...base,
    assigned,
    reply_needed: replyNeeded,
    task: assigned || replyNeeded ? task : "",
    deadline: dl,
    confidence: Number(clamp(conf).toFixed(2)),
    reason: assigned
      ? "命中：" + reasons.join(" + ")
      : replyNeeded
        ? "有人在等回话：" + reasons.join(" + ")
        : gate === "mention"
          ? "群聊未 @我，不派活"
          : "未命中派活条件",
  };
}

export function judgeAll(messages, opt = {}) {
  return messages.map((m) => ({ ...judge(m, opt), chat_id: opt.chat?.chat_id || "" }));
}
