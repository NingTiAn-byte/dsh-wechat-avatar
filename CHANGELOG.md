# 更新说明

## v0.9.4 — 任务显示建立时间

- 任务行和概览条目都会显示建立时间，小字跟在派活人名字后面（当年只显示 `月-日 时:分`，跨年带年份）。
- `normalizeTask` 保留 `created_at` / `updated_at`（以前这两个字段在存盘时被丢掉）；`POST /api/overview` 的条目补 `created_at`。
- 时间优先取 `created_at`，旧任务退回消息时间 `source.ts`。
- selftest 135 → 136 项断言。

## v0.9.3 — 任务可删除，删过的会变成否例

- 概览页和任务列表的每条任务多了「删除」按钮：点一下就从任务里删掉，同时把这条消息记进否例（`.state/state.json` 的 `lessons`，最多 200 条）。
- 之后扫描到同一会话里形似的消息（完全相同 / 一条包含另一条 / 二元组重合 ≥ 0.6）直接跳过，不再落任务，计数记在 `lesson_skipped`。
- AI 复核的判定 prompt 会把该会话已否掉的消息列出来，让 agent 也照着判断；AI 自己判「不是活」而删掉的任务同样会记成否例。
- 新增 `lib/lessons.js`；`POST /api/task` 新增 `action: "dismiss"`；否例判断不跨会话。
- selftest 128 → 135 项断言。

## v0.9.2 — 只做该做的活；面板加总览页

- 工作边界改成三档（`lib/kind.js`）：`chatter`（收到/好的/在吗/👌…）不落任务；`needs_you`（报价、口径、上次说定的、你们那边…）落任务但标「等你补信息」，**不自动交给 DSH、不替你猜答案**；`task` 照旧自动交给 agent。
- 自动答答案默认关：`config.answer.auto` 默认 `false`，要显式打开才让 AI 猜；面板文案同步。
- 新增 `GET /api/overview`：一次返回「等你补信息 / 等你回话 / 进行中 / 今日新活」四个计数、需要你处理的列表、agent 正在干、按群统计、异常（扫描错误、AI 复核错误、最近扫描时间）。
- 面板加顶部标签「概览 / 设置与任务」，默认落在概览：四块计数、需要你处理的（可复制原话、可打开会话）、agent 正在干、按群、异常；点「设置与任务」回到原来的全部设置卡片。
- 任务行新增「等你补信息」标签；`needs_you` 任务带 `need`（原话）与 `kb_hit`（工作记录里命中过的出处）。
- 测试 124 → 128 项断言。

## v0.9.1 — 面板整理：工作记录默认收起、任务列表翻页

- 「工作记录」卡片默认收起，只显示「共 N 条」；点「展开」才出现搜索框和列表，列表只渲染最近 20 条（更早的靠搜索），每条回执摘要从 140 字收短到 90 字。
- 任务组里的任务列表改成每页 8 条、最新的排在最上面；超过一页时任务数旁边出现「‹ 上一页 3 / 5 下一页 ›」，每个任务组各自记住页码。
- 测试：selftest 仍 124 项通过。

## v0.9.0 之后（未发布）

- **自动开干**：`DEFAULT_CONFIG.handoff.auto` 改为默认 true，识别到的任务直接交给 DSH 的 agent，不用再点「交给 DSH」。
- **缺条件会回会话里问**：交接简报要求 agent 用 `【等你回话】` / `【等你确认计划】` 标记卡点；`lib/handoff.js` 新增 `splitAsk()`，`syncReplies` 见到标记就把任务置 `waiting` 并保存问题，不当成回执收掉。面板显示「等你回话」、可复制问题、可跳到会话回答。
- **状态**：`TASK_STATUS` 增加 `waiting`；任务新增 `ask`/`asked_at`/`handoff_base`（交接前的会话内容，避免把上一轮的话当成新回执）。
- **工作边界**：任务落盘时分类为「问答型 / 任务型」（`lib/kind.js`），面板任务行标「问答 / AI 答」。
- **回答直接查**：问答型任务自动从上下文和 `knowledge/` 找答案，写成回执（`task.auto_answered`），不发送；`config.answer.auto` 默认 true，可在面板关。
- **AI 复核 prompt**：区分两类工作，问答型要求带 `answer` 字段，任务型要求先判断简单/复杂。
- **交接 prompt 按类型写工作方式**：任务型「简单直接做、复杂先出计划等确认」，问答型「直接给答案、别编」。
- **本地 pre-commit 钩子**：暂存区出现 `knowledge/`、`config.json`、`.state/` 时直接拒绝提交。
- 断言 105 → 118。


