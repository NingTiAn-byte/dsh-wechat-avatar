# dsh-wechat-avatar

微信版「IM 值守」最小 demo。目标不是再造一个 cyber-im-avatar，而是把它最贵的那层——**平台适配**——换成微信，其余（会话绑定、打断、面板）将来照抄。

## 现在能做什么

```bash
node bin/demo.js --mock        # 离线跑判定，示例数据
node bin/demo.js               # live：调本机 weflow-cli 拉真实群消息
```

输出三档：`PASS`（这条是派给我的活）、`REPLY`（有人在等我回话）、`--`（无关）。

```bash
node bin/selftest.js           # 12 条断言，改规则后先跑
```

本机实测（2026-11-17，示例数据）：

```
[项目协作群] 拉到 7 条，新增 7 条
  --    conf=0.2   张伟：早上好
  PASS  conf=0.9   李娜：@我 帮我把上周的周报汇总一下，今天下班前给我
         任务=帮我把上周的周报汇总一下，今天下班前给我  期限=今天
  --    conf=0.35  王强：这个接口文档谁更新下
  --    conf=0     我：收到
  --    conf=0.1   李娜：@张三 你那边日志排查得怎么样了
  PASS  conf=0.7   张伟：你在吗？客户要一份数据导出，明天上午要
         任务=你在吗？客户要一份数据导出，明天上午要  期限=明天
[客户-李总] 拉到 2 条，新增 2 条
  REPLY conf=0.3   李总：你们那个报表什么时候能好？
```

第二次跑：`新增 0 条`，去重生效。

> 本机 PATH 里没有 node，用 DSH 自带的：`resources/runtime/primary-runtime/dependencies/node/bin/node.exe`。

判定完全靠规则（`lib/judge.js`）：被 @ / 直接称「你」/ 派活动词 / 期限词 / 疑问句加权，阈值 0.6。
**先规则后模型**——误判的代价是替你答应了一件你没答应的事。

## 监听节奏（多久看一次）

默认 **60 秒一轮**，写在 [config.json](config.json) 的 `poll` 里：

```json
{ "poll": { "sec": 60, "jitter": 0.15, "backoff_max_sec": 600 } }
```

- 为什么是 60 秒：weflow 读的是本地 SQLCipher 库，一次查询毫秒级，60 秒对磁盘和 CPU 无感；再快没意义（没人指望 5 秒内被派活），再慢就"群里等十分钟没人应"。
- **抖动 ±15%**：不整点轮询，避免和其他定时任务撞车。
- **失败退避**：连续失败按 2^n 拉长——1 次 2 分钟、3 次 8 分钟、封顶 10 分钟；成功一轮立刻回到 60 秒。
- `sec: 0` 关掉自动轮询，只保留手动 `wechat_duty_scan`。
- 间隔下限 20 秒，防止把 CLI 打爆。

和 dsh-cyber-im-avatar 的差异：它分「值守快车道 60s + 发现慢车道 10 分钟」，我们只有一条车道（读本地库，没必要分快慢）。真要秒级，得挂 iLink Bot 长轮询（`weflow-cli assistant start`），那是另一条路。

## 左侧栏管理页

装进 DSH 后，左侧栏会多一个「微信值守」入口，点开就是一页配置界面：

- **全局称呼**：一行逗号分隔，所有会话通用。
- **每个群怎么叫我**：按会话列出来，每行一个输入框；会话列表来自上一轮扫描（`state.chat_list`），不用手抄 chat_id。
- **什么才算派活**：私聊 / 群聊三态切换、「喊昵称算不算」开关、轮询间隔。
- **保存**立即写回 [config.json](config.json)，下一轮轮询（≤ 间隔秒）生效；「重新读取」重新拉配置。

### 工作区与任务

管理页最后一块是「工作区与任务」。一个工作区 = 一组会话 + 一批任务。

- **绑定**：把群 chat_id 或群名填进「绑定会话」（逗号分隔）。绑定之后，这个群里判定为「派给我的活」的消息会**自动变成工作区里的一条待办**，带上来源群、期限、置信度。
- **去重**：同一条消息（msg_id）只进一次；第二轮扫描没有新消息就不会重复记。
- **手工**：输入框回车加一条任务；○/✓ 切换完成；× 删除。改完立即落盘，不用等「保存」。
- **落盘位置**：`config.json` 的 `workspaces: [{ id, name, chats: [...], tasks: [...] }]`，任务上限 200 条/工作区。
- **数据层**：[lib/workspaces.js](dsh-wechat-avatar/lib/workspaces.js) 纯函数（normalize / addTask / setTaskStatus / stats），不碰 io，好单测。
- **接口**：
  - `POST /dsh-wechat-avatar/api/workspace` → `{action: "add"|"update"|"remove", id, name, chats}`
  - `POST /dsh-wechat-avatar/api/task` → `{action: "add"|"status"|"remove", wsId, taskId, title, status}`

