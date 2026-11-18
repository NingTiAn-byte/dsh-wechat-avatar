// 判定闸门：一个会话是"私聊"还是"群"，决定要不要 @ 才认。
import { DEFAULT_CONFIG } from "./config.js";

const DM_GATE = { always: "always", mention: "mention", off: "off" };
const GROUP_GATE = { always: "always", mention_only: "mention", mention: "mention", off: "off" };

export function chatKind(chat) {
  const k = String(chat?.kind || "").toLowerCase();
  if (k === "dm" || k === "single" || k === "private" || k === "friend") return "dm";
  if (k === "group" || k === "chatroom" || k === "many") return "group";
  return "group"; // 拿不准就按群处理：宁可少干，别擅自答应
}

/**
 * @returns "always"（消息即任务）| "mention"（必须 @我）| "off"（不值守）
 */
export function gateOf(chat, policy = DEFAULT_CONFIG.policy) {
  const id = String(chat?.chat_id || "");
  const ov = policy?.overrides?.[id];
  if (ov === "off" || ov === "always" || ov === "mention") return ov;
  if (ov === "mention_only") return "mention";
  const kind = chatKind(chat);
  const raw = kind === "dm" ? policy?.dm : policy?.group;
  const table = kind === "dm" ? DM_GATE : GROUP_GATE;
  return table[String(raw || "").toLowerCase()] ?? (kind === "dm" ? "always" : "mention");
}
