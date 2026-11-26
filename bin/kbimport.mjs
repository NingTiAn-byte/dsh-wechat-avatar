#!/usr/bin/env node
// 把 config.json 里已有的任务补录进 knowledge/（只跑一次就有历史可以搜）
import { loadConfig } from "../lib/config.js";
import { record } from "../lib/kb.js";

const cfg = loadConfig();
let n = 0;
for (const ws of cfg.workspaces || []) {
  for (const t of ws.tasks || []) {
    const src = t.source || {};
    record({
      task_id: t.id,
      chat: src.chat_name || ws.name || "",
      chat_id: src.chat_id || "",
      sender: src.sender || "",
      title: t.title || "",
      need: t.note || t.title || "",
      status: t.status || "todo",
      session_id: t.session_id || "",
      reply: t.reply || "",
    });
    n += 1;
  }
}
console.log(`已补录 ${n} 条任务到 knowledge/`);
