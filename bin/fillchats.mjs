import { WeChatAdapter } from "../lib/wechat.js";
import { loadState, saveState } from "../lib/state.js";

const im = new WeChatAdapter();
const r = await im.listChats(50);
if (!r.ok) {
  console.log("listChats failed:", r.error);
  process.exit(1);
}
const st = loadState();
st.chat_list = (r.items || []).map((c) => ({ chat_id: c.chat_id, name: c.name, kind: c.kind, member_count: c.member_count ?? 0 }));
st.scanned_at = new Date().toISOString();
st.scan_error = "";
saveState(st);
console.log("wrote chat_list:", st.chat_list.length, "first:", st.chat_list.slice(0, 3).map((c) => c.name).join(" | "));
