// 「交给 DSH」的离线测试：用一个假 ctx 假装 DSH 会话服务，验证递话逻辑与失败路径。
// 不新建真实会话，也不碰微信数据。

import assert from "node:assert/strict";
import { handoffToDsh, taskBrief, userMessage } from "../lib/handoff.js";

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
assert.match(sent.content[0].text, /等我确认/, "简报里要有「先给方案」的约束");

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

console.log("handofftest ok: 6 组断言通过（假 ctx，没有新建真实会话）");
