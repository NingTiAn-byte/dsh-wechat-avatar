#!/usr/bin/env node
// 联调：mock 扫描一轮 → 群聊里派给我的活应该自动落进绑定了这个群的「工作区任务」。结束还原 config / state。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { scanOnce } from "../lib/index.js";
import { CONFIG_PATH, loadConfig, saveConfig } from "../lib/config.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATE_DIR = path.join(ROOT, ".state");

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

const cfgBackup = fs.readFileSync(CONFIG_PATH, "utf8");
const stateBackup = fs.existsSync(STATE_DIR) ? fs.readFileSync(path.join(STATE_DIR, "state.json"), "utf8") : null;

try {
  // 先清掉去重状态，保证这轮全是「新消息」
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  const cfg = loadConfig();
  cfg.workspaces = [{ id: "ws_it", name: "项目群", chats: ["chat_proj"] }];
  saveConfig(cfg);

  const res = await scanOnce({ mock: true });
  ok(res.filed > 0, "扫描后记录了任务（filed=" + res.filed + "）");
  const ws = loadConfig().workspaces.find((w) => w.id === "ws_it");
  ok(ws.tasks.length === res.filed, "落盘任务数与 filed 一致");
  ok(ws.tasks.every((t) => t.status === "todo" && t.title), "任务都是待办且有标题");
  ok(ws.tasks.every((t) => t.source && t.source.msg_id), "任务带来源消息 id");
  ok(ws.tasks.some((t) => /周报|导出|数据/.test(t.title)), "群里派活的原文进了任务");
  ok(res.task_stats.todo === res.filed, "统计里待办数对得上");

  // 第二轮：消息没变，靠 state 去重，不该重复记任务
  const res2 = await scanOnce({ mock: true });
  ok(res2.filed === 0, "第二轮 filed=0");
  ok(loadConfig().workspaces.find((w) => w.id === "ws_it").tasks.length === ws.tasks.length, "任务没翻倍");
} finally {
  fs.writeFileSync(CONFIG_PATH, cfgBackup);
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  if (stateBackup !== null) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, "state.json"), stateBackup);
  }
}

console.log("scanwstest ok: " + passed + " 项断言通过（config/state 已还原）");
