// 「交给 DSH」的离线测试：用一个假 ctx 假装 DSH 会话服务，验证递话逻辑与失败路径。
// 不新建真实会话，也不碰微信数据。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handoffToDsh, taskBrief, userMessage, turnReply, readSessionReply, chatSubdir, sessionCwd } from "../lib/handoff.js";

const task = {
  id: "t_1",
  title: "把接口文档补上",
  deadline: "周五",
  status: "todo",
  source: { chat_name: "项目群", sender: "李娜", chat_id: "4521@chatroom" },
};
const ws = { id: "ws_a", name: "项目A" };

// 1. 正常路径：建会话 → 拿到 agent → 投一条 user 消息
let sent = null;
const okCtx = {
  sessionController: {
    async create() { return { sessionId: "session-x" }; },
    async resolveAgent(id) { return { agent: { followup(m) { sent = m; } } }; },
  },
};
const r1 = await handoffToDsh(okCtx, task, ws);
assert.equal(r1.ok, true, "正常路径应当成功");
assert.equal(r1.sessionId, "session-x");
assert.equal(sent && sent.role, "user", "投进去的必须是 user 消息");
assert.match(sent.content[0].text, /把接口文档补上/, "简报里要有任务标题");
assert.match(sent.content[0].text, /项目群（李娜）/, "简报里要带来源");
assert.match(sent.content[0].text, /等我(确认|回「执行」)/, "简报里要有「先给方案」的约束");

// 2. 部署里没有会话服务
const r2 = await handoffToDsh({}, task, ws);
assert.equal(r2.ok, false);
assert.match(r2.error, /sessionController/);

// 3. 新建会话抛错
const r3 = await handoffToDsh({ sessionController: { async create() { throw new Error("boom"); } } }, task, ws);
assert.equal(r3.ok, false);
assert.match(r3.error, /boom/);

// 4. 会话建好了但 agent 起不来
const r4 = await handoffToDsh({
  sessionController: {
    async create() { return { sessionId: "session-y" }; },
    async resolveAgent() { return { error: { code: "session/agent-busy", message: "会话正忙" } }; },
  },
}, task, ws);
assert.equal(r4.ok, false);
assert.equal(r4.sessionId, "session-y");
assert.match(r4.error, /会话正忙/);

// 5. 空任务也能生成简报，不会变成空消息
assert.match(taskBrief({}, {}), /无标题/);

// 6. 每条消息有独立 id
assert.notEqual(userMessage("x").id, userMessage("x").id);

// 7. 事件流：还没收尾的一轮不算说完
const mid = turnReply([
  { type: "turn/start" },
  { type: "assistant/message", data: { message: { content: [{ type: "text", text: "我先看看" }] } } },
]);
assert.equal(mid.ended, false, "没有 turn/end 就是还没说完");
assert.match(mid.text, /我先看看/, "半截的回复也能拿到");

// 8. 收尾的一轮：把这一轮的 assistant 文本拼起来
const done = turnReply([
  { type: "turn/start" },
  { type: "assistant/message", data: { message: { content: [{ type: "text", text: "方案如下" }] } } },
  { type: "assistant/message", data: { message: { content: [{ type: "text", text: "1. 先改配置" }] } } },
  { type: "turn/end" },
]);
assert.equal(done.ended, true);
assert.equal(done.text, "方案如下\n\n1. 先改配置", "多段回复按顺序拼接");

// 9. 只看最近一轮：更早的回复不算
const onlyLast = turnReply([
  { type: "turn/start" },
  { type: "assistant/message", data: { message: { content: [{ type: "text", text: "上一轮" }] } } },
  { type: "turn/end" },
  { type: "turn/start" },
  { type: "assistant/message", data: { message: { content: [{ type: "text", text: "这一轮" }] } } },
  { type: "turn/end" },
]);
assert.equal(onlyLast.text, "这一轮", "只取最后一个 turn/start 之后的回复");

// 10. 从会话服务里读回复：拿不到会话就报错，不抛
const readOk = await readSessionReply({
  sessionController: {
    async resolveAgent() {
      return { agent: { session: { snapshotEvents: () => [{ type: "turn/start" }, { type: "assistant/message", data: { message: { content: [{ type: "text", text: "搞定" }] } } }, { type: "turn/end" }] } } };
    },
  },
}, "session-x");
assert.equal(readOk.ok + "|" + readOk.ended + "|" + readOk.text, "true|true|搞定", "能从会话里读出回执");
const readGone = await readSessionReply({}, "session-x");
assert.equal(readGone.ok, false, "没有会话服务时只报错不抛");

