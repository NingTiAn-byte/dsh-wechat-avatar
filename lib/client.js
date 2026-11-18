// 浏览器端：在左侧栏注册一页「微信值守」，读写 config.json（走本机 /dsh-wechat-avatar/api）。
// 由 DSH 的 client 加载器执行（与 dsh-genui 同一套 __ModuleLoader__ 包装）。
window.__ModuleLoader__.load({
  id: "dsh-wechat-avatar",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const h = React.createElement;

    const PANEL_ID = "wechat-duty";
    const API = "/dsh-wechat-avatar/api";

    const S = {
      wrap: { padding: "20px 24px 40px", maxWidth: 760, display: "flex", flexDirection: "column", gap: 18 },
      h1: { fontSize: 18, fontWeight: 600, margin: 0 },
      sub: { fontSize: 12, opacity: 0.65, margin: 0, lineHeight: 1.7 },
      card: { border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.22))", borderRadius: 10, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 },
      cardTitle: { fontSize: 13, fontWeight: 600, margin: 0 },
      row: { display: "flex", alignItems: "center", gap: 10 },
      label: { fontSize: 12, opacity: 0.8, minWidth: 64 },
      input: { flex: 1, minWidth: 0, height: 30, padding: "0 10px", fontSize: 13, borderRadius: 6, border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.3))", background: "transparent", color: "inherit", outline: "none" },
      small: { fontSize: 11, opacity: 0.55 },
      table: { display: "flex", flexDirection: "column", gap: 8 },
      chatRow: { display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: "1px dashed rgba(128,128,128,.18)" },
      chatName: { fontSize: 13, width: 190, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      tag: { fontSize: 10, padding: "1px 6px", borderRadius: 4, background: "rgba(128,128,128,.16)", marginLeft: 6 },
      seg: { display: "flex", gap: 6 },
      segBtn: (on) => ({ fontSize: 12, padding: "4px 10px", borderRadius: 6, cursor: "pointer", border: "1px solid " + (on ? "var(--dsw-alias-brand-primary, #4d6bfe)" : "rgba(128,128,128,.3)"), background: on ? "rgba(77,107,254,.12)" : "transparent", color: "inherit" }),
      foot: { display: "flex", alignItems: "center", gap: 12 },
      save: { fontSize: 13, padding: "6px 16px", borderRadius: 6, cursor: "pointer", border: "none", background: "var(--dsw-alias-brand-primary, #4d6bfe)", color: "#fff" },
      ghost: { fontSize: 13, padding: "6px 14px", borderRadius: 6, cursor: "pointer", border: "1px solid rgba(128,128,128,.3)", background: "transparent", color: "inherit" },
      note: { fontSize: 12, opacity: 0.75 },
    };

    function WechatIcon() {
      return h(
        "svg",
        { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
        h("path", { d: "M4 5h16v11H9l-4 3z" }),
        h("path", { d: "M8 9h8M8 12h5" })
      );
    }

    const split = (v) => String(v || "").split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);
    const GATE_CN = { always: "不设门槛", mention: "必须@我", mention_only: "必须@我", off: "不值守" };
    const DM_OPTS = ["always", "mention", "off"];
    const GROUP_OPTS = ["mention_only", "always", "off"];

    function Seg(props) {
      return h(
        "div",
        { style: S.seg },
        props.options.map((v) =>
          h(
            "button",
            { key: v, type: "button", style: S.segBtn(props.value === v), onClick: () => props.onChange(v) },
            GATE_CN[v] || v
          )
        )
      );
    }

    function WechatPanel() {
      const [cfg, setCfg] = React.useState(null);
      const [chats, setChats] = React.useState([]);
      const [who, setWho] = React.useState(null);
      const [note, setNote] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [draft, setDraft] = React.useState({});   // 每个工作区里「新任务」输入框的草稿

      const load = React.useCallback(async () => {
        setBusy(true);
        try {
          const r = await fetch(API + "/config", { credentials: "same-origin" });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || "加载失败");
          setCfg(j.config);
          setChats(j.chats || []);
          setWho(j.who || null);
          setNote("");
        } catch (e) {
          setNote("加载失败：" + ((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      }, []);
      React.useEffect(() => {
        load();
      }, [load]);

      if (!cfg) return h("div", { style: { padding: 24, opacity: 0.6 } }, busy ? "加载中…" : note || "没有可用的配置");

      const self = cfg.self || {};
      const policy = cfg.policy || {};
      const poll = cfg.poll || {};
      const byChat = self.byChat || {};

      const patchCfg = (fn) => setCfg((c) => fn(c));
      const setNames = (v) => patchCfg((c) => ({ ...c, self: { ...(c.self || {}), names: split(v) } }));
      const setNameFor = (id, v) => patchCfg((c) => ({ ...c, self: { ...(c.self || {}), byChat: { ...((c.self || {}).byChat || {}), [id]: split(v) } } }));
      const setPolicy = (k, v) => patchCfg((c) => ({ ...c, policy: { ...(c.policy || {}), [k]: v } }));
      const setPollSec = (v) => patchCfg((c) => ({ ...c, poll: { ...(c.poll || {}), sec: Number(v) || 0 } }));

      const rows = [];
      const seen = new Set();
      for (const chat of chats) {
        rows.push(chat);
        seen.add(chat.chat_id);
      }
      for (const id of Object.keys(byChat)) if (!seen.has(id)) rows.push({ chat_id: id, name: id, kind: "?" });

      // —— 工作区与任务：改完立即落盘，不用等「保存」
      const call = async (path, body) => {
        setBusy(true);
        try {
          const r = await fetch(API + path, {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || "操作失败");
          setCfg(j.config);
          setNote("已更新");
          return j;
        } catch (e) {
          setNote("操作失败：" + ((e && e.message) || e));
          return null;
        } finally {
          setBusy(false);
        }
      };
      const workspaces = cfg.workspaces || [];
      const setWsLocal = (id, patch) => patchCfg((c) => ({ ...c, workspaces: (c.workspaces || []).map((w) => (w.id === id ? { ...w, ...patch } : w)) }));
      const wsAdd = () => call("/workspace", { action: "add", name: "新工作区", chats: [] });
      const wsUpdate = (id, patch) => call("/workspace", { action: "update", id, ...patch });
      const wsRemove = (id) => call("/workspace", { action: "remove", id });
      const taskAdd = (wsId, title) => call("/task", { action: "add", wsId, title });
      const taskStatus = (wsId, taskId, status) => call("/task", { action: "status", wsId, taskId, status });
      const taskRemove = (wsId, taskId) => call("/task", { action: "remove", wsId, taskId });

      const save = async () => {
        setBusy(true);
        try {
          const r = await fetch(API + "/config", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              self: { names: self.names || [], byChat },
              policy: { dm: policy.dm, group: policy.group, nick: policy.nick !== false, overrides: policy.overrides || {} },
              poll: { sec: poll.sec, jitter: poll.jitter, backoff_max_sec: poll.backoff_max_sec },
              workspaces: cfg.workspaces || [],
            }),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || "保存失败");
          setCfg(j.config);
          setNote("已保存，下一轮轮询（≤" + String((j.config.poll && j.config.poll.sec) ?? 60) + " 秒）生效");
        } catch (e) {
          setNote("保存失败：" + ((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      };

      return h(
        "div",
        { style: S.wrap },
        h("div", null,
          h("h1", { style: S.h1 }, "微信值守"),
          h("p", { style: S.sub }, "决定哪些微信消息算「派给我的活」。群里除了 @ 我，直接喊下面的称呼也算。")
        ),
        h("p", { style: S.sub }, "本人：" + ((who && (who.self_name || who.self_id)) || "（还没扫描过，跑一轮 wechat_duty_scan 后这里会显示昵称）")),

        h("div", { style: S.card },
          h("h2", { style: S.cardTitle }, "全局称呼"),
          h("div", { style: S.row },
            h("span", { style: S.label }, "所有会话"),
            h("input", { style: S.input, value: (self.names || []).join(", "), placeholder: "李雷, 雷哥（逗号分隔）", onChange: (e) => setNames(e.target.value) })
          ),
          h("div", { style: S.small }, "微信昵称会自动并入；「我 / 你 / 大家」这类泛称和单字名会被判定层忽略。")
        ),

        h("div", { style: S.card },
          h("h2", { style: S.cardTitle }, "每个群怎么叫我"),
          rows.length === 0
            ? h("div", { style: S.small }, "还没有会话列表：先跑一轮扫描，或直接在下面按 chat_id 添加。")
            : h("div", { style: S.table },
                rows.map((chat) =>
                  h("div", { key: chat.chat_id, style: S.chatRow },
                    h("span", { style: S.chatName, title: chat.chat_id },
                      chat.name || chat.chat_id,
                      h("span", { style: S.tag }, chat.kind === "dm" ? "私聊" : chat.kind === "group" ? "群聊" : "未知")
                    ),
                    h("input", {
                      style: S.input,
                      value: (byChat[chat.chat_id] || []).join(", "),
                      placeholder: "这个群里别人怎么叫我（可空）",
                      onChange: (e) => setNameFor(chat.chat_id, e.target.value),
                    })
                  )
                )
              ),
          h("div", { style: S.small }, "只在对应的群里生效；空着就用全局称呼。")
        ),

        h("div", { style: S.card },
          h("h2", { style: S.cardTitle }, "什么才算派活"),
          h("div", { style: S.row }, h("span", { style: S.label }, "私聊"), h(Seg, { options: DM_OPTS, value: policy.dm || "always", onChange: (v) => setPolicy("dm", v) })),
          h("div", { style: S.row }, h("span", { style: S.label }, "群聊"), h(Seg, { options: GROUP_OPTS, value: policy.group || "mention_only", onChange: (v) => setPolicy("group", v) })),
          h("div", { style: S.row },
            h("span", { style: S.label }, "喊昵称"),
            h("button", { type: "button", style: S.segBtn(policy.nick !== false), onClick: () => setPolicy("nick", !(policy.nick !== false)) }, policy.nick !== false ? "算（不用@" : "不算"),
            h("span", { style: S.small }, "关掉后群聊只认 @我")
          ),
          h("div", { style: S.row },
            h("span", { style: S.label }, "轮询间隔"),
            h("input", { style: { ...S.input, maxWidth: 100 }, type: "number", min: 0, step: 10, value: poll.sec ?? 60, onChange: (e) => setPollSec(e.target.value) }),
            h("span", { style: S.small }, "秒；0 = 关掉自动轮询")
          )
        ),

        h("div", { style: S.card },
          h("div", { style: S.row },
            h("h2", { style: S.cardTitle }, "工作区与任务"),
            h("span", { style: S.small }, "判定为「派给我的活」的消息会自动进绑定了该会话的工作区")
          ),
          workspaces.length === 0
            ? h("div", { style: S.small }, "还没有工作区。点下面新建，把群 chat_id 或群名填进「绑定会话」，之后这个群里派给你的活就会自动落到这里。")
            : null,
          workspaces.map((ws) =>
            h("div", { key: ws.id, style: { ...S.card, padding: "10px 12px", gap: 8 } },
              h("div", { style: S.row },
                h("input", {
                  style: S.input,
                  value: ws.name,
                  onChange: (e) => setWsLocal(ws.id, { name: e.target.value }),
                  onBlur: () => wsUpdate(ws.id, { name: ws.name }),
                }),
                h("span", { style: S.small }, (ws.tasks || []).length + " 条任务"),
                h("button", { type: "button", style: S.ghost, disabled: busy, onClick: () => wsRemove(ws.id) }, "删除")
              ),
              h("div", { style: S.row },
                h("span", { style: S.label }, "绑定会话"),
                h("input", {
                  style: S.input,
                  value: (ws.chats || []).join(", "),
                  placeholder: "chat_id 或群名，逗号分隔",
                  onChange: (e) => setWsLocal(ws.id, { chats: split(e.target.value) }),
                  onBlur: () => wsUpdate(ws.id, { chats: ws.chats }),
                })
              ),
              h("div", { style: S.table },
                (ws.tasks || []).length === 0
                  ? h("div", { style: S.small }, "暂无任务；群里派给你的活会自动出现在这里，也可以下面手工加。")
                  : (ws.tasks || []).map((t) =>
                      h("div", { key: t.id, style: S.chatRow },
                        h("button", {
                          type: "button",
                          style: S.segBtn(t.status === "done"),
                          title: t.status === "done" ? "标记未完成" : "标记完成",
                          onClick: () => taskStatus(ws.id, t.id, t.status === "done" ? "todo" : "done"),
                        }, t.status === "done" ? "✓" : "○"),
                        h("span", { style: { flex: 1, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textDecoration: t.status === "done" ? "line-through" : "none" } }, t.title),
                        h("span", { style: S.small }, ((t.source && t.source.chat_name) || "") + (t.deadline ? " · " + t.deadline : "")),
                        h("button", { type: "button", style: S.ghost, disabled: busy, onClick: () => taskRemove(ws.id, t.id) }, "×")
                      )
                    )
              ),
              h("div", { style: S.row },
                h("input", {
                  style: S.input,
                  value: draft[ws.id] || "",
                  placeholder: "手工加一条任务，回车保存",
                  onChange: (e) => setDraft({ ...draft, [ws.id]: e.target.value }),
                  onKeyDown: (e) => {
                    const v = String(draft[ws.id] || "").trim();
                    if (e.key === "Enter" && v) {
                      taskAdd(ws.id, v).then(() => setDraft({ ...draft, [ws.id]: "" }));
                    }
                  },
                })
              )
            )
          ),
          h("button", { type: "button", style: S.ghost, disabled: busy, onClick: wsAdd }, "＋ 新建工作区")
        ),

        h("div", { style: S.foot },
          h("button", { type: "button", style: S.save, disabled: busy, onClick: save }, busy ? "处理中…" : "保存"),
          h("button", { type: "button", style: S.ghost, disabled: busy, onClick: load }, "重新读取"),
          h("span", { style: S.note }, note)
        )
      );
    }

    function apply(ctx) {
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 25, label: () => "微信值守" }, WechatIcon)
      );
      ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID }, WechatPanel));
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