## v0.9.0 — 工作记录：把「派过什么活、怎么回的」攒成能搜的上下文

- 新增 `lib/kb.js`：每次落任务写一条记录（谁派的、原话、状态、会话 id），回执写回后补上结果；索引在 `knowledge/index.json`，每个群另存一份 `knowledge/<群名>.md`（人肉可读，可以直接翻、可以 git）。
- 「交给 DSH」时自动带上这个群最近 5 条记录（标题 + 回执摘要），agent 不用再从零猜上下文；prompt 里明确写「供参考，别照抄结论」。
- 面板新增「工作记录」卡片：关键词搜索（多个词按空格拆、全部命中才显示），显示群、时间、谁派的、标题、回执摘要；「共 N 条」在标题右边。
- 新增接口 `GET /api/kb?q=&chat=&limit=`（`?stats=1` 只回统计）。
- 新增 `bin/kbimport.mjs`：把 `config.json` 里已有的任务一次性补录进知识库（本次已跑，9 条）。
- `knowledge/` 已加进 `.gitignore`（里面是真实群名和对话摘要，不进公开仓库）。
- 测试：selftest 94 → 105 项（记录去重、md 生成、关键词/多词/按群检索、按会话取最近、交接 prompt 带历史）。

## v0.8.1 — 修「交给 DSH」报 session.create accepts workspaceId or cwd, not both

- DSH 的 `sessionController.create()` 只接受一个位置：传 `workspaceId` 就落在工作区根目录，传 `cwd` 就只按目录建；两个一起传直接 `bad-request`。旧代码在「绑了 DSH 工作区 + 按群名分子目录」时把两个都塞进去，于是每次交接都失败。
- 现在二选一：绑了工作区就只传 `workspaceId`（会话照常出现在你左侧栏的工作区里），子目录 `<工作区路径>\<群名>` 不再当 `cwd` 传，而是写进 prompt 的「建议工作目录」并说明会话根目录是工作区根；没绑工作区时才用 `cwd`。
- 测试：handofftest 16 → 18 组（只传 workspaceId / 只传 cwd / prompt 带子目录说明）。

## v0.8.0 — AI 复核：规则判不出来的时候，让 agent 看上下文

- 新增配置 `ai: { enabled: false, perRound: 8 }`；面板「什么才算派活」里多一个「AI 复核」开关，默认关。
- 打开后，规则判出来的每条新任务会连同**前后最多 12 条对话**打包成一条纯文本 prompt，投给 DSH 里一个专用会话（`state.ai.session`，没有就自动开一个），让它回一段 JSON：`[{id, is_work, title, deadline, confidence, reason}]`。
- 它说「不是活」的任务直接从任务组里删掉，并在 `state.ai.dismissed` 留档（最多 50 条）；说「是活」的补一个 `task.ai` 标记（面板任务行显示「AI：是活」，title 上有理由），顺便补期限、抬置信度。
- 复核是异步的、不挡扫描：一批最多 8 条（`ai.perRound`），一分钟后没回就放弃并写 `state.ai.last_error`；失败不影响规则结果，面板会显示「上次 AI 复核出错：…」。
- `GET /api/config` 多返回一个 `ai`（含 `last_error`、`pending` 条数）。
- 断言：selftest 94 项（新增 15 条覆盖 transcriptOf / entryOf / buildPrompt / parseVerdicts 与默认关）、handofftest 16 组、adaptertest 10 组。

## v0.7.0 — 自动归组：不用再手工绑定会话

