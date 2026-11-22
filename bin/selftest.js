#!/usr/bin/env node
// 断言判定与闸门规则，改 judge.js / policy.js 后先跑这个。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judge } from "../lib/judge.js";
import { gateOf } from "../lib/policy.js";
import { WeChatAdapter } from "../lib/wechat.js";
import { loadState, takeFresh, getChatSession, setChatSession, dropChatSession } from "../lib/state.js";
import { nextDelay, nextFails, describePoll, DEFAULT_POLL } from "../lib/schedule.js";
import { namesForChat, usableNames } from "../lib/names.js";
import { sanitizePatch, mergePatch } from "../lib/api.js";
import { DEFAULT_CONFIG } from "../lib/config.js";
import { ensureGroup } from "../lib/workspaces.js";
import { sessionCwd } from "../lib/handoff.js";
import { normalizeTask, normalizeWorkspaces, updateWorkspace } from "../lib/workspaces.js";

const im = new WeChatAdapter({ mock: true, selfId: "wxid_me", selfNames: ["李雷", "雷哥"] });
const who = await im.whoami();
const chats = Object.fromEntries((await im.listChats(20)).items.map((c) => [c.chat_id, c]));
const SELF = { names: ["李雷"], byChat: { chat_proj: ["雷哥"], chat_ops: ["老李"] } };
const opt = (chatId, gate) => ({ selfId: who.self_id, selfNames: namesForChat(SELF, chats[chatId], who.self_name), chat: chats[chatId], gate });

const groupMsgs = (await im.fetchMessages("chat_proj", {})).messages;
const dmMsgs = (await im.fetchMessages("chat_li", {})).messages;
const custMsgs = (await im.fetchMessages("chat_cust", {})).messages;
const opsMsgs = (await im.fetchMessages("chat_ops", {})).messages;
const byId = (arr) => Object.fromEntries(arr.map((m) => [m.msg_id, m]));
const gm = byId(groupMsgs), dm = byId(dmMsgs), cm = byId(custMsgs), om = byId(opsMsgs);

// —— 闸门
assert.equal(gateOf({ chat_id: "a", kind: "dm" }), "always", "私聊默认不设门槛");
assert.equal(gateOf({ chat_id: "b", kind: "group" }), "mention", "群聊默认必须@我");
assert.equal(gateOf({ chat_id: "a", kind: "dm" }, { dm: "mention", group: "mention_only" }), "mention", "私聊可改成要@");
assert.equal(gateOf({ chat_id: "b", kind: "group" }, { dm: "always", group: "off" }), "off", "群可整体关闭");
assert.equal(gateOf({ chat_id: "x", kind: "group" }, { dm: "always", group: "mention_only", overrides: { x: "always" } }), "always", "单会话覆盖");

// —— 群聊：@我才算
const gGate = gateOf(chats.chat_proj);
assert.equal(judge(gm.p2, opt("chat_proj", gGate)).assigned, true, "@我 的派活要认");
assert.equal(judge(gm.p2, opt("chat_proj", gGate)).deadline, "今天");
assert.equal(judge(gm.p5, opt("chat_proj", gGate)).assigned, false, "@别人 的活不算我的");
assert.equal(judge(gm.p6, opt("chat_proj", gGate)).assigned, false, "群里没@我不算，哪怕说「你在吗」");
assert.equal(judge(gm.p3, opt("chat_proj", gGate)).assigned, false, "没点名的提问不算");
assert.equal(judge(gm.p1, opt("chat_proj", gGate)).assigned, false, "寒暄不算");
assert.equal(judge(gm.p4, opt("chat_proj", gGate)).assigned, false, "自己发的忽略");

// —— 昵称：群里不 @，直接喊名字也算叫我
assert.equal(judge(gm.p8, opt("chat_proj", gGate)).assigned, true, "群里直接喊昵称也算派活");
assert.ok(judge(gm.p8, opt("chat_proj", gGate)).confidence >= 0.7, "喊昵称的置信度要够");
assert.equal(judge(gm.p8, { ...opt("chat_proj", gGate), nick: false }).assigned, false, "nick=false 后裸昵称不算");
assert.equal(judge(gm.p6, opt("chat_proj", gGate)).assigned, false, "「你在吗」不算喊我昵称");
const genericNick = judge({ msg_id: "x1", sender_id: "u1", sender_name: "王五", content: "我明天看一下" }, { ...opt("chat_proj", gGate), selfNames: ["我"] });
assert.equal(genericNick.assigned, false, "泛称「我」不当昵称用");
assert.equal(judge({ msg_id: "x2", sender_id: "u1", sender_name: "王五", content: "@张三 李雷那边你来对接下" }, opt("chat_proj", gGate)).assigned, true, "@别人但同时喊了我，仍算叫我");
assert.equal(judge({ msg_id: "x3", sender_id: "u1", sender_name: "王五", content: "雷哥，帮我看下" }, { ...opt("chat_proj", gGate), selfNames: ["雷"] }).assigned, false, "单字昵称不参与裸称呼匹配");

