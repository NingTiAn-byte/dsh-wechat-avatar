#!/usr/bin/env node
// 管理页接口的端到端自测：起一个真 http 服务，GET 配置 → POST 改一个群 → 回读校验 → 还原 config.json。
//   node bin/apitest.js
import http from "node:http";
import fs from "node:fs";
import assert from "node:assert/strict";
import { handler, API_PREFIX } from "../lib/api.js";
import { CONFIG_PATH, loadConfig } from "../lib/config.js";

const backup = fs.readFileSync(CONFIG_PATH, "utf8");
let server;
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

try {
  server = http.createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port + API_PREFIX + "/api/config";

  const got = await (await fetch(base)).json();
  ok(got.ok === true, "GET 应返回 ok");
  ok(Array.isArray(got.chats), "GET 带 chats 列表");
  ok(!!got.config && !!got.config.policy, "GET 带当前配置");

  const before = loadConfig();
  const post = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ self: { names: ["测试名"], byChat: { chat_test: ["阿测"] } }, policy: { dm: "mention", nick: false }, poll: { sec: 120 } }),
  });
  const saved = await post.json();
  ok(saved.ok === true, "POST 应返回 ok");
  ok(saved.config.self.names.includes("测试名"), "全局称呼已写入");
  ok(saved.config.self.byChat.chat_test?.[0] === "阿测", "按群称呼已写入");
  ok(saved.config.policy.nick === false, "nick 开关已写入");
  ok(saved.config.poll.sec === 120, "轮询间隔已写入");
  ok(loadConfig().poll.sec === 120, "落盘生效（重新 load 仍是 120）");

  const rejected = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: "{bad json" });
  ok(rejected.status === 400, "坏 JSON 返回 400");

  const notFound = await fetch("http://127.0.0.1:" + server.address().port + API_PREFIX + "/api/nope");
  ok(notFound.status === 404, "未知路径返回 404");
} finally {
  if (server) server.close();
  fs.writeFileSync(CONFIG_PATH, backup);
}

console.log("apitest ok: " + passed + " 项断言通过（config.json 已还原）");