- 扫到「派给我的活」、而会话还没有归属时，按群名/昵称自动建任务组并归入（`ensureGroup`），同名组复用，一个会话只归第一个命中的组。
- 新增配置 `group_auto`（默认 true）、`default_dsh_workspace` / `default_dsh_workspace_path`：新建组继承默认 DSH 工作区。
- 面板新增「自动归组」卡片（开关 + 默认 DSH 工作区下拉）；任务组里的「绑定会话」下拉改成只读的「归入的会话」列表。
- 扫描结果新增 `groups_created`。
- 下拉里可以直接新建 DSH 工作区：填一个已存在的目录，点「新建为 DSH 工作区」，走页面上的 `workspaces.create({path})`（和左侧栏新建是同一个注册表），建完会自动出现在左侧栏和下拉里并立刻绑定；不想注册工作区时用「直接用它」，只把目录当工作目录。
- 「默认 DSH 工作区」下拉原来读前端内存里的工作区服务，经常是空列表；改成由宿主读 `workspaceRegistry`，走 `GET /api/dshws` 返回 `{workspaceId, title, path}`，读不到时把原因显示在卡片上。
- 断言：selftest 75 项、handofftest 16 组、adaptertest 10 组。

## v0.6.0 — 每个群一个会话、按群名分目录

- 同一个群复用同一个 DSH 会话：第一条任务 `create()`，之后 `resolveAgent()` + `followup()` 接着说；旧会话没了会自动新建，任务不会丢。
- 会话 cwd 改成 `<DSH 工作区路径>\<群名>`（目录自动创建，名字里的 `\/:*?"<>|` 换成 `_`），几个群的资料互不干扰；没读到工作区路径时退回工作区根目录。
- 同一个群同时只跑一条任务：上一条还没回执，新任务排队等下一轮。
- 任务行新增「重开会话」（`POST /api/session`），把这个群记的会话删掉，下一条任务开新的。
- `state.json` 新增 `sessions: { <chat_id>: { session_id, cwd, reused, updated_at } }`。
- 断言：selftest 70 项、handofftest 16 组。

## v0.5.0 — 自动交给 DSH，回执写回任务

- 面板里的「工作区」统一改叫「任务组」，避免和 DSH 自己的工作区混淆；配置字段仍是 `workspaces`，不用迁移。

- 新增 `config.handoff = { auto: false, maxPerScan: 2 }`：打开后，一轮扫描里新落到任务组的任务会自动交给 DSH（每轮最多 `maxPerScan` 条）。默认关，先看着它跑。
- 交出去的任务记下 `session_id` / `handed_at`，状态变「进行中」；手动点「交给 DSH」也走同一套字段。
- 回执闭环：每轮扫描顺带看一眼这些会话，agent 这一轮 `turn/end` 之后把它的最终回复写进任务的 `reply`（截断 4000 字），状态改「已完成」；管理页里直接显示，并带「复制回执」按钮。
- 面板新增「自动交给 DSH」开关卡片；任务行显示「进行中 / 已回执」。
- 绑到用户已有的 DSH 工作区：每个任务组可选一个 DSH 工作区（面板下拉，选项来自当前 DSH），交给 DSH 时会话直接建在那个工作区里，左侧会话列表能看见；任务行多了「打开会话」按钮，一点就切过去看 agent 干活。没选就还是按默认位置建会话。
- 读会话事件走 `readSessionReply()`，没注入 `sessionController` 时退化成原来的「只扫不做」。
- 纯函数 `turnReply(events)` 单独拆出来：只取最后一个 `turn/start` 之后、且出现过 `turn/end` 的那一轮回复，早轮次的结果不会混进来。
- 这一步仍然不代发：回执要你自己复制粘贴到微信。代发（weflow `send --yes`）留到下一步。
- 会话选择器支持拼音首字母：`csq` → 测试群，`zs` → 张三。用 `Intl.Collator` 的拼音排序反推声母，不引第三方库；「监听范围 / 绑定会话 / 每个群怎么叫我」三处下拉都生效。
- selftest 65 项、handofftest 12 组。

## v0.4.0 — 先选「监听哪些群」，再开始监听

