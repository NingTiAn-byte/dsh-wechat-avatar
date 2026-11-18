// 适配层联调（不需要 weflow-cli，也不需要微信）：
// 用真实发布包的 JSON 形状喂 lib/wechat.js，验证命令拼装、字段映射、群聊判定、selfId 认领、错误透出。
// weflow-cli@1.21.17 的真实输出：
//   sessions --json -> { success, sessions: [{ username, displayName, type, summary, lastTimestamp }] }
//   messages <talker> --json -> { success, talker, messages: [{ localId, createTime, isSend, senderUsername, parsedContent }] }
// 失败时是 { success:false, code, failure:{ message, next } } + 退出码 1。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WeChatAdapter } from "../lib/wechat.js";

const FAKE = `const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "sessions") {
  process.stdout.write(JSON.stringify({ success: true, sessions: [
    { username: "wxid_lina", displayName: "李娜", type: 0, summary: "周报记得发我", lastTimestamp: 1763000000 },
    { username: "4521@chatroom", displayName: "项目群", type: 1, summary: "@李雷 接口文档", lastTimestamp: 1763000500 },
    { username: "", displayName: "坏数据", type: 0, summary: "" },
  ] }) + "\\n");
  process.exit(0);
}
if (cmd === "messages") {
  const chat = rest[0];
  if (chat === "broken") {
    process.stdout.write(JSON.stringify({ success: false, code: "READ_FAILED", talker: chat,
      failure: { message: "数据库打不开", next: "跑 weflow-cli check --report" }, messages: [] }) + "\\n");
    process.exit(1);
  }
  const since = Number(rest[rest.indexOf("-s") + 1] || 0);
  const all = [
    { localId: 11, serverId: "s11", createTime: 1759999000, isSend: 0, senderUsername: "wxid_lina", senderDisplay: "李娜", localType: 1, content: "老消息", parsedContent: "老消息" },
    { localId: 12, serverId: "s12", createTime: 1763000100, isSend: 0, senderUsername: "wxid_lina", senderDisplay: "李娜", localType: 1, content: "周报记得发我", parsedContent: "周报记得发我" },
    { localId: 13, serverId: "s13", createTime: 1763000200, isSend: 1, senderUsername: "wxid_me", localType: 1, content: "收到", parsedContent: "收到" },
  ];
  process.stdout.write(JSON.stringify({ success: true, talker: chat, messages: since ? all.filter((m) => m.createTime >= since) : all }) + "\\n");
  process.exit(0);
}
if (cmd === "contacts") {
  const withSelf = !rest.includes("--no-self");
  process.stdout.write(JSON.stringify({ success: true, contacts: [
    { username: "wxid_lina", displayName: "李娜" },
    ...(withSelf ? [{ username: "wxid_me", displayName: "李雷", remark: "" }] : []),
  ] }));
  process.exit(0);
}
if (cmd === "send") {
  if (rest.includes("--blocked")) {
    process.stdout.write(JSON.stringify({ success: false, code: "TARGET_NOT_ALLOWED", error: "目标不在白名单中" }));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ success: true, dryRun: rest.includes("--dry-run"), argv: rest }));
  process.exit(0);
}
if (cmd === "config") {
  process.stdout.write("配置:\\n  微信账号: wxid_me\\n  数据库: (已配置)\\n");
  process.exit(0);
}
process.exit(1);
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-fake-"));
const fake = path.join(dir, "fakecli.cjs");
fs.writeFileSync(fake, FAKE);

const node = process.execPath;
const mk = (extra = {}) => new WeChatAdapter({
  cli: node,
  cmdList: [fake, "sessions", "--json", "-n", "{limit}"],
  cmdFetch: [fake, "messages", "{chat}", "--json", "--non-interactive", "-n", "{limit}", "-s", "{sinceEpoch}"],
  cmdSelf: [fake, "config", "show"],
  cmdContacts: [fake, "contacts", "--json", "-n", "{limit}"],
  cmdSend: [fake, "send", "{chat}", "{text}", "{mode}", "--json"],
  ...extra,
});

try {
  const im = mk();

  // 1. 会话列表：字段映射 + @chatroom 判群 + 空 username 丢掉
  const list = await im.listChats(50);
  assert.equal(list.ok, true, "listChats 应成功");
  assert.equal(list.items.length, 2, "没有 username 的行要丢掉");
  assert.equal(list.items.find((c) => c.chat_id === "wxid_lina").kind, "dm");
  assert.equal(list.items.find((c) => c.chat_id === "wxid_lina").name, "李娜");
  assert.equal(list.items.find((c) => c.chat_id === "4521@chatroom").kind, "group", "@chatroom 必须判成群");

  // 2. 拉消息：since 换算成 Unix 秒、早于 since 的裁掉、按时间升序
  const since = new Date(1763000000 * 1000).toISOString();
  const r = await im.fetchMessages("4521@chatroom", { limit: 3, since });
  assert.equal(r.ok, true);
  assert.deepEqual(r.messages.map((m) => m.msg_id), ["12", "13"], "早于 since 的消息应被过滤");
  assert.equal(r.messages[0].content, "周报记得发我");
  assert.equal(r.messages[0].sender_id, "wxid_lina", "sender_id 要取 wxid，不是显示名");

  // 3. 自己发的那条认领 wxid（没有 whoami 时的兜底）
  assert.equal(im.selfId, "wxid_me", "应从容 isSend=1 的消息里认出自己");
  assert.equal(r.messages[1].sender_id, "wxid_me");

  // 4. 没给 since 时 -s 连名带值一起裁掉（否则 weflow 会收到空参数）
  const noSince = await im.fetchMessages("wxid_lina", { limit: 5 });
  assert.equal(noSince.ok, true);
  assert.equal(noSince.messages.length, 3, "不给 since 应拿到全部");

  // 5. 失败要带原因，不能伪装成「没有消息」
  const bad = await mk().fetchMessages("broken", {});
  assert.equal(bad.ok, false);
  assert.match(bad.error, /数据库打不开/);
  assert.match(bad.error, /check --report/);

  // 6. 账号从 config show 的文本里抠出来；昵称从 contacts 里翻自己那一条
  const who = await mk().whoami();
  assert.equal(who.ok, true);
  assert.equal(who.self_id, "wxid_me");
  assert.equal(who.self_name, "李雷", "通讯录里应能查到自己的昵称");

  // 6b. 通讯录里没有自己时，昵称留空并给出提示，不能编一个
  const whoNoSelf = await mk({ cmdContacts: [fake, "contacts", "--json", "--no-self", "-n", "{limit}"] }).whoami();
  assert.equal(whoNoSelf.ok, true);
  assert.equal(whoNoSelf.self_name, "");
  assert.match(whoNoSelf.note || "", /self\.names/);

  // 7. CLI 不存在时给一句人话，不抛栈
  const miss = await new WeChatAdapter({ cli: "definitely-not-installed-xyz" }).listChats(5);
  assert.equal(miss.ok, false);
  assert.ok(miss.error.length > 0);

  // 8. 发送：默认 --dry-run；只有 dryRun:false 且 confirm===true 才带 --yes
  const dry = await mk().sendText("wxid_lina", "hi");
  assert.equal(dry.ok, true);
  assert.equal(dry.dry_run, true);
  assert.match(dry.result.argv.join(" "), /--dry-run/);
  const noConfirm = await mk().sendText("wxid_lina", "hi", { dryRun: false });
  assert.equal(noConfirm.dry_run, true, "少了 confirm 也只能预览");
  assert.match(noConfirm.result.argv.join(" "), /--dry-run/);
  const real = await mk().sendText("wxid_lina", "hi", { dryRun: false, confirm: true });
  assert.equal(real.dry_run, false);
  assert.match(real.result.argv.join(" "), /--yes/);
  // 8b. 白名单外：失败原因要透出来，不能假装发出去了
  const blocked = await mk({ cmdSend: [fake, "send", "{chat}", "{text}", "{mode}", "--blocked", "--json"] }).sendText("wxid_x", "hi", { dryRun: false, confirm: true });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "TARGET_NOT_ALLOWED");

  console.log("adaptertest ok: 10 组断言通过（假 CLI，未接触真实微信数据）");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