扫描时宿主半（[lib/index.js](dsh-wechat-avatar/lib/index.js)）用 `workspaceFor()` 按 chat_id **或群名**匹配工作区，命中才记任务；没绑定任何工作区的群照常判定，只是不落任务。

### 装法

```bash
dsh plugin --profile desktop add link:D:/项目/dsh-wechat-avatar
```

然后**完全退出并重启 DSH**（客户端插件在启动时加载，热刷新不会生效）。

### 实现方式（改代码时看这里）

- 宿主半 [lib/index.js](dsh-wechat-avatar/lib/index.js) 用 `ctx.inject(["webServer"], ...)` 注册前缀路由 `/dsh-wechat-avatar`，处理函数在 [lib/api.js](dsh-wechat-avatar/lib/api.js)：
  - `GET /dsh-wechat-avatar/api/config` → `{ config, chats, who }`
  - `POST /dsh-wechat-avatar/api/config` → 只接受白名单字段，越界丢弃，深合并后落盘
  - 仅回环地址 + 同源 Origin 可访问
- 浏览器半 [lib/client.js](dsh-wechat-avatar/lib/client.js) 用 `ctx.slots.register` 注册两处：
  - `sidebar.panellist`（`id: wechat-duty`）→ 左侧栏图标 + 标题
  - `main`（`key: wechat-duty`）→ 选中后主区域渲染的页面
  - 包在 `window.__ModuleLoader__.load({...})` 里，和 `dsh-genui` 的客户端包同一格式；`package.json` 的 `dsh.client` 声明 `platform: web`、`inject` 依赖 `@deepseek-ai/dsh-client-ui-sidebar`。

> ⚠️ 这一层**没有在本机真机验证过**：client 包需要 DSH 客户端加载器在启动时装配，本机没有把插件装进 profile（装了要重启，会中断当前会话）。格式与注册方式是从已装的 `dsh-genui` / `plugin-manager` 源码里反推的。装完如果左侧栏没出现图标，先看 DSH 的开发者控制台有没有加载 `dsh-wechat-avatar/client` 的报错。

## 每个群里的称呼（可编辑）

同一个工位，不同群里叫法不一样：项目群叫「雷哥」，运维群叫「老李」，客户群叫「李工」。所以名单分两层：

```json
{
  "self": {
    "names": ["李雷"],
    "byChat": {
      "chat_proj": ["雷哥"],
      "chat_ops": ["老李"]
    }
  },
  "policy": { "nick": true }
}
```

- `self.names` **全局**：所有会话都认，一般放真名或微信昵称。
- `self.byChat` **按群**：只在那一个 `chat_id`（或群名）里生效，和全局取**并集**，不是覆盖。
- 微信昵称（`whoami`）自动并入，不用手填。
- 判定时统一过一遍：泛称（我/你/大家…）和单字名会被丢掉，所以就算误填也不会把「我明天看一下」判成在叫你。

不用手改 JSON 也行，用命令行（[bin/names.js](bin/names.js)）：

```bash
node bin/names.js                          # 看当前名单
node bin/names.js --add chat_proj:雷哥,老雷   # 给项目群加称呼
node bin/names.js --rm chat_proj:老雷         # 删掉一个
node bin/names.js --global-add 李雷          # 加全局
node bin/names.js --global-rm 李雷           # 删全局
```

## 群里喊我昵称也算派活

群里没人 @ 你，只是直接喊名字——「李雷，帮我看下导出脚本」——以前会被判成"没点我"，现在算。

配置在 [config.json](config.json)：

```json
{
  "self": { "names": ["李雷", "雷哥"] },
  "policy": { "nick": true }
}
```

- `self.names` 是"别人会怎么叫我"，会跟 `whoami` 拿到的微信昵称合并去重，所以真机上通常只补别名就行。
- `policy.nick: true` 默认开；设 `false`（或命令行 `--nick=off`）后只认 @。
- 置信度：@我 0.80 起，喊昵称 0.76 起（比 @ 低一点，因为同名/称呼被顺手带一句的概率更高），都随派活动词 +0.10、期限 +0.05。

**三条防误判的护栏**：

1. **泛称不当昵称**：`我 / 你 / 他 / 我们 / 大家 / 本人` 这类词会被剔除。否则一句「我明天看一下」就会被判成在叫你。
2. **单字不参与**：长度 < 2 的名字（如「雷」）不匹配裸称呼，只认 `@雷`。一个字满屏都是。
3. **@了别人 + 同时喊我**：算叫我（「@张三 李雷那边你来对接下」）；只 @ 了别人、没喊我，仍然不算——这条优先于昵称。