- 新增 `config.watch`：空数组 = 监听全部会话；非空 = 只扫这些（`chat_id` 或群名都认）。宿主半 `scanOnce()` 按它过滤，管理页有「监听范围」卡片可以直接搜群名挑。
- 管理页新增「立即扫描一次」，走 `POST /dsh-wechat-avatar/api/scan`（宿主没注册时回 501），不用等下一轮轮询。
- 修「下拉是空的且不能自己输入」：会话列表读失败时不再把上一次的 `chat_list` 清空（并记 `state.scan_error`，面板会显示原因）；会话选择器改成下拉优先——点开就是完整列表，输入只做过滤，必须从列表里点一项才算选中，不再有「按原样文字绑」。
- `/config` 的 GET 多返回 `scan_error`；`sanitizePatch` 接受 `watch` 并按整表替换处理。
- 「每个群怎么叫我」改成先选群再设置：只列已设置过的群，底部搜索框挑一个新群才出现输入框；行尾 `×` 取消这个群的单独称呼。
- 修「三个下拉拉出来看不见字」：底色用了未定义的 `--dsw-alias-bg-elevated`（回落成白底），文字在暗色主题下是近白色。改用有定义的 `--dsw-alias-bg-layer-2`，文字色继承页面。
- 新增 `bin/fillchats.mjs`：面板下拉为空时，把 `listChats(50)` 的结果直接写进 `state`（救急用）。
- selftest 59 项（新增 4 条 watch 相关断言）。

## v0.3.0 — 真机跑通：第一次读到真实微信消息

这一版没有新概念，就是把「平台层到底能不能用」从猜变成事实：在本机（Windows 11、微信 4.2.0.13、weflow-cli 1.21.17、Node 24）完整跑通了一轮。

- 密钥怎么拿的：微信 4.2 自动登录只给 3–5 秒窗口，`weflow-cli init` 自己的 hook 抢不到；`dbkey` 抢到了却不落盘。解法是先起一个常驻捕获（新增 `bin/getkey.mjs`），贴住微信进程之后再启动微信登录，拿到 64 位 key 后直接 `weflow-cli init --passphrase <key>`。
- 真实数据量：`sessions` 206 个会话、`contacts` 963 个联系人；三个库（聊天/联系人/朋友圈）派生密钥全部「已验证」。
- 判定在真实数据上正常：私聊里「收到，我先沟通下。然后下午说的新增的功能，12 月没问题……」判成 PASS（期限=下午）；自己发的消息被 `isSend` 正确排除。
- `scanOnce()` 跑 50 个会话 → 绑定的工作区落 9 条任务，同 msg_id 不重复。
- 已知缺口：weflow 不提供自己的昵称（`config show` 没有、`contacts` 不含自己），`self_name` 留空，称呼走 `config.json` 的 `self.names`。

其它：

- `config.json` 不再进版本库（真实会话 id / 群名 / 待办留在本地），仓库里放 `config.example.json`；缺文件时自动用内置默认值。
- README 的「真机接线」第 4 步重写成上面这套流程，「已知未验证」升级为「真机验证记录」。
- `bin/getkey.mjs` 通过 `npm root -g` 找 weflow-cli 的 `keyService.js`，也可用 `WEFLOW_KEY_SERVICE` 指路。

## v0.2.2 — 任务可以「交给 DSH」了

任务行多了一个按钮：点它 → 新建一个 DSH 会话 → 把这条待办作为一条普通用户消息投给 agent，任务状态自动切到「进行中」。会话出现在左侧会话列表里，点进去就能接着干。

- 简报包含：任务标题、来源会话、是谁说的、期限、工作区名。
- 简报里写死一句约束：「先给方案，等我确认后再改文件或跑命令」。因为消息正文来自微信群，属于不可信输入——这句话挡不住所有 prompt injection，但默认不动手。
- 依赖 `ctx.sessionController.create()` + `resolveAgent()` + `agent.followup()`；部署里没有会话服务时，接口回 501、面板提示原因。
- 新增 `bin/handofftest.js`：假 ctx 跑 6 组断言（正常递话、无服务、建会话失败、agent 起不来、空任务简报、消息 id 唯一）。

## v0.2.1 — 管理页「称呼改了又变回去」

面板里的称呼输入框原来有两个毛病，合起来就是「改完一看又变回默认值」：

- 输入框的 value 每次都从 `split()` 后的数组重新拼回字符串，打逗号或空格会被当场吃掉，第二个称呼根本输不进去。
- 只有点「保存」才写盘；面板被重新挂载（切走再切回、宿主刷新）时未保存的输入直接丢失，重新 GET 回来当然还是默认值。

