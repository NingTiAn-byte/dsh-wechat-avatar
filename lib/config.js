// 值守策略：私聊默认「收到就算活」，群聊默认「@我才算活」。
// 改 config.json 或命令行参数都行，优先级：命令行 > config.json > 内置默认。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeWorkspaces } from "./workspaces.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const CONFIG_PATH = path.join(ROOT, "config.json");

export const DEFAULT_CONFIG = {
  self: {
    id: "",                // 自己的 wxid；留空就每次从 config show 里抠，填了能省一次调用
    names: [],             // 全局称呼（所有群都认），会自动并入 whoami 拿到的昵称
    byChat: {},            // 按群补充：{ "chat_id": ["雷哥", "老李"] }，和全局取并集
  },
  policy: {
    dm: "always",          // always | mention | off
    group: "mention_only", // always | mention_only | off
    nick: true,            // 群聊里不用 @，直接喊昵称也算叫我
    overrides: {},         // { "chat_id": "always" | "mention_only" | "off" }
  },
  poll: { sec: 60, jitter: 0.15, backoff_max_sec: 600 },
  // 监听范围：空 = 全部会话；非空 = 只扫这些（chat_id 或群名都认）
  watch: [],

  // 发送政策：默认不发。review=true 表示任何发送都必须人工点一次确认；allow=false 是硬闸，
  // 打开它也只意味着「允许走人工确认」，不代表会出现自动回复。当前代码没有发送路径。
  send: { allow: false, review: true },
  // 自动交给 DSH：auto=true 时，扫到「派给我的活」就自动开一个会话让 agent 干，
  // 干完把它的最终回复写回任务（管理页里复制到微信）。默认关，先看着它跑。
  handoff: { auto: true, maxPerScan: 2 },
  // AI 复核：规则先判，再把「像活」的消息连同会话上下文交给 agent 再看一眼。
  // 默认关——它会开一个 DSH 会话、慢一点、费 token；打开后 AI 说不是活的任务会被自动丢掉。
  ai: { enabled: false, perRound: 8 },
  // 回答性质的工作（别人问个东西）：自动从知识库 + 上下文里找答案写成回执，不发送
  answer: { auto: false },   // 默认不自动答：只有我本人知道的信息，得我自己补
  // 自动归组：扫到派给我的活、而这个会话还没有任务组时，按群名/昵称自动建一个组收进来
  group_auto: true,
  // 新建任务组默认用的 DSH 工作区（id + 目录）；留空就放在默认位置
  default_dsh_workspace: "",
  default_dsh_workspace_path: "",
  // 工作区：{ id, name, chats: [chat_id], tasks: [{ id, title, status, source, deadline, ... }] }
  // chats 里任一会话判定为「派给我的活」时，任务自动进这个工作区
  workspaces: [],
};

export function loadConfig(file = CONFIG_PATH) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      ...DEFAULT_CONFIG, ...j,
      self: { ...DEFAULT_CONFIG.self, ...(j.self || {}) },
      policy: { ...DEFAULT_CONFIG.policy, ...(j.policy || {}) },
      poll: { ...DEFAULT_CONFIG.poll, ...(j.poll || {}) },
      send: { ...DEFAULT_CONFIG.send, ...(j.send || {}) },
      handoff: { ...DEFAULT_CONFIG.handoff, ...(j.handoff || {}) },
      ai: { ...DEFAULT_CONFIG.ai, ...(j.ai || {}) },
    answer: { ...DEFAULT_CONFIG.answer, ...(j.answer || {}) },
      watch: Array.isArray(j.watch) ? j.watch.map((x) => String(x ?? "").trim()).filter(Boolean) : [],
      workspaces: normalizeWorkspaces(j.workspaces),
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

export function saveConfig(cfg, file = CONFIG_PATH) {
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  return file;
}

const DM_VALUES = { always: "always", on: "always", yes: "always", mention: "mention", mention_only: "mention", off: "off", no: "off" };
const GROUP_VALUES = { always: "always", all: "always", on: "always", mention: "mention_only", mention_only: "mention_only", off: "off", no: "off" };
const NICK_VALUES = { on: true, yes: true, true: true, off: false, no: false, false: false };

/** 从 argv 里读 --dm=always / --group=mention_only 这类覆盖 */
export function applyCliOverrides(cfg, argv = []) {
  const out = JSON.parse(JSON.stringify(cfg));
  for (const a of argv) {
    const m = /^--(dm|group|nick)=(.+)$/.exec(a);
    if (!m) continue;
    const [, key, raw] = m;
    if (key === "nick") {
      const v = NICK_VALUES[String(raw).toLowerCase()];
      if (v !== undefined) out.policy.nick = v;
      continue;
    }
    const table = key === "dm" ? DM_VALUES : GROUP_VALUES;
    const v = table[String(raw).toLowerCase()];
    if (v) out.policy[key] = v;
  }
  return out;
}
