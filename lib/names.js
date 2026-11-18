// 昵称名单：微信昵称（whoami）+ 全局 self.names + 每个群自己的 self.byChat[chat_id]
// 合并去重后交给 judge，由 judge 再剔除泛称与单字。
import { nickNames } from "./judge.js";

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

/**
 * @param self     config.self = { names: [], byChat: { chat_id: [名字...] } }
 * @param chat     { chat_id, name, kind }
 * @param whoName  whoami 拿到的微信昵称
 */
export function namesForChat(self = {}, chat = {}, whoName = "") {
  const byChat = (self && self.byChat) || {};
  const per = (chat && (byChat[chat.chat_id] || byChat[chat.name])) || [];
  const raw = [whoName, ...((self && self.names) || []), ...(Array.isArray(per) ? per : [])];
  return [...new Set(raw.map(clean).filter(Boolean))];
}

/** 真正能用来判断「在叫我」的部分：>=2 字、非泛称代词 */
export function usableNames(names = []) {
  return nickNames(names);
}

export function describeNames(names = []) {
  return names && names.length ? names.join(" / ") : "（未配置）";
}