现在：输入框保留原始文本（只在存盘时拆分），并且每次改动 600 毫秒后自动落盘，按钮仍可手动立即保存。工作区名/绑定会话维持原来的失焦即存。

「工作区与任务」改成子标签切换：顶部一排是工作区（带任务数），点哪个看哪个，新建后自动选中。工作区多起来也不会把面板撑成一条长列表。

## v0.2.0 — 平台适配层对齐 weflow-cli 真实接口

这一版把 `lib/wechat.js` 从「照着文档猜命令」改成「对着 weflow-cli@1.21.17 的发布包源码核对」。之前的模板（`sync list` / `sync run`）是不存在的子命令，live 模式必然失败。

### 变更

- **命令模板**（`lib/wechat.js`）
  - 会话列表：`sessions --json -n {limit}`
  - 拉消息：`messages {chat} --json --non-interactive -n {limit} -s {sinceEpoch}`
  - 自己账号：`config show`（文本行「微信账号: wxid_xxx」）
  - 自己昵称：`contacts --json -n {limit}` 查自己那一条
  - 注意 `-s` 吃的是 **Unix 秒**，不是 ISO 字符串。
- **参数填充 `fill()`**：没有值的可选参数连名带值一起丢掉（没传 since 时 `-s` 必须消失，否则 weflow 会当成 `-s undefined`）。
- **`run()` 容错**：weflow 失败时 JSON 仍在 stdout、退出码为 1，所以非 0 退出也解析；`ENOENT` 单独标 `missing`，错误提示才说得准。
- **字段映射 `normalize()`**：`localId` 当消息 id；`senderUsername` 与 `senderDisplay` 分开取（合并会把自己发的消息误判成别人发的）；正文用 `parsedContent` 兜 `rawContent`。
- **群聊判定**：只认会话 id 的 `@chatroom` 后缀——`type` 字段在 NT / WCDB / 直读 SQLCipher 三个后端语义不一致。
- **自己身份识别**：`config show` 拿账号 → `contacts` 补昵称；都用不上时从 `isSend: 1` 的消息反推 `selfId`。
- **Windows 垫片**：`npm -g` 装的 `weflow-cli.cmd` 用 `execFile` 会 ENOENT，新增 `resolveCli()` 从垫片里翻出真正的 JS 入口，用当前 node 执行，不走 shell。
- **发送能力校正**：weflow-cli 1.21.17 **有** `send <target> <message> --yes`。`sendText()` 改为只有在 `dryRun === false && confirm === true` 时才把 `--yes` 传下去，其余情况一律 `--dry-run`；默认仍是不发。
- **`self.id` 配置**：`config.json` 可直接手填自己的 wxid，省一次 `config show`；优先级 `config.selfId || cfg.self?.id || (mock ? "wxid_me" : "")`。
- **发送政策**：`config.send = { allow: false, review: true }` 默认关；`bin/selftest.js` 新增断言逐行扫 `lib/*.js`，确认全仓没有一处调用 `sendText()`。
- **新增回归** `bin/adaptertest.js`：内置假 CLI，覆盖字段映射、`@chatroom` 判群、since 裁剪、selfId 认领、失败 JSON 透出、缺参裁剪、CLI 缺失、发送三态（默认预览 / 缺 confirm 仍预览 / confirm 才 `--yes`）、白名单拒绝码透出。共 10 组。

### 测试

- `node bin/selftest.js` → 55 项断言通过
- `node bin/adaptertest.js` → 10 组断言通过（假 CLI，未接触真实微信数据）
- `node bin/demo.js --mock` → PASS / REPLY / -- 三档正常

### 已知限制

- 真机验证未完成：本机微信 4.2.0.13（weflow 验证过的是 4.1.15.56）。`weflow-cli dbkey` 能抓到 64 位密钥，但该命令只打印不落盘，`init` 也不复用它；`init` 只在「微信未运行时」才等 hook（120 秒），已登录状态下会直接跳过等待，随后内存扫描在 4.2 上匹配不到 `x'<key><salt>'` 特征，最终报「数据库密钥没有就绪」。要真正初始化，需要在微信**未登录**状态下运行 `init` 并完成一次登录事件。
- 微信没有结构化 `mentions`，@ 判定只能靠正文里的 `@名字`。