## 值守策略（谁说的话算"派活"）

默认就是你要的规则，写在 [config.json](config.json)：

```json
{
  "self": { "names": ["李雷"], "byChat": { "chat_proj": ["雷哥"], "chat_ops": ["老李"] } },
  "policy": { "dm": "always", "group": "mention_only", "nick": true, "overrides": {} },
  "poll": { "sec": 60, "jitter": 0.15, "backoff_max_sec": 600 }
}
```

| 键 | 取值 | 含义 |
|---|---|---|
| `dm` | `always`（默认） | 私聊发来一段话就当活，不看 @ |
|  | `mention` | 私聊也要求 @我 |
|  | `off` | 不看私聊 |
| `group` | `mention_only`（默认） | 群里必须 @我 才算活，没 @ 的一律不算 |
|  | `always` | 群里说话就算（会误判，慎用） |
|  | `off` | 不看群 |
| `overrides` | `{"chat_id": "always" \| "mention_only" \| "off"}` | 单个会话覆盖全局 |

命令行临时覆盖（不改文件）：

```bash
node bin/demo.js --mock --dm=mention --group=always
node bin/demo.js --mock --set chat_li:off        # 只关掉"李娜"这个私聊
```

「会话是私聊还是群」看 `listChats()` 返回的 `kind`；weflow 侧从 `isGroup`/`chatType` 推，拿不准时**按群处理**——宁可少干，别擅自答应。

寒暄和回执（"早上好"、"好的谢谢"、"收到"）即使闸门是 always 也会被吃掉。

## 发送政策（只读，人工审核）

这个版本**不发消息**，而且不是靠配置关掉的，是代码里没有发送路径：

- `lib/index.js` 只注册 `wechat_duty_scan` 一个工具，扫到的活只落成待办；
- 全仓没有一处调用 `sendText()` —— `bin/selftest.js` 会逐行扫 `lib/*.js` 把这一点钉死；
- `sendText()` 默认 `dryRun: true`；`config.send.allow` 默认 `false`，`review: true`。weflow-cli **有** `send <target> <message>`，但目标必须在它的白名单里（否则 `TARGET_NOT_ALLOWED`），并且要 `--dry-run` 之外的 `--yes` 才真发、消息通道得先 `login-wechat`；本适配层只在 `confirm === true` 时才把 `--yes` 传下去。

将来若要放开，口径是「人工确认式」：把 `send.allow` 改成 `true` 也**只代表允许走人工确认**，每次发送必须由人在待办卡片上点一次【确认发送】，接口层再要求 `confirm === true`。轮询、agent、脚本自动触发的发送不在支持范围内。

## 目录

| 文件 | 作用 | 对应 cyber-im-avatar |
|---|---|---|
| `lib/wechat.js` | 平台适配：调 `weflow-cli`，压成统一消息结构 | `lib/im.js` |
| `lib/judge.js` | 派活判定（纯规则 + 闸门） | 无（它交给 skill/模型） |
| `lib/policy.js` | 私聊/群聊闸门解析（含单会话覆盖） | 无 |
| `lib/config.js` | `config.json` 读写 + 命令行覆盖 | 无 |
| `lib/state.js` | 检查点、去重（会话 + localId） | `lib/state.js` |
| `lib/index.js` | DSH 插件入口：注册 `wechat_duty_scan` 工具 | `lib/index.js` |
| `lib/mock.js` | 示例数据（编造的） | — |
| `bin/demo.js` | 命令行 demo | — |
| `vendor/` | 参考源码，仅用于对照接口 | — |
| `CHANGELOG.md` | 各版本改了什么 | — |

## 真机接线（weflow-cli）

1. 装：`npm i -g weflow-cli`（写这个文档时是 1.21.17；它要求 Node.js ≥ 22、Python ≥ 3.10）。
2. 装 Python 依赖：`weflow-cli setup --yes --non-interactive`。**国内网络直连 PyPI 大概率 `ConnectionResetError(10054)`**，给 pip 换个镜像即可：

   ```bash
   PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
   PIP_TRUSTED_HOST=pypi.tuna.tsinghua.edu.cn \
   weflow-cli setup --yes --non-interactive
   ```

   venv 建在 `~/.weflow-cli/venv`，之后所有 Python 工作流都优先用它。Windows 上 `sqlcipher3` 会自动换成预编译的 `sqlcipher3-wheels`。
