// 监听节奏：默认 60 秒一轮，带 ±15% 抖动（免得整点撞车），失败指数退避到 10 分钟封顶。
// 为什么是 60 秒：weflow 是拉本地 SQLCipher 库，一次查询是毫秒级，60 秒对磁盘和 CPU 都无感；
// 再快没意义（微信消息本身就是秒级到达，但没人指望 5 秒内被派活），再慢就"人在群里等了十分钟没人应"。

export const DEFAULT_POLL = {
  sec: 60,            // 基础间隔秒；0 = 不自动轮询，只能手动调工具
  jitter: 0.15,       // 上下浮动比例
  backoffMaxSec: 600, // 连续失败时的最大退避
  maxFails: 6,        // 退避封顶的失败次数（2^6 * 60 已经远超 600）
  minSec: 20,         // 允许的最小间隔，防止有人设成 1 秒把 CLI 打爆
};

export function normalizePoll(poll = {}) {
  return { ...DEFAULT_POLL, ...poll, sec: Number(poll.sec ?? DEFAULT_POLL.sec) };
}

/** 下一次该等多久（毫秒） */
export function nextDelay(fails = 0, poll = DEFAULT_POLL, rand = Math.random) {
  const p = normalizePoll(poll);
  if (!p.sec) return 0;
  const base = Math.max(p.minSec, p.sec);
  const backed = Math.min(p.backoffMaxSec, base * Math.pow(2, Math.min(p.maxFails, Number(fails) || 0)));
  const factor = 1 + (rand() * 2 - 1) * p.jitter;
  return Math.max(1000, Math.round(backed * factor * 1000));
}

/** 一轮结束后的失败计数 */
export function nextFails(prevFails = 0, ok = true) {
  return ok ? 0 : Math.min(DEFAULT_POLL.maxFails, (Number(prevFails) || 0) + 1);
}

export function describePoll(poll = DEFAULT_POLL) {
  const p = normalizePoll(poll);
  if (!p.sec) return "不自动轮询（手动调用）";
  return "每 " + p.sec + " 秒一轮（抖动 ±" + Math.round(p.jitter * 100) + "%，失败退避至多 " + Math.round(p.backoffMaxSec / 60) + " 分钟）";
}