// —— 私聊：发来就算
const dGate = gateOf(chats.chat_li);
assert.equal(judge(dm.l1, opt("chat_li", dGate)).assigned, true, "私聊不@也算活");
assert.equal(judge(dm.l2, opt("chat_li", dGate)).assigned, true, "私聊问句也算活");
assert.equal(judge(dm.l3, opt("chat_li", dGate)).assigned, false, "自己发的不算");

// —— 客户私聊 + 无意义回复
const cGate = gateOf(chats.chat_cust);
assert.equal(judge(cm.c1, opt("chat_cust", cGate)).assigned, true, "客户私聊要算活");
assert.equal(judge(cm.c1, opt("chat_cust", cGate)).deadline, "明天");
assert.equal(judge(cm.c3, opt("chat_cust", cGate)).assigned, false, "「好的谢谢」不算活");

// —— 按群昵称：每个群可以有自己的叫法
assert.deepEqual(namesForChat(SELF, chats.chat_ops, "李雷"), ["李雷", "老李"], "全局 + 本群称呼取并集");
assert.deepEqual(namesForChat({}, { chat_id: "x" }, ""), [], "没配置就是空名单");
assert.deepEqual(usableNames(["李雷", "我", "雷", "大家", "雷哥"]), ["李雷", "雷哥"], "泛称和单字被剔除");
assert.equal(judge(om.o1, opt("chat_ops", "mention")).assigned, true, "本群专属称呼「老李」要认");
assert.equal(judge(om.o2, opt("chat_ops", "mention")).assigned, false, "「雷哥」不属于这个群，不该认");
assert.equal(judge(om.o2, opt("chat_proj", "mention")).assigned, true, "同一条消息在别的群里，称呼对上了就算");

// —— 闸门切换的效果
assert.equal(judge(gm.p6, opt("chat_proj", "always")).assigned, true, "群设成 always 后不@也算");
assert.equal(judge(dm.l1, opt("chat_li", "mention")).assigned, false, "私聊设成 mention 后不@不算");
assert.equal(judge(dm.l1, opt("chat_li", "off")).assigned, false, "关闭值守不判活");

// —— 去重
const s = loadState(fs.mkdtempSync(path.join(os.tmpdir(), "wx-demo-")));
assert.equal(takeFresh(s, "chat_proj", groupMsgs).length, groupMsgs.length);
assert.equal(takeFresh(s, "chat_proj", groupMsgs).length, 0, "第二次应全部去重");

// —— 管理页写入的配置：只收认识的字段，越界丢掉
assert.deepEqual(sanitizePatch({ policy: { dm: "bogus", nick: false } }), { policy: { nick: false } }, "非法闸门值被丢掉");
assert.deepEqual(sanitizePatch({ self: { names: [" 李雷 ", "李雷", ""] } }).self.names, ["李雷"], "称呼去空去重");
assert.deepEqual(sanitizePatch({ poll: { sec: 9999 } }).poll.sec, 3600, "轮询间隔封顶 1 小时");
assert.deepEqual(sanitizePatch({ self: { byChat: { chat_x: ["老王"] } } }).self.byChat, { chat_x: ["老王"] }, "按群称呼能落库");
assert.equal(mergePatch({ policy: { dm: "always", group: "mention_only" } }, sanitizePatch({ policy: {} })).policy.dm, "always", "空补丁不动原有值");

// —— 监听范围：空数组 = 全部；非空 = 只扫这些
assert.deepEqual(sanitizePatch({ watch: [" 58831004714@chatroom ", "58831004714@chatroom", ""] }).watch, ["58831004714@chatroom"], "监听范围去空去重");
assert.deepEqual(sanitizePatch({ watch: [] }).watch, [], "空数组=全部会话，也要能落库");
assert.deepEqual(mergePatch({ watch: ["a"] }, sanitizePatch({ watch: ["b", "c"] })).watch, ["b", "c"], "监听范围整表替换");
assert.deepEqual(DEFAULT_CONFIG.watch, [], "默认监听全部会话");

// —— 监听节奏
const fixed = () => 0.5; // 抖动归零
assert.equal(nextDelay(0, { ...DEFAULT_POLL }, fixed), 60000, "默认 60 秒一轮");
assert.equal(nextDelay(0, { sec: 0 }, fixed), 0, "sec=0 表示不自动轮询");
assert.equal(nextDelay(1, { ...DEFAULT_POLL }, fixed), 120000, "失败一次退避到 2 分钟");
assert.equal(nextDelay(3, { ...DEFAULT_POLL }, fixed), 480000, "失败三次退避到 8 分钟");
assert.equal(nextDelay(9, { ...DEFAULT_POLL }, fixed), 600000, "退避封顶 10 分钟");
assert.equal(nextDelay(0, { sec: 1 }, fixed), 20000, "间隔不得低于 20 秒");
const jit = [nextDelay(0, { ...DEFAULT_POLL }, () => 0), nextDelay(0, { ...DEFAULT_POLL }, () => 0.999)];
assert.ok(jit[0] < 60000 && jit[1] > 60000, "抖动上下浮动");
assert.equal(nextFails(3, true), 0, "成功一轮清零退避");
assert.equal(nextFails(9, false), DEFAULT_POLL.maxFails, "失败计数封顶");
assert.equal(describePoll({ sec: 60 }).includes("每 60 秒"), true);

