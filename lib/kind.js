// 工作边界：一条消息属于哪一类。
//   chatter   —— 寒暄/点头（收到、好的、在吗、👌…）：不落任务、不提醒
//   needs_you —— 问的是只有我本人知道的信息（上次定的口径、多少钱、你那边…）：
//                落任务但标「等你补信息」，不自动答
//   task      —— 要动手做的事：正常自动交给 DSH

const ACK_WORDS = /^(收到|好|好的|好滴|好嘞|行|可以|没问题|嗯+|哦+|噢+|啊+|谢谢|感谢|辛苦了|在吗|在么|在不在|哈+|哈哈+|👌|👍|ok|okay|明白|了解|晓得)$/i;
const ACK_WORDS_G = /(收到|好的|好滴|好嘞|好啊|行|可以|没问题|嗯+|哦+|噢+|啊+|谢谢|感谢|辛苦了|在吗|在么|在不在|哈+|👌|👍|ok|okay|明白|了解|晓得)/gi;
const ACK_TAIL = /^(收到|好的|好嘞|嗯+|哦+|ok|okay|谢谢)[。.!！~～]*$/i;
const TASK_HINTS = /(写|做个|做一个|做份|做一版|整理|汇总|导出|生成|改一下|改下|修改|调整|翻译|排版|画个|画一画|设计|调试|排查|修复|重构|部署|上线|跑一下|执行一下|实现|搭个|接一下|并进|合并|补充|更新|提交|发我|发一下)/;
const TASK_NOUNS = /(方案|文档|表格|ppt|幻灯片|代码|脚本|报告|总结|复盘|清单|流程图|思维导图|验收单|合同)/i;
const ASK_HINTS = /(吗|么|嘛|呢|？|\?|多少|几点|什么时候|哪天|在哪|哪里|哪儿|谁|几个人|能不能|可不可以|有没有|是不是|行不行|对不对|如何|怎么|为什么|为啥|啥|什么)/;
// 只有本人知道的信息：问这些的时候，别人要的是「你那边的事实」，不是通用知识
const PERSONAL_HINTS = /(上次|上回|之前|我们(说|定|约定|讲|聊)|你(们)?(那边|说的|定的|上次|之前)|你们|口径|多少钱|价格|报价|折扣|预算|谁负责|哪天交|多久能|周期)/;

/**
 * @param {string} text 消息原文（或规则抽出来的任务标题）
 * @returns {{ kind: "chatter"|"needs_you"|"task", reason: string }}
 */
export function classify(text) {
  const s = String(text == null ? "" : text).trim();
  if (!s) return { kind: "task", reason: "空内容，按任务处理" };
  const short = s.replace(/[\s，。,.!！~～、]/g, "");
  if (short.length > 0 && short.length <= 12) {
    const rest = short.replace(ACK_WORDS_G, "");
    if (rest.length === 0) return { kind: "chatter", reason: "寒暄/点头，不是活" };
  }
  if (short.length > 0 && short.length <= 12 && ACK_TAIL.test(short)) {
    return { kind: "chatter", reason: "寒暄/点头，不是活" };
  }
  if (TASK_HINTS.test(s) || TASK_NOUNS.test(s)) return { kind: "task", reason: "有动手做的说法" };
  if (ASK_HINTS.test(s)) {
    if (PERSONAL_HINTS.test(s)) return { kind: "needs_you", reason: "问的是只有本人知道的信息" };
    return { kind: "task", reason: "在问怎么做/什么情况，当活处理" };
  }
  return { kind: "task", reason: "不像提问，按任务处理" };
}
