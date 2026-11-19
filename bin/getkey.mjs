#!/usr/bin/env node
// 抓微信 4.x 的数据库密钥（64 位 hex）—— 只在登录那一瞬命中。
//
// 用法：
//   1. 关掉微信
//   2. 先跑本脚本（它会等微信启动，150ms 重试贴 hook，抢在自动登录之前）
//   3. 打开微信并完成登录
//   4. 脚本打印 KEY=...，把 key 交给：
//        weflow-cli init --passphrase <key> -p "<微信数据目录>"
//
// 为什么不用 `weflow-cli init` 直接抓：它在微信已在运行时不会等待登录事件，
// 而微信 4.2 的自动登录只给几秒窗口；先挂 hook 再启动微信才抢得到。
// 也为什么不用 `weflow-cli dbkey`：dbkey 抓到 key 只打印、不落盘，init 不会复用它。

import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OUT = process.argv[2] || path.join(process.cwd(), "_key.txt");

function findKeyService() {
  if (process.env.WEFLOW_KEY_SERVICE && existsSync(process.env.WEFLOW_KEY_SERVICE)) return process.env.WEFLOW_KEY_SERVICE;
  let root;
  try {
    root = execSync("npm root -g", { encoding: "utf8" }).trim();
  } catch {
    root = "";
  }
  const candidates = [
    path.join(root, "weflow-cli", "dist", "src", "core", "keyService.js"),
    path.join(process.env.APPDATA || "", "npm", "node_modules", "weflow-cli", "dist", "src", "core", "keyService.js"),
  ];
  const hit = candidates.find((p) => p && existsSync(p));
  if (!hit) throw new Error("找不到 weflow-cli 的 keyService.js，先 npm i -g weflow-cli，或用 WEFLOW_KEY_SERVICE 指路");
  return hit;
}

const { keyService } = await import(pathToFileURL(findKeyService()).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("等着抓微信数据库密钥：现在去打开微信并登录（Ctrl+C 退出）");
for (let round = 1; round <= 200; round++) {
  const r = await keyService.autoGetDbKey(20000, () => {});
  if (r && r.success && r.key) {
    writeFileSync(OUT, r.key, "utf8");
    console.log("KEY=" + r.key);
    console.log("已写入 " + OUT);
    console.log('下一步：weflow-cli init --passphrase ' + r.key + ' -p "<微信数据目录>"');
    process.exit(0);
  }
  const err = String((r && r.error) || "");
  if (!err.includes("未找到微信进程") && round % 5 === 1) console.log("  " + err);
  await sleep(err.includes("未找到微信进程") ? 150 : 400);
}
console.error("一直没抓到：确认微信已登录，且是在脚本挂起之后才登录的");
process.exit(1);
