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
