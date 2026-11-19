# 更新说明

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