3. 体检：`weflow-cli check`。除了依赖，它会报微信版本——本机是 **4.2.0.13，比它验证过的 4.1.15.56 新**，读不出数据时先怀疑版本而不是我们的解析。
4. 初始化：`weflow-cli init -p "<xwechat_files 路径>"`。不带 `--json` 可以直接跑（`--json` 才会要求交互终端）；它从微信进程里抓解密密钥，而 hook **只在登录那一瞬触发**——所以正确姿势是：先退出微信（或让它停在扫码/登录界面），再运行 `init`，然后在 `init` 等待的约 120 秒内启动微信并完成一次登录。
5. 验证数据：`weflow-cli sessions --json | head`，能出 `success: true` 和会话列表就算通了。读不出来时先 `weflow-cli check --report`，它会明确报是 Python 依赖、密钥还是微信版本的问题。
6. 跑本适配层：`node bin/demo.js`（去掉 `--mock`）。

Windows 上 `npm -g` 装的其实是 `weflow-cli.cmd` 垫片，`execFile` 直接跑会 ENOENT（表现成「没装」）。`lib/wechat.js` 的 `resolveCli()` 会从垫片里翻出真正的 JS 入口（`node_modules/weflow-cli/cli.cjs`），用当前 node 执行，不走 shell，免得聊天文本里的引号/`&` 被 cmd 吃掉。

## 已知未验证

1. **命令与字段已对着 weflow-cli@1.21.17 的发布包源码核对过，CLI 与依赖也已在本机装好，但还没 init 成功、没读过一条真实消息**。现在的模板是：
   - `sessions --json -n 50` → `{ success, sessions: [{ username, displayName, type, summary, lastTimestamp }] }`
   - `messages <会话> --json --non-interactive -n 30 -s <Unix 秒>` → `{ success, talker, messages: [{ localId, createTime, isSend, senderUsername, parsedContent }] }`。注意 `-s` 吃的是秒，不是 ISO 字符串。
   - 账号从 `config show` 的文本行「微信账号: wxid_xxx」里抠 —— weflow 没有 `whoami`，而 `config show --json` 恰好把这行脱敏掉。
   群聊只认会话 id 后缀 `@chatroom`（`type` 字段在 NT / WCDB / 直读 SQLCipher 三个后端语义不一致，不能当准绳）。昵称另走一趟 `contacts --json -n 5000` 查自己那一条（weflow 不给自己昵称，`sessions` 的 `displayName` 都是别人的），查不到就留空并回落到 `self.names`；每个进程只查一次。`bin/adaptertest.js` 用真实 JSON 形状做了解析回归，但它喂的是假 CLI；真机第一次跑请先手动 `weflow-cli sessions --json` 对一眼字段。

   本机 init 实测卡点（微信 4.2.0.13）：`weflow-cli dbkey` 能抓到 64 位密钥（「密钥已捕获」），但该命令只打印不落盘，`init` 也不复用；`init` 只在**微信未运行**时才等 hook（120 秒），已登录状态下直接跳过等待，随后内存扫描在 4.2 上匹配不到 `x'<key><salt>'` 特征，结尾报「初始化未完成：数据库密钥没有就绪」。绕法：退出登录 → 运行 `init` → 在等待窗口内完成登录。
2. 微信没有 `mentions` 结构化字段，@ 判定只能靠正文里的 `@名字`，改名/备注会漏。
3. ~~weflow-cli 没有发送子命令~~ **这条已更正**：装好 1.21.17 后发现它有 `send <target> <message> --yes`（受白名单 + `login-wechat` 限制）。本适配层仍不代发：`sendText` 默认只带 `--dry-run`，必须 `dryRun:false` 且 `confirm === true` 才带 `--yes`，全仓也没有调用方。
4. weflow 没有稳定游标（README 说还没对外），增量靠「带重叠的时间窗 + 消息 id 去重」，重叠窗口内的重复由 `state.js` 吃掉。

## 下一步（按性价比）

1. ~~改字段映射~~ 已做完（对着 weflow-cli@1.21.17：`sessions --json` + `messages --json --non-interactive -s <秒>`，回归在 `bin/adaptertest.js`）。剩下的是真机验证：`weflow-cli init`（交互终端）→ `node bin/demo.js`（不带 `--mock`）看能不能拉到消息。
2. 把判定接到 DSH 会话：命中就 `ctx.sessionController.create()` 开子会话，首条消息带「来源群 + 原话 + 判定理由」。
3. 侧边栏面板：列表 + 待办 + 一键派活。

## 装进 DSH

```bash
dsh plugin --profile desktop add "D:/项目/dsh-wechat-avatar"
```

`cordis.patch.yml` 里是 `- insert: - id: wechat-avatar` 的写法，与 dsh-opportunity-discovery 一致。
