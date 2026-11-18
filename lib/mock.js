// 示例数据：本机没有 weflow-cli，也没登录微信，这里全部是编造的消息，仅用于跑通判定逻辑。
// kind 决定闸门：dm = 私聊（发来就算活），group = 群聊（@我才算）。

export const MOCK_SELF = { self_id: "wxid_me", self_name: "李雷" };

export const MOCK_CHATS = [
  { chat_id: "chat_proj", name: "项目协作群", kind: "group", member_count: 9 },
  { chat_id: "chat_li", name: "李娜", kind: "dm", member_count: 2 },
  { chat_id: "chat_cust", name: "客户-李总", kind: "dm", member_count: 2 },
  { chat_id: "chat_ops", name: "运维值班群", kind: "group", member_count: 12 },
];

const day = "2026-11-17";

export const MOCK_MESSAGES = {
  chat_proj: [
    { local_id: "p1", sender: "wxid_zhang", sender_name: "张伟", content: "早上好", ts: day + "T09:12:00+08:00" },
    { local_id: "p2", sender: "wxid_li", sender_name: "李娜", content: "@李雷 帮我把上周的周报汇总一下，今天下班前给我", ts: day + "T09:20:00+08:00" },
    { local_id: "p3", sender: "wxid_wang", sender_name: "王强", content: "这个接口文档谁更新下", ts: day + "T09:31:00+08:00" },
    { local_id: "p4", sender: "wxid_me", sender_name: "李雷", content: "收到", ts: day + "T09:40:00+08:00" },
    { local_id: "p5", sender: "wxid_li", sender_name: "李娜", content: "@张三 你那边日志排查得怎么样了", ts: day + "T10:02:00+08:00" },
    { local_id: "p6", sender: "wxid_zhang", sender_name: "张伟", content: "你在吗？客户要一份数据导出，明天上午要", ts: day + "T10:15:00+08:00" },
    { local_id: "p7", sender: "wxid_wang", sender_name: "王强", content: "会议纪要已发群里", ts: day + "T10:22:00+08:00" },
    { local_id: "p8", sender: "wxid_zhang", sender_name: "张伟", content: "雷哥，帮我看下导出脚本，明天要一份", ts: day + "T10:40:00+08:00" },
  ],
  chat_ops: [
    { local_id: "o1", sender: "wxid_zhao", sender_name: "赵敏", content: "老李，周末的排班表明天发我一下", ts: day + "T09:50:00+08:00" },
    { local_id: "o2", sender: "wxid_zhao", sender_name: "赵敏", content: "雷哥今天请假了？", ts: day + "T09:55:00+08:00" },
  ],
  chat_li: [
    { local_id: "l1", sender: "wxid_li", sender_name: "李娜", content: "周报模板发我一份", ts: day + "T08:40:00+08:00" },
    { local_id: "l2", sender: "wxid_li", sender_name: "李娜", content: "另外那个接口你什么时候能好", ts: day + "T09:05:00+08:00" },
    { local_id: "l3", sender: "wxid_me", sender_name: "我", content: "下午", ts: day + "T09:06:00+08:00" },
  ],
  chat_cust: [
    { local_id: "c1", sender: "wxid_li2", sender_name: "李总", content: "那个报表明天能给我吗？客户那边催得紧", ts: day + "T08:55:00+08:00" },
    { local_id: "c2", sender: "wxid_me", sender_name: "我", content: "今天下午给您", ts: day + "T09:01:00+08:00" },
    { local_id: "c3", sender: "wxid_li2", sender_name: "李总", content: "好的谢谢", ts: day + "T09:02:00+08:00" },
  ],
};
