// 平台层（对应 cyber-im-avatar 的 lib/im.js）：只接微信，数据源是 weflow-cli 的拉取式接口。
//
// 命令与字段对着 weflow-cli@1.21.17 的发布包源码核对过（bin/weflow-cli.ts 的 sessions / messages 两条命令），
// 不是照文档猜的：
//   sessions --json
//     -> { success: true, sessions: [{ username, displayName, type, summary, lastTimestamp }] }
//   messages <talker> --json --non-interactive -n N -s <unix秒>
//     -> { success: true, talker, messages: [{ localId, serverId, createTime, isSend, senderUsername, parsedContent, rawContent, localType }] }
// 失败时两条命令都是 { success: false, code, failure: { message, next } } + 退出码 1 —— JSON 照样打在 stdout 上，
// 所以 run() 在非 0 退出时也要解析 stdout，否则「读不出来」会被说成「没有数据」。
//
// 仍然是拉取式：weflow 没有推送通道，只能定时轮询。没有 whoami；send 有，但要白名单 + --yes。

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { MOCK_CHATS, MOCK_MESSAGES, MOCK_SELF } from "./mock.js";

const execFileP = promisify(execFile);

export const PLATFORM = "wechat";

export const DEFAULTS = {
  cli: process.env.WEFLOW_CLI || "weflow-cli",
  timeoutSec: 60,
  // -n 上限 1000，超了 weflow 自己报 INVALID_ARGUMENT
  cmdList: ["sessions", "--json", "-n", "{limit}"],
  // -s 吃 Unix 秒（不是 ISO）；--non-interactive 让「名字撞上多个会话」直接报错，别卡在交互选择上
  cmdFetch: ["messages", "{chat}", "--json", "--non-interactive", "-n", "{limit}", "-s", "{sinceEpoch}"],
  // 没有 whoami；只有 config show 的文本里带一行「微信账号: wxid_xxx」（--json 反而把这行脱敏掉）
  cmdSelf: ["config", "show"],
  // send：目标必须在 weflow 白名单里，--dry-run 只是预览，--yes 才真发；本适配层只在 confirm===true 时传 --yes
  cmdSend: ["send", "{chat}", "{text}", "{mode}", "--json"],
  // 通讯录：只用来查「我自己叫什么」。config show 不给昵称，sessions/messages 里的 displayName 全是别人的。
  cmdContacts: ["contacts", "--json", "-n", "{limit}"],
};

