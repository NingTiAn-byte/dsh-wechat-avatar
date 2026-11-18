// 平台层（对应 cyber-im-avatar 的 lib/im.js）：只接微信，数据源是 weflow-cli 的拉取式接口。
// 注意：本机没装 weflow-cli，命令模板与字段名都未在真机验证，字段用候选列表兜底。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MOCK_CHATS, MOCK_MESSAGES, MOCK_SELF } from "./mock.js";

const execFileP = promisify(execFile);

export const PLATFORM = "wechat";

export const DEFAULTS = {
  cli: "weflow-cli",
  timeoutSec: 60,
  cmdList: ["sync", "list", "--json"],
  cmdFetch: ["sync", "run", "{chat}", "--since", "{since}", "--json"],
  cmdSend: ["send", "{chat}", "{text}"],
};

export function parseTs(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) { const n = Number(s); return n > 1e12 ? n : n * 1000; }
  const t = Date.parse(s.replace(" ", "T"));
  return Number.isFinite(t) ? t : 0;
}

function pick(obj, keys) {
  for (const k of keys) {
    const v = k.split(".").reduce((a, p) => (a == null ? a : a[p]), obj);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

export function normalize(raw, chatId = "") {
  const id = pick(raw, ["localId", "local_id", "serverId", "server_id", "msgId", "msg_id", "id"]);
  if (!id) return null;
  const content = pick(raw, ["content", "text", "body", "msg", "plainText"]) || "";
  const ts = pick(raw, ["createTime", "create_time", "timestamp", "ts", "time", "date"]);
  return {
    msg_id: String(id),
    chat_id: String(pick(raw, ["chatId", "chat_id", "talker", "sessionId"]) || chatId),
    sender_id: String(pick(raw, ["sender", "senderId", "fromUser", "from", "wxid", "username"]) || ""),
    sender_name: String(pick(raw, ["senderName", "sender_name", "displayName", "remark", "nickname", "name"]) || ""),
    content: String(content),
    msg_type: String(pick(raw, ["type", "msgType", "msg_type"]) || "text").toLowerCase(),
    mentions: [],
    ts: String(ts ?? ""),
    ts_epoch: parseTs(ts),
  };
}

export class WeChatAdapter {
  constructor({ cli = DEFAULTS.cli, mock = false, timeoutSec = DEFAULTS.timeoutSec, selfId = "", selfNames = [] } = {}) {
    this.platform = PLATFORM;
    this.cli = cli;
    this.mock = mock;
    this.timeoutSec = timeoutSec;
    this.selfId = selfId;
    this.selfNames = selfNames;
  }

  get canMention() { return true; }
  get supportsMembers() { return false; }

  async run(args, timeout = this.timeoutSec) {
    try {
      const r = await execFileP(this.cli, args, { timeout: timeout * 1000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
      const raw = String(r.stdout || "").trim();
      try { return { rc: 0, json: JSON.parse(raw), raw }; } catch { return { rc: 0, json: null, raw }; }
    } catch (e) {
      return { rc: typeof e.code === "number" ? e.code : 127, json: null, raw: String(e.stdout || e.message || "").slice(0, 600) };
    }
  }

  async whoami() {
    if (this.mock) return { ok: true, self_id: MOCK_SELF.self_id, self_name: MOCK_SELF.self_name, mock: true };
    const r = await this.run(["whoami", "--json"]);
    if (!r.json) return { ok: false, error: r.raw || "whoami 无输出" };
    return {
      ok: true,
      self_id: String(pick(r.json, ["wxid", "selfId", "self_id", "id"]) || this.selfId),
      self_name: String(pick(r.json, ["nickname", "name", "displayName"]) || ""),
    };
  }

  async listChats(limit = 20) {
    if (this.mock) return { ok: true, items: MOCK_CHATS.slice(0, limit) };
    const r = await this.run(DEFAULTS.cmdList);
    if (!r.json) return { ok: false, items: [], error: r.raw || "会话列表无输出（该版本可能不支持 list）" };
    const arr = Array.isArray(r.json) ? r.json : (r.json.chats || r.json.items || []);
    const items = arr.slice(0, limit).map((c) => {
      const rawKind = pick(c, ["kind", "chatType", "chat_type", "type"]);
      const isGroup = pick(c, ["isGroup", "is_group", "isChatRoom"]);
      const kind = isGroup === true || /group|chatroom|群/i.test(String(rawKind || "")) ? "group" : "dm";
      return {
        chat_id: String(pick(c, ["chatId", "chat_id", "id", "talker"]) || ""),
        name: String(pick(c, ["name", "displayName", "nickname", "remark"]) || ""),
        kind,
        member_count: Number(pick(c, ["memberCount", "member_count"]) || 0),
      };
    }).filter((c) => c.chat_id);
    return { ok: true, items };
  }

  async fetchMessages(chatId, { limit = 30, since = "" } = {}) {
    if (this.mock) {
      const rows = MOCK_MESSAGES[chatId] || [];
      return { ok: true, messages: rows.map((r) => normalize(r, chatId)).filter(Boolean) };
    }
    const args = DEFAULTS.cmdFetch.map((a) => a.replace("{chat}", String(chatId)).replace("{since}", String(since)));
    const r = await this.run(args);
    if (!r.json) return { ok: false, messages: [], error: r.raw || "拉消息无 JSON 输出" };
    const arr = Array.isArray(r.json) ? r.json : (r.json.messages || r.json.items || r.json.data || []);
    const messages = arr.map((x) => normalize(x, chatId)).filter(Boolean)
      .sort((a, b) => a.ts_epoch - b.ts_epoch).slice(-limit);
    return { ok: true, messages };
  }

  async chatMembers() {
    return { ok: false, items: [], error: "weflow 不提供成员列表，@判定只能用正文名字" };
  }

  async sendText(chatId, text, { dryRun = true } = {}) {
    if (dryRun) return { ok: true, dry_run: true, chat_id: chatId, text };
    if (this.mock) return { ok: true, dry_run: true, chat_id: chatId, text };
    const args = DEFAULTS.cmdSend.map((a) => a.replace("{chat}", String(chatId)).replace("{text}", text));
    const r = await this.run(args);
    return { ok: r.rc === 0, raw: r.raw };
  }
}

export class IM {
  constructor(opts = {}) { this.adapter_ = new WeChatAdapter(opts); }
  adapter(_platform = PLATFORM) { return this.adapter_; }
  cliPath(_platform = PLATFORM) { return this.adapter_.cli; }
}
