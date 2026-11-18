#!/usr/bin/env node
// 离线 demo：不需要微信、不需要 weflow-cli。
//   node bin/demo.js --mock
//   node bin/demo.js --mock --dm=mention --group=mention_only
//   node bin/demo.js --mock --set chat_proj:off
//
// 值守策略（config.json，可被命令行覆盖）：
//   dm    = always 私聊消息即任务 | mention 非要 @ 我 | off 不看私聊
//   group = mention_only 群聊必须 @我 | always 群里说话都算 | off 不看群

import { WeChatAdapter } from "../lib/wechat.js";
import { describePoll } from "../lib/schedule.js";
import { judgeAll } from "../lib/judge.js";
import { loadState, saveState, takeFresh } from "../lib/state.js";
import { loadConfig, applyCliOverrides } from "../lib/config.js";
import { gateOf } from "../lib/policy.js";
import { namesForChat, describeNames } from "../lib/names.js";

const argv = process.argv.slice(2);
const val = (f, d = "") => { const i = argv.indexOf(f); return i >= 0 ? (argv[i + 1] ?? d) : d; };

const mock = argv.includes("--mock");
const chatFilter = val("--chat", "");
const since = val("--since", new Date(Date.now() - 24 * 3600e3).toISOString());
const dir = val("--dir", "");

let cfg = applyCliOverrides(loadConfig(), argv);
for (let i = 0; i < argv.length; i++) {       // --set chat_proj:off / --set chat_li:always
  if (argv[i] !== "--set") continue;
  const m = /^([^:]+):(\S+)$/.exec(argv[i + 1] || "");
  if (m) cfg.policy.overrides = { ...(cfg.policy.overrides || {}), [m[1]]: m[2] };
}

const im = new WeChatAdapter({ mock, selfId: mock ? "wxid_me" : "", selfNames: mock ? ["我"] : [] });
const state = dir ? loadState(dir) : loadState();

const who = await im.whoami();
if (!who.ok) { console.error("whoami 失败：", who.error); process.exit(2); }

const listed = await im.listChats(20);
if (!listed.ok) { console.error("会话列表失败：", listed.error); process.exit(2); }
const chats = chatFilter ? listed.items.filter((c) => c.chat_id === chatFilter) : listed.items;

const GATE_CN = { always: "不设门槛", mention: "必须@我", off: "不值守" };
console.log("平台=wechat 模式=" + (mock ? "demo(示例数据)" : "live") + " 本人=" + (who.self_name || who.self_id));
console.log("监听：" + describePoll(cfg.poll));
console.log("策略：私聊=" + cfg.policy.dm + "（" + (GATE_CN[gateOf({ kind: "dm" }, cfg.policy)] || "?") + "）  群聊=" + cfg.policy.group + "（" + (GATE_CN[gateOf({ kind: "group" }, cfg.policy)] || "?") + "）");
console.log("");

let assignedTotal = 0;
for (const chat of chats) {
  const gate = gateOf(chat, cfg.policy);
  const names = namesForChat(cfg.self, chat, who.self_name);
  const label = "[" + chat.name + "] " + (chat.kind === "dm" ? "私聊" : "群聊") + " 闸门=" + GATE_CN[gate] + " 喊我=" + describeNames(names);
  if (gate === "off") { console.log(label + " —— 跳过"); console.log(""); continue; }
  const r = await im.fetchMessages(chat.chat_id, { limit: 50, since });
  if (!r.ok) { console.log(label + " 拉取失败：" + r.error); continue; }
  const fresh = takeFresh(state, chat.chat_id, r.messages);
  const decisions = judgeAll(fresh, { selfId: who.self_id, selfNames: names, chat, gate, nick: cfg.policy.nick !== false });
  console.log(label + "  拉 " + r.messages.length + " 条 / 新 " + fresh.length + " 条");
  for (const d of decisions) {
    const tag = d.assigned ? "PASS " : d.reply_needed ? "REPLY" : "--   ";
    console.log("  " + tag + " conf=" + String(d.confidence).padEnd(5) + " " + d.owner + "：" + d.evidence.text.slice(0, 40));
    if (d.task) console.log("         任务=" + d.task + (d.deadline ? "  期限=" + d.deadline : "") + "  （" + d.reason + "）");
    if (d.assigned) assignedTotal++;
  }
  console.log("");
}
dir ? saveState(state, dir) : saveState(state);
console.log("合计：派给我的活 " + assignedTotal + " 条；检查点已更新（seen 去重，重跑不会重复计数）");