const ANSI = /\u001b\[[0-9;]*m/g;
export const stripAnsi = (s) => String(s ?? "").replace(ANSI, "");

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

/** weflow 的 { success:false, code, failure:{ message, next } } 拆成一句人话 */
export function failText(j) {
  const f = (j && j.failure) || {};
  const parts = [j && j.error, f.message, f.next, j && j.code].filter(Boolean);
  return parts.length ? parts.join(" / ") : "weflow 返回 success:false（没给原因）";
}

/** 群聊的判据只有 @chatroom：weflow 的 type 字段各后端语义不一致，不拿来当准绳 */
export const isRoomId = (username, kind) =>
  /@chatroom/i.test(String(username || "")) || /group|chatroom|群/i.test(String(kind ?? ""));

export function normalize(raw, chatId = "") {
  const id = pick(raw, ["localId", "local_id", "serverId", "server_id", "msgId", "msg_id", "id"]);
  if (id === undefined || id === "") return null;
  const isSelf = Number(pick(raw, ["isSend", "is_send"]) ?? 0) === 1;
  // wxid 和显示名是两个字段：weflow 用 senderUsername / senderDisplay，示例数据用 sender / sender_name
  const senderId = pick(raw, ["senderUsername", "sender_id", "sender", "senderId", "fromUser", "from", "wxid", "username"]);
  const senderName = pick(raw, ["senderDisplay", "senderDisplayName", "sender_name", "senderName", "displayName", "remark", "nickname", "name"]);
  const ts = pick(raw, ["createTime", "create_time", "timestamp", "ts", "time", "date"]);
  return {
    msg_id: String(id),
    chat_id: String(pick(raw, ["chatId", "chat_id", "talker", "sessionId"]) || chatId),
    sender_id: String(senderId ?? ""),
    sender_name: String(senderName ?? senderId ?? ""),
    content: String(pick(raw, ["parsedContent", "rawContent", "content", "text", "body", "msg"]) ?? ""),
    msg_type: String(pick(raw, ["localType", "local_type", "msgType", "msg_type", "type"]) ?? "text").toLowerCase(),
    mentions: [],
    ts: String(ts ?? ""),
    ts_epoch: parseTs(ts),
    is_self: isSelf,
  };
}

export class WeChatAdapter {
  constructor({
    cli = DEFAULTS.cli,
    mock = false,
    timeoutSec = DEFAULTS.timeoutSec,
    selfId = "",
    selfNames = [],
    cmdList = DEFAULTS.cmdList,
    cmdFetch = DEFAULTS.cmdFetch,
    cmdSelf = DEFAULTS.cmdSelf,
    cmdSend = DEFAULTS.cmdSend,
    cmdContacts = DEFAULTS.cmdContacts,
  } = {}) {
    this.platform = PLATFORM;
    this.cli = cli;
    this.mock = mock;
    this.timeoutSec = timeoutSec;
    this.selfId = selfId;
    this.selfNames = selfNames;
    this.cmdList = cmdList;
    this.cmdFetch = cmdFetch;
    this.cmdSelf = cmdSelf;
    this.cmdSend = cmdSend;
    this.cmdContacts = cmdContacts;
  }

  get canMention() { return true; }
  get supportsMembers() { return false; }

  /** 把 {chat}/{limit}/{sinceEpoch} 填进模板；没值的可选参数（如没给 since 时的 -s）连名带值一起丢掉 */
  fill(tpl, vars = {}) {
    const filled = tpl.map((t) => String(t).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k] ?? "") : m)));
    const args = [];
    for (let i = 0; i < filled.length; i++) {
      const cur = filled[i];
      if (cur === "") continue;
      if (/^-/.test(cur) && (filled[i + 1] === undefined || filled[i + 1] === "")) continue;
      args.push(cur);
    }
    return args;
  }

  /**
   * Windows 上传 npm -g 装的是 .cmd 垫片，execFile 直接跑 "weflow-cli" 会 ENOENT（假的「没装」）。
   * 翻出垫片里真正的 JS 入口，用当前 node 跑它——不走 shell，免得聊天文本里的引号/& 被 cmd 吃掉。
   */
  /**
   * 真正拿来跑 CLI 的 node：装了 node.exe 就用它。
   * DSH 宿主是 Electron 打包的，process.execPath 是 'DeepSeek Harness.exe'——
   * 拿它跑 cli.cjs 会把脚本路径当成子命令（unknown command '...cli.cjs'），所以必须另找 node。
   */
  nodeBin() {
    if (this._node) return this._node;
    let bin = process.execPath;
    if (process.versions && process.versions.electron) {
      try {
        const hits = execFileSync("where.exe", ["node.exe"], { encoding: "utf8" }).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        const real = hits.find((p) => /node\.exe$/i.test(p) && fs.existsSync(p));
        if (real) bin = real;
      } catch {
        /* 没装 node.exe 就退回 execPath + ELECTRON_RUN_AS_NODE */
      }
    }
    this._node = bin;
    return bin;
  }

  resolveCli() {
    if (this._resolved) return this._resolved;
    const c = this.cli;
    const asJs = (js) => ({ file: this.nodeBin(), pre: [js] });
    this._resolved = { file: c, pre: [] };
    if (/\.(c?m?js)$/i.test(c) && fs.existsSync(c)) { this._resolved = asJs(c); return this._resolved; }
    if (process.platform !== "win32" || path.isAbsolute(c)) return this._resolved;
    try {
      const shims = execFileSync("where.exe", [c], { encoding: "utf8" }).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      for (const shim of shims) {
        const m = /([^\s"']*node_modules[^\s"']*\.(?:c?m?js))(?![\w.])/.exec(fs.readFileSync(shim, "utf8"));
        if (!m) continue;
        const js = m[1].replace(/%[~]?dp0%|\$basedir|%dp0%/gi, path.dirname(shim));
        if (fs.existsSync(js)) { this._resolved = asJs(js); return this._resolved; }
      }
    } catch { /* 没装就保持原样，run() 会报 missing */ }
    return this._resolved;
  }

  async run(args, timeout = this.timeoutSec) {
    let out = "";
    let rc = 0;
    let missing = false;
    const { file, pre } = this.resolveCli();
    try {
      const env = { ...process.env };
      if (process.versions && process.versions.electron && file === process.execPath) env.ELECTRON_RUN_AS_NODE = "1";
      const r = await execFileP(file, [...pre, ...args], { timeout: timeout * 1000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env });
      out = r.stdout;
    } catch (e) {
      // 非 0 退出也要看 stdout：weflow 的失败 JSON 就印在那儿
      out = e && e.stdout !== undefined && e.stdout !== "" ? e.stdout : (e && e.message) || "";
      rc = e && typeof e.code === "number" ? e.code : 127;
      missing = !!e && e.code === "ENOENT";
    }
    const raw = stripAnsi(out).trim();
    try { return { rc, json: JSON.parse(raw), raw, missing }; } catch { return { rc, json: null, raw, missing }; }
  }

  /** 昵称只能从通讯录里翻：config show 不给自己那一行，sessions/messages 里的 displayName 都是别人 */
  async selfNameOf(selfId) {
    if (!selfId) return "";
    const r = await this.run(this.fill(this.cmdContacts, { limit: "5000" }), Math.min(this.timeoutSec, 30));
    const arr = Array.isArray(r.json && r.json.contacts) ? r.json.contacts : [];
    const me = arr.find((c) => String((c && c.username) || "") === selfId);
    return me ? String(me.displayName || me.remark || me.nickname || "") : "";
  }

  async whoami() {
    if (this.mock) return { ok: true, self_id: MOCK_SELF.self_id, self_name: MOCK_SELF.self_name, mock: true };
    const r = await this.run(this.cmdSelf, Math.min(this.timeoutSec, 20));
    if (r.missing) return { ok: false, error: `跑不起来 ${this.cli}：没装或者不在 PATH 上（npm i -g weflow-cli）` };
    const m = /微信账号[:：]\s*([A-Za-z0-9_@.\-]+)/.exec(r.raw);
    if (!m) {
      return {
        ok: false,
        error: r.raw ? `config show 里没找到账号：${r.raw.slice(0, 160)}` : `跑不起来 ${this.cli}，装了吗？（npm i -g weflow-cli）`,
      };
    }
    const selfId = m[1];
    const selfName = await this.selfNameOf(selfId);
    return {
      ok: true,
      self_id: selfId,
      self_name: selfName,
      ...(selfName ? {} : { note: "通讯录里没查到自己的昵称，称呼写进 config.json 的 self.names" }),
    };
  }

  async listChats(limit = 20) {
    if (this.mock) return { ok: true, items: MOCK_CHATS.slice(0, limit) };
    const r = await this.run(this.fill(this.cmdList, { limit: String(limit) }));
    if (r.missing) return { ok: false, items: [], error: `跑不起来 ${this.cli}：没装或者不在 PATH 上（npm i -g weflow-cli）` };
    if (!r.json) return { ok: false, items: [], error: r.raw || "sessions 没有 JSON 输出（先跑 weflow-cli sessions --json 看看）" };
    if (r.json.success === false) return { ok: false, items: [], error: failText(r.json) };
    const arr = Array.isArray(r.json) ? r.json : (r.json.sessions || r.json.items || []);
    const items = arr.slice(0, limit).map((c) => {
      const username = String(pick(c, ["username", "chatId", "chat_id", "id", "talker"]) || "");
      const name = String(pick(c, ["displayName", "name", "remark", "nickname"]) || username);
      return {
        chat_id: username,
        name,
        kind: isRoomId(username, pick(c, ["kind", "chatType", "chat_type", "type"])) ? "group" : "dm",
        member_count: Number(pick(c, ["memberCount", "member_count", "memberNum"]) || 0),
      };
    }).filter((c) => c.chat_id);
    return { ok: true, items };
  }

  async fetchMessages(chatId, { limit = 30, since = "" } = {}) {
    if (this.mock) {
      const rows = MOCK_MESSAGES[chatId] || [];
      return { ok: true, messages: rows.map((r) => normalize(r, chatId)).filter(Boolean) };
    }
    const sinceEpoch = since ? String(Math.floor((Date.parse(since) || 0) / 1000) || "") : "";
    const args = this.fill(this.cmdFetch, { chat: String(chatId), limit: String(limit), sinceEpoch, since: String(since) });
    const r = await this.run(args);
    if (r.missing) return { ok: false, messages: [], error: `跑不起来 ${this.cli}：没装或者不在 PATH 上（npm i -g weflow-cli）` };
    if (!r.json) return { ok: false, messages: [], error: r.raw || "messages 没有 JSON 输出" };
    if (r.json.success === false) return { ok: false, messages: [], error: failText(r.json) };
    const arr = Array.isArray(r.json) ? r.json : (r.json.messages || r.json.items || []);
    // 顺手认领自己的 wxid：自己发的那条，senderUsername 就是我
    if (!this.selfId) {
      const mine = arr.find((x) => Number(x.isSend) === 1 && x.senderUsername);
      if (mine) this.selfId = String(mine.senderUsername);
    }
    const floor = sinceEpoch ? Number(sinceEpoch) * 1000 : 0;
    const messages = arr.map((x) => normalize(x, chatId)).filter(Boolean)
      .map((m) => (m.is_self && this.selfId ? { ...m, sender_id: this.selfId } : m))
      .filter((m) => !floor || !m.ts_epoch || m.ts_epoch >= floor)
      .sort((a, b) => a.ts_epoch - b.ts_epoch)
      .slice(-limit);
    return { ok: true, messages };
  }

  async chatMembers() {
    return { ok: false, items: [], error: "weflow 不提供成员列表，@判定只能用正文名字" };
  }

  // weflow-cli 1.21.x 确实有 `send <target> <message> [--dry-run|--yes] [--json]`：
  // 目标必须在白名单里（否则 TARGET_NOT_ALLOWED），实际发送还要 --yes，且消息通道得先 login-wechat。
  // 本适配层不代发：默认只走 --dry-run 预览，要真发必须显式 confirm === true（严格判断，不做真值转换）。
  async sendText(chatId, text, { dryRun = true, confirm = false } = {}) {
    if (this.mock) return { ok: true, dry_run: true, chat_id: chatId, text };
    const real = dryRun === false && confirm === true; // 缺任何一个都只预览
    const vars = { chat: chatId, text, mode: real ? "--yes" : "--dry-run" };
    const r = await this.run(this.fill(this.cmdSend, vars), this.timeoutSec);
    if (r.missing) return { ok: false, error: `跑不起来 ${this.cli}：没装或者不在 PATH 上` };
    const j = r.json || {};
    if (!j.success) return { ok: false, dry_run: !real, chat_id: chatId, error: j.error || j.failure?.message || r.raw.slice(0, 200), code: j.code };
    return { ok: true, dry_run: !real, chat_id: chatId, text, result: j };
  }
}

export class IM {
  constructor(opts = {}) { this.adapter_ = new WeChatAdapter(opts); }
  adapter(_platform = PLATFORM) { return this.adapter_; }
  cliPath(_platform = PLATFORM) { return this.adapter_.cli; }
}