// 11. 绑定了 DSH 工作区：create 必须带 workspaceId，会话才会出现在那个工作区里
let createReq = null;
const wsCtx = {
  sessionController: {
    async create(req) { createReq = req; return { sessionId: "session-ws" }; },
    async resolveAgent() { return { agent: { followup() {} } }; },
  },
};
const r11 = await handoffToDsh(wsCtx, task, { ...ws, dsh_workspace: "ws-abc" });
assert.equal(r11.ok, true);
assert.deepEqual(createReq, { workspaceId: "ws-abc" }, "create 要带 workspaceId");

// 12. 没绑工作区：仍按默认位置建（不传多余参数）
createReq = null;
await handoffToDsh(wsCtx, task, ws);
assert.deepEqual(createReq, {}, "没绑工作区就不带 workspaceId");

// 13. 复用会话：同一个群第二条任务接着用旧会话，不再新建
let created2 = 0;
let reusedMsg = null;
const reuseCtx = {
  sessionController: {
    async create() { created2 += 1; return { sessionId: "session-new" }; },
    async resolveAgent() { return { agent: { followup(m) { reusedMsg = m; } } }; },
  },
};
const r13 = await handoffToDsh(reuseCtx, task, ws, { sessionId: "session-old" });
assert.equal(r13.ok, true);
assert.equal(r13.reused, true, "旧会话还在就复用它");
assert.equal(r13.sessionId, "session-old");
assert.equal(created2, 0, "复用时不新建会话");
assert.match(reusedMsg.content[0].text, /把接口文档补上/, "复用也要把任务投进去");

// 14. 旧会话没了：回退成新建，任务不丢
let created3 = 0;
const goneCtx = {
  sessionController: {
    async create() { created3 += 1; return { sessionId: "session-fresh" }; },
    async resolveAgent(id) {
      if (id === "session-old") return { error: { code: "session/missing" } };
      return { agent: { followup() {} } };
    },
  },
};
const r14 = await handoffToDsh(goneCtx, task, ws, { sessionId: "session-old" });
assert.equal(r14.ok, true);
assert.equal(r14.reused, false, "旧会话不在就新建");
assert.equal(created3, 1);
assert.equal(r14.sessionId, "session-fresh");

// 15. 按群名分子目录：cwd = <DSH 工作区路径>\<群名>，目录自动建
const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "wfws-"));
const cwd = sessionCwd({ dsh_workspace_path: tmpWs }, { name: "测试群" });
assert.equal(cwd, path.join(tmpWs, "测试群"), "cwd 是工作区下的群名子目录");
assert.equal(fs.statSync(cwd).isDirectory(), true, "子目录要真的建出来");
assert.equal(sessionCwd({}, { name: "测试群" }), "", "没绑路径就退回工作区根目录");
assert.equal(chatSubdir({ name: "a/b:c*?" }), "a_b_c__", "文件名非法字符换成下划线");

// 16. 绑了 DSH 工作区时只传 workspaceId（再带 cwd 会被 DSH 拒掉），子目录留在 prompt 里
createReq = null;
await handoffToDsh(wsCtx, task, { ...ws, dsh_workspace: "ws-abc", dsh_workspace_path: tmpWs }, { cwd });
assert.deepEqual(createReq, { workspaceId: "ws-abc" }, "只传 workspaceId，不能和 cwd 同时出现");
const briefWithCwd = taskBrief(task, { ...ws, dsh_workspace: "ws-abc" }, cwd);
assert.ok(briefWithCwd.includes(cwd), "子目录要写进 prompt");
assert.ok(briefWithCwd.includes("工作区根"), "并说明会话根目录是工作区根");

// 17. 没绑工作区但有 cwd：只传 cwd
createReq = null;
await handoffToDsh(wsCtx, task, ws, { cwd });
assert.deepEqual(createReq, { cwd }, "没绑工作区就只传 cwd");
fs.rmSync(tmpWs, { recursive: true, force: true });

console.log("handofftest ok: 17 组断言通过（假 ctx，没有新建真实会话）");