// —— 发送政策：只读 + 人工审核。发送不是「默认关」，而是根本没有调用方
const libDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib");
const sendCallers = fs
  .readdirSync(libDir)
  .filter((f) => f.endsWith(".js"))
  .flatMap((f) => fs.readFileSync(path.join(libDir, f), "utf8").split("\n").filter((l) => /\.sendText\s*\(/.test(l) && !/^\s*(\/\/|\*)/.test(l)));
assert.deepEqual(sendCallers, [], "lib 里没有任何地方调用 sendText：发送只能由人触发");
assert.equal((await im.sendText("chat_proj", "hi")).dry_run, true, "默认 dryRun，走不到真发");
assert.equal((await im.sendText("chat_proj", "hi", { dryRun: false })).dry_run, true, "mock 下连非 dryRun 都不发（真适配器的拒绝在 adaptertest 里测）");

// —— 交给 DSH：默认不自动交，回执字段要能过 normalizeTask（否则存盘就丢）
assert.equal(DEFAULT_CONFIG.handoff.auto, false, "自动交付默认关");
assert.deepEqual(sanitizePatch({ handoff: { auto: true } }), { handoff: { auto: true } }, "自动交付开关能落库");
assert.deepEqual(mergePatch({ handoff: { maxPerScan: 3 } }, sanitizePatch({ handoff: { auto: true } })).handoff, { maxPerScan: 3, auto: true }, "开关与上限合并");
const keptTask = normalizeTask({ title: "x", session_id: "session-1", reply: "做完了" });
assert.equal(keptTask.session_id + "|" + keptTask.reply, "session-1|做完了", "会话 id 与回执能存进任务");

// —— 工作区可以绑到用户已有的 DSH 工作区，交给 DSH 的会话就建在里面
const wsList = normalizeWorkspaces([{ name: "项目A", chats: ["a"], dsh_workspace: "ws-123", tasks: [] }]);
assert.equal(wsList[0].dsh_workspace, "ws-123", "DSH 工作区 id 能存进插件工作区");
assert.equal(updateWorkspace(wsList, wsList[0].id, { dsh_workspace: "ws-456" }).dsh_workspace, "ws-456", "绑定的 DSH 工作区能改");

// —— 每个群一个会话 + 按群名分子目录
const sessState = { sessions: {} };
setChatSession(sessState, "4521@chatroom", { session_id: "s-1", cwd: "C:\\wx\\测试群" });
assert.equal(getChatSession(sessState, "4521@chatroom").session_id, "s-1", "群能记住自己的会话");
dropChatSession(sessState, "4521@chatroom");
assert.equal(getChatSession(sessState, "4521@chatroom"), null, "重开会话就是把这个群记的会话删掉");
const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "wfws-"));
const pathWs = normalizeWorkspaces([{ name: "项目A", dsh_workspace: "ws-1", dsh_workspace_path: tmpWs, tasks: [] }]);
assert.equal(pathWs[0].dsh_workspace_path, tmpWs, "DSH 工作区路径能存进任务组");
assert.equal(sessionCwd(pathWs[0], { name: "测试群" }), path.join(tmpWs, "测试群"), "会话按群名分目录");
fs.rmSync(tmpWs, { recursive: true, force: true });

// —— 自动归组：命中派活时按会话名建组，同名组复用
assert.equal(DEFAULT_CONFIG.group_auto, true, "自动归组默认开");
const gList = [];
const g1 = ensureGroup(gList, { chat_id: "4521@chatroom", name: "测试群", kind: "group" }, { dsh_workspace: "ws-9", dsh_workspace_path: "C:\\ai" });
assert.equal(g1.created, true, "没组就自动建");
assert.equal(g1.ws.name + "|" + g1.ws.dsh_workspace, "测试群|ws-9", "组名用会话名，并继承默认工作区");
const g2 = ensureGroup(gList, { chat_id: "4521@chatroom", name: "测试群" }, {});
assert.equal(g2.created, false, "已有组不再建");
assert.equal(g2.ws.id, g1.ws.id, "同一个会话还是那个组");
const g3 = ensureGroup(gList, { chat_id: "999@chatroom", name: "测试群" }, {});
assert.equal(g3.created, false, "同名组直接复用");
assert.equal(gList.length, 1, "同名不会建出第二个组");
const g4 = ensureGroup(gList, { chat_id: "777@chatroom", name: "客户A" }, {});
assert.equal(g4.created, true, "不同会话各建各的组");
assert.equal(gList.length, 2);

console.log("selftest ok: " + "75 项断言通过");
