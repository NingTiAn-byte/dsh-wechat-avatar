#!/usr/bin/env node
// 工作区/任务：先测纯数据层，再起真 http 服务测 /api/workspace 与 /api/task。结束还原 config.json。
import http from "node:http";
import fs from "node:fs";
import assert from "node:assert/strict";
import {
  normalizeWorkspaces, workspaceFor, addTask, setTaskStatus, removeTask,
  addWorkspace, updateWorkspace, removeWorkspace, stats, TASK_CAP,
} from "../lib/workspaces.js";
import { handler, API_PREFIX } from "../lib/api.js";
import { CONFIG_PATH, loadConfig } from "../lib/config.js";

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); passed++; };

// —— 纯数据层
const list = normalizeWorkspaces([
  { id: "ws_a", name: "项目群", chats: ["chat_proj", "项目群", "chat_proj"], tasks: [{ title: "跑一遍导出脚本", status: "done" }] },
  { id: "ws_a", name: "重复 id" },
]);
eq(list.length, 1, "重复 id 只留一个");
eq(list[0].chats, ["chat_proj", "项目群"], "绑定去重");
eq(list[0].tasks.length, 1, "任务保留");

eq(workspaceFor(list, { chat_id: "chat_proj" })?.id, "ws_a", "按 chat_id 命中");
eq(workspaceFor(list, { chat_id: "x", name: "项目群" })?.id, "ws_a", "按群名命中");
eq(workspaceFor(list, { chat_id: "nope" }), null, "都不命中返回 null");

const ws = list[0];
const t1 = addTask(ws, { title: "把周报汇总发出去", source: { msg_id: "m1", chat_id: "chat_proj" }, deadline: "今天" });
ok(t1 && t1.id, "新任务有 id");
eq(ws.tasks.length, 2, "任务加进去了");
eq(ws.tasks[1].deadline, "今天", "期限保留");
eq(addTask(ws, { title: "重复同一条", source: { msg_id: "m1" } }), null, "同一 msg_id 不重复落任务");
eq(ws.tasks.length, 2, "去重后数量不变");

eq(setTaskStatus(ws, t1.id, "done").status, "done", "状态可改");
eq(setTaskStatus(ws, t1.id, "bogus").status, "done", "非法状态被忽略");
eq(removeTask(ws, t1.id), 1, "删掉一条");
eq(stats(ws.tasks ? [ws] : []).done >= 0, true, "统计可用");

// 任务上限：加满再看长度
const big = normalizeWorkspaces([{ id: "ws_big", name: "压力", chats: [] }])[0];
for (let i = 0; i < TASK_CAP + 20; i++) addTask(big, { title: "t" + i, source: { msg_id: "m" + i } });
eq(big.tasks.length, TASK_CAP, "任务数封顶 " + TASK_CAP);

// —— HTTP 层
const backup = fs.readFileSync(CONFIG_PATH, "utf8");
let server;
try {
  server = http.createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const api = (p) => "http://127.0.0.1:" + port + API_PREFIX + p;
  const post = async (p, body) => {
    const r = await fetch(api(p), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };

  const added = await post("/api/workspace", { action: "add", name: "接口工作区", chats: ["chat_api"] });
  ok(added.body.ok === true, "新建工作区成功");
  const wsId = added.body.config.workspaces.find((w) => w.name === "接口工作区").id;
  ok(!!wsId, "返回里带新工作区 id");

  const renamed = await post("/api/workspace", { action: "update", id: wsId, name: "改名后", chats: ["chat_api", "API群"] });
  eq(renamed.body.config.workspaces.find((w) => w.id === wsId).name, "改名后", "工作区改名生效");

  const t = await post("/api/task", { action: "add", wsId, title: "接口加的任务", source: { msg_id: "api_m1" } });
  ok(t.body.ok === true, "接口加任务成功");
  const tid = t.body.task.id;

  const dup = await post("/api/task", { action: "add", wsId, title: "重复", source: { msg_id: "api_m1" } });
  eq(dup.status, 400, "同 msg_id 重复加任务被拒");

  const done = await post("/api/task", { action: "status", wsId, taskId: tid, status: "done" });
  eq(done.body.task.status, "done", "任务标记完成");

  const badWs = await post("/api/task", { action: "add", wsId: "ws_nope", title: "x" });
  eq(badWs.status, 404, "不存在的工作区返回 404");

  const got = await (await fetch(api("/api/config"))).json();
  ok(got.config.workspaces.some((w) => w.id === wsId), "GET 能读到工作区");

  const removed = await post("/api/workspace", { action: "remove", id: wsId });
  ok(removed.body.ok === true, "删工作区成功");
  ok(!removed.body.config.workspaces.some((w) => w.id === wsId), "删干净了");
} finally {
  if (server) server.close();
  fs.writeFileSync(CONFIG_PATH, backup);
}

console.log("wstest ok: " + passed + " 项断言通过（config.json 已还原）");
