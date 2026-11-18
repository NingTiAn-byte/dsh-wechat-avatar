#!/usr/bin/env node
// 管理「每个群里别人怎么叫我」。改的是 config.json 的 self.names（全局）和 self.byChat（按群）。
//   node bin/names.js                              列出当前配置
//   node bin/names.js --add chat_proj:雷哥,老李     给某个群加称呼
//   node bin/names.js --rm chat_proj:老李           从某个群删称呼
//   node bin/names.js --global-add 李雷             加全局称呼（所有群都认）
//   node bin/names.js --global-rm 李雷              删全局称呼
import { loadConfig, saveConfig } from "../lib/config.js";

const argv = process.argv.slice(2);
const cfg = loadConfig();
cfg.self = { names: [], byChat: {}, ...(cfg.self || {}) };
const split = (s) => String(s || "").split(/[,，\/]/).map((x) => x.trim()).filter(Boolean);
const uniq = (arr) => [...new Set(arr)];

function readPair(flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  const raw = argv[i + 1] || "";
  const k = raw.indexOf(":");
  if (k < 0) return { chat: "", names: split(raw) };
  return { chat: raw.slice(0, k), names: split(raw.slice(k + 1)) };
}

let changed = false;
const add = readPair("--add");
if (add) {
  if (!add.chat) { console.error("--add 要写成 chat_id:名字1,名字2"); process.exit(2); }
  cfg.self.byChat[add.chat] = uniq([...(cfg.self.byChat[add.chat] || []), ...add.names]);
  changed = true;
}
const rm = readPair("--rm");
if (rm) {
  if (!rm.chat) { console.error("--rm 要写成 chat_id:名字"); process.exit(2); }
  cfg.self.byChat[rm.chat] = (cfg.self.byChat[rm.chat] || []).filter((n) => !rm.names.includes(n));
  if (!cfg.self.byChat[rm.chat].length) delete cfg.self.byChat[rm.chat];
  changed = true;
}
const ga = argv.indexOf("--global-add");
if (ga >= 0) { cfg.self.names = uniq([...cfg.self.names, ...split(argv[ga + 1])]); changed = true; }
const gr = argv.indexOf("--global-rm");
if (gr >= 0) {
  const drop = split(argv[gr + 1]);
  cfg.self.names = cfg.self.names.filter((n) => !drop.includes(n));
  changed = true;
}

if (changed) {
  const file = saveConfig(cfg);
  console.log("已写入 " + file);
}

console.log("全局（所有群都认）：" + (cfg.self.names.length ? cfg.self.names.join(" / ") : "（空）"));
const ids = Object.keys(cfg.self.byChat);
if (!ids.length) console.log("按群配置：无");
for (const id of ids) console.log("  " + id + " → " + cfg.self.byChat[id].join(" / "));
console.log("");
console.log("提示：微信昵称（whoami）会自动并入名单；泛称（我/你/大家…）和单字名会被判定层忽略。");
