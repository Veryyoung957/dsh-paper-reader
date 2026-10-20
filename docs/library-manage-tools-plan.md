# 「文献整理工具」冻结契约（v1）

> 任务：t1（需求/方案轮）。作者：researcher。
> 基线：`feat/migrate-prompt@57309b2`（已安装产品线）。工作树：`.worktrees/library-manage-tools`，分支 `feat/library-manage-tools`。
> 纪律：**本文件只冻结契约，不改实现**；本轮只在 `docs/` 落盘并提交到分支，不 push、不合并、不部署、不碰 `~/.dsh`。
> 读者：t2（实现）、t3（独立评审/验证）。**评审请直接照 §6 的变异靶子施工，不要采信本文件的结论**。

---

## 0. 基线与取证

### 0.1 工作树状态（验收项「工作树已建好 + typecheck 通过」）

| 事实 | 命令 | 实测结果（2026-10-20） |
|---|---|---|
| 工作树分支 | `git -C .worktrees/library-manage-tools branch --show-current` | `feat/library-manage-tools` |
| 基线提交 | `git -C .worktrees/library-manage-tools log --oneline -1` | `57309b2 test(migrate-prompt): P0 的夹具计数改为平台感知…` |
| 分支是从产品线切的 | `git worktree add -b feat/library-manage-tools .worktrees/library-manage-tools feat/migrate-prompt` | 新建成功，HEAD = `57309b2` |
| typecheck | `cd .worktrees/library-manage-tools && npm run typecheck` | **exit 0**（无输出） |
| build（本契约文档不改代码，仅确认基线可构建） | `npm run build` | **exit 0** |
| 文档提交前 `git status` | `git status --short` | 空（`dist/`、`node_modules/` 均被 `.gitignore` 忽略，见 `.gitignore:1-2`） |
| 文档已提交 | `git show --stat --oneline HEAD` | 单文件 `docs/library-manage-tools-plan.md`（本文件），提交信息 `docs(library-manage-tools): 冻结 agent 文献整理工具契约…` |
| 提交后 `git status` | `git status --short` | 空（工作树干净） |
| 未改实现文件 | `git show --name-only --format= HEAD` | 只有 `docs/library-manage-tools-plan.md`；`src/`、`test/`、`lib/` 零改动 |

### 0.2 node_modules 取源的一处**有据偏离**（实现/评审必读）

任务建议「node_modules 从主工作区软链」。实测**主工作区不可用**：主工作区 `node_modules` 里 pnpm 装的包是指向已删除临时目录的悬空符号链接：

```text
$ readlink /home/vr/My_Projects/dsh-paper-reader/node_modules/typescript
../../../../../tmp/t10-clean/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript   # /tmp/t10-clean 已不存在
$ readlink /home/vr/My_Projects/dsh-paper-reader/node_modules/@deepseek-ai/dsh-tools
../../../../../../tmp/t10-clean/node_modules/.pnpm/@deepseek-ai+dsh-tools@0.1.5-rc.2_.../node_modules/@deepseek-ai/dsh-tools
```

因此本工作树的 `node_modules` 改为**整份复制自已存在的 `.worktrees/migrate-ui-report/node_modules`**（同一基线的可用安装，`typescript@5.9.3`、`dsh-tools@0.1.5-rc.2`、`dsh-user-approval@0.1.5-rc.3`），属工作树内部文件、不入库。**不要**为此去改主工作区 `node_modules`（超出本轮 in-scope 路径）。

### 0.3 现状锚点（全部为本工作树 `57309b2` 的 file:line）

| 主题 | 锚点 | 事实 |
|---|---|---|
| 工具注册入口 | `src/tools.ts:227-229` | `registerTools(ctx, config)`；`dataDir = resolveDataDir(config.dataDir)` |
| 工具参数 DSL | `src/tools.ts:56-60`、`:601` | `locateParams` 用 `{type,description}`；`study_update` 用 `action` 枚举 + 可选字段，**必填在 execute 内自查**（`:624-632`） |
| 会话自动定位 | `src/tools.ts:62-74` | 未给 `path/name` 时按 `agent.id`（会话 id `dpr-…`）反解论文（`:70`）；`paperFromSessionId` 在 `:77-88` |
| 单工具多 action 的库内先例 | `src/tools.ts:594-636` | `study_update` 一个工具三个 action；工具总数保持精简 |
| 输出 schema 的已知限制 | `src/tools.ts:641-642` | dsh-tools 的 DSL **不支持 `oneOf` 成员对象上的 `required: true`**；绕法见 `:643-676`（本体不带 required，由外层属性声明） |
| 迁移只读工具 | `src/tools.ts:678-786` | `migration_report` 只调 `planMigration()`，**不 import `runMigration`** |
| 迁移偏好工具 | `src/tools.ts:789-837` | 只写偏好，不迁移 |
| 插件壳 | `src/index.ts:12`、`:14-22` | `inject = ['tools']`；`registerTools(ctx, config)`；web 服务就绪后再 `registerRoutes(rctx, config)` |
| 启动日志工具清单 | `src/index.ts:16` | 手写工具名清单（新增工具要同步） |
| 破坏性写路径（唯一实现） | `src/library-manage.ts:444-498`（`moveToTrash`）、`:566-627`（`deletePaper`）、`:705-754`（`deleteTopic`）、`:1080-1156`（`renamePaper`）、`:1219-1251`（`renameTopic`） | 回收站、精确 stem、失败回滚、非递归 rmdir |
| 校验/路径三层防护 | `src/library-manage.ts:87-93`（`validateName`）、`:106-119`（`validateEntryBoundary`）、`:122-129`（`validateNewPaperName`）、`:140-148`（`assertInside`）、`:151-157`（`realDataDir`）、`:165-185`（`validateTopicPath`）、`:188-205` / `:264-272`（`resolveTopicDir*`）、`:211-240` / `:248-255`（`resolvePaperDir*`） | 词法 → realpath → 子路径包含；符号链接专题/论文目录一律拒 |
| 产物清单 | `src/library-manage.ts:282-283`、`:302-309`、`:324-342`、`:345-367` | 精确 stem；`.pdf` 最后；符号链接只移链接本身 |
| 回收站 | `src/library-manage.ts:78`、`:396-409`、`:414-433` | `.trash/<UTC 时间戳>-<3B hex>`（`:384-388`） |
| 错误码与 HTTP 状态 | `src/library-manage.ts:38-55`、`:58-73` | `ManageCode` 闭集；`ManageError` 带 `code/status/extra` |
| 重命名两段式 | `src/library-manage.ts:1080-1156` | 先整体改论文目录（`:1101-1115`），再改目录内文件名（`:1127-1154`），失败逆序回滚 |
| 专题改名的两条新不变量 | `src/library-manage.ts:1219-1251` | 目标父目录必须存在（`:1226-1227`）；不能移进自己的子树（`:1232-1235`） |
| 新建专题路由（可复用算法） | `src/host.ts:558-581` | `validateTopicPath` → 逐段检查已存在的祖先 → `existsSync` 时 `resolveTopicDir` → `mkdir(recursive)` |
| 上传路由（**不可直接复用的写语义**） | `src/host.ts:585-636` | 只查大小 `>=100`（`:625-628`），**`writeFile` 直接落目标、不查重/不原子**（`:629-634`）⇒ 工具不得调用它 |
| 在途会话检查 | `src/host.ts:254-272`（`scanPaperSessions`）、`:377-385`（`sessionInfo`）、`:393-404`（`requireSessionClear`）、`:407-412`（`requireTopicSessionsClear`） | 都闭包在 `registerRoutes` 内；查不到会话 → `unknown` → fail-closed |
| 同篇在途操作 | `src/host.ts:421-433` | 进程内 `Set`，key = `${topic}\0${name}` / `topic\0${topic}`；重复 → 409 `busy` |
| 范围读取 busy 提示 | `src/host.ts:439-445`、`:1731-1733` | `scopeBusy` 用**子串包含**；只在读路径追加提示 |
| 翻译在途 | `src/translate.ts:38-53` | `busy` 是**已导出的纯函数**（进程内 Map 在 `:40`），返回 `{zh,dual,busy,phase,error}` |
| 工作区缓存失效 | `src/host.ts:298-306`、`:807`、`:850`、`:941` | 删/改/清空专题后删整棵子树的缓存键 |
| 迁移提示缓存失效 | `src/migrate-prompt.ts:276-279`、`src/host.ts:505` | 任何非 GET 的 `/api/library*` 写操作都会失效 |
| 路由层的四道前置 | `src/host.ts:709-732`（删除文献）、`:736-762`（改名文献）、`:770-814`（删除专题）、`:817-858`（改名专题） | 顺序：词法门 → 计划/存在性 → 会话 → 翻译 → 执行；`withInflight` 包住 |
| 专题批量清空（**本批不做**） | `src/host.ts:907-948`、`src/library-manage.ts:888-1054` | 只留在界面；工具不暴露 clear action |
| 迁移执行门（红线） | `src/host.ts:972-996`（`confirm:'migrate-library'`）、`docs/migrate-prompt-plan.md:338`、`:520-527`、`:631` | 对话侧**没有任何执行路径**；A1「给 agent 加执行工具」已被否决 |
| preset 安装 | `src/preset.ts:12`、`:21-39`；`src/host.ts:322-335` | 安装到 `$DSH_HOME/.agent-presets/paper-reader/`；会话 `agentPreset: PAPER_PRESET_ID`（`:328`） |
| preset 内容 | `presets/paper-reader/agent.cordis.yml:3-5`、`:19-24`、`:44-46`、`:48-66` | 只有 persona（完整系统提示词）+ compaction；工具清单是**手写文案**，不是工具过滤机制 |
| 库内默认布局约定 | `src/library.ts:1-14`、`:45-49`、`:58-62`、`:138-145`、`:160-212` | `<dataDir>/<topic>/<paper>/<paper>.pdf + sidecars`；平板旧布局仍可读（legacy） |

### 0.4 DSH 审批能力的版本事实（决定实现如何写类型）

本插件 `devDependencies` 是 `@deepseek-ai/dsh-tools@0.1.5-rc.2`（`package.json:79-82`），本工作树实际解析到 `dsh-user-approval@0.1.5-rc.3`；已安装的 dsh 运行时是 `0.2.0-rc.2`。**下文 `…/` 指本工作树 `node_modules/@deepseek-ai/`；`dsh-base/…`、`dsh-web-app/…`、`dsh-client-ui-approval/…`、`dsh-tools/lib/index.js`、`dsh-sandbox/…` 等则指已安装运行时根 `/home/vr/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`**（只有安装树里有 base/web-app 的装配）。两代 API 的**唯一差异**是 0.2.0 的 `ApprovalRequestEvent` 多了 `displayReason`；0.1.5-rc.3 **没有**该字段：

| 事实 | 锚点 |
|---|---|
| 审批 outcome 闭集 | `node_modules/@deepseek-ai/dsh-user-approval/lib/types/types.d.ts:26`：`'allowed-once' \| 'rejected' \| 'cancelled' \| 'unavailable'` |
| 请求字段（0.1.5） | `…/types.d.ts:55-66`：`agent`（必填）、`toolName`、`callId?`、`reason?`、`signal?`；**无 `displayReason`** |
| 服务接口 | `…/lib/types/index.d.ts:57-80`（`ApprovalRequest extends ApprovalRequestEvent`，`agent` 路由 + session 审计）、`:110-127`（`request(req): Promise<ApprovalOutcome>`，**只开 turn 内可调**，无 answerer → `unavailable`，`allowed-once` 是唯一授权） |
| 工具执行上下文 | `node_modules/@deepseek-ai/dsh-tools/lib/types/index.d.ts:197-221`（`callId`、`agent?`、`signal`）、`:284-301`（`ToolRunContext`） |
| 工具 schema 写法 | `node_modules/@deepseek-ai/dsh-tools/lib/types/schema.d.ts:74-83`（`ParameterPropertySpec.required: true`/隐式 open 对象）、`:178-208`（`DefineToolOptions`：`parameters` / `output.schema` / `render` / `execute`）、`:239`（`defineTool`） |
| 官方「结构性审批通道」先例 | `/home/vr/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-sandbox/lib/index.js:15-21`（**刻意不依赖 approval/agent 类型**，用最小结构函数） |
| 官方 fail-closed 排序 | `…/dsh-sandbox/lib/index.js:99-120`：无 approver → 抛；无 agent → 抛；四态一一映射 |
| 官方工具层的同类实现 | `…/dsh-tools/lib/index.js:3439-3491`：`ctx.get("approval")` 缺失 → deny；`exec.agent` 缺失 → deny；四态映射 |
| 官方**不**把 approval 放进 inject | `…/dsh-tool-fs/lib/index.js:1176-1181`（`inject = ['tools','fs','systemPrompt']`）、`:1134`（`this.ctx.get("approval")` 运行时可选读取）；`…/dsh-tool-bash/lib/index.js:370`、`…/dsh-tool-pwsh/lib/index.js:341` 同 |
| `ctx.get` 语义 | `node_modules/@deepseek-ai/cordis/lib/types/reflect.d.ts:7-18`、`lib/index.js:755-775`：不经 inject、未提供时返回 `undefined` |

**结论（冻结）**：实现**不新增 npm 依赖、不改 `inject`**，在工具内用**本地结构化类型**读取 `ctx.get('approval')`；**不使用 `displayReason`**（0.1.5 类型没有它，传了会 typecheck 失败/旧版被忽略）。理由与官方 `dsh-sandbox` 的「minimal STRUCTURAL function shape」完全一致（上表 0.4 的「官方结构性审批通道先例」一行）。

---

## 1. 工具面（冻结）

### 1.1 形态：**一个** `library_manage`，`action` 枚举 7 值

```text
library_manage(action: create_topic | add_paper | move_paper | rename_paper
                        | rename_topic | delete_paper | delete_topic)
```

**证据与理由**：
1. 库内已有「单工具 + action 枚举 + 必填字段在 execute 内自查」的先例（`src/tools.ts:594-636`，`action` 枚举见 `:601`），沿用同一风格。
2. 工具列表在 preset 里是**手写文案**（`presets/paper-reader/agent.cordis.yml:19-24`）且启动日志也是手写（`src/index.ts:16`）；7 个独立工具会让这两处各膨胀 7 行，而 action 枚举只需各加 1 行。
3. 审批是**按 action** 决策的（§2.2），同一工具的 action 级差异用文字表格即可表达，不需要拆工具。
4. **不采纳**「拆成 7 个工具」：唯一好处是每个工具描述更短，但 DSH 工具注册是全局的（`src/index.ts:12`、`:20`），与阅读器 preset 的 persona 文案无联动，收益不抵清单维护成本。

### 1.2 parameters schema（可直接照抄）

```ts
// src/tools.ts 内新增；未标 required 的字段一律可选，action 级的必填在 execute 内自查
parameters: {
  action: {
    type: 'string', required: true,
    enum: ['create_topic', 'add_paper', 'move_paper', 'rename_paper', 'rename_topic', 'delete_paper', 'delete_topic'],
    description: '要执行的整理动作。delete_paper/delete_topic/rename_paper/rename_topic/move_paper 需要用户在 DSH 审批 UI 上逐次允许；create_topic/add_paper 不需要审批。',
  },
  topic: {
    type: 'string',
    description: '专题路径（相对文献库根，可多级如 A/B）。create_topic/add_paper/delete_topic 用目标专题；rename_paper/delete_paper 用文献所在专题；move_paper/rename_topic 用源专题。',
  },
  name: {
    type: 'string',
    description: '文献名（不带 .pdf）。delete_paper/rename_paper/move_paper 必填；add_paper 可省略（默认取 source_path 的文件名；若文件名以 .pdf 结尾则去掉，大小写不敏感）。',
  },
  new_name: {
    type: 'string',
    description: 'rename_paper/rename_topic 的新名字（论文名不带 .pdf；专题可多级路径）。',
  },
  to_topic: {
    type: 'string',
    description: 'move_paper 的目标专题路径。必须已存在（不存在请先 create_topic）。',
  },
  source_path: {
    type: 'string',
    description: 'add_paper 的源 PDF 绝对路径。必须是常规文件（不接受符号链接/目录）、内容含 %PDF- 头、非空；源文件只读，不会被移动或删除。',
  },
}
```

**硬约束（§2.7）**：schema 里**永远不出现** `confirm` / `confirmName` / `token` / `approve` 之类的「模型自填确认」参数。测试会快照 parameters 的键集合（§6 A1）。

### 1.3 output schema（可直接照抄）

```ts
// 单一扁平对象（DSL 不支持 oneOf 成员对象上的 required，见 src/tools.ts:641-642）
output: {
  schema: {
    type: 'object',
    properties: {
      ok:                { type: 'boolean', required: true },
      action:            { type: 'string', required: true, enum: ['create_topic','add_paper','move_paper','rename_paper','rename_topic','delete_paper','delete_topic'] },
      topic:             { type: 'string', required: true, description: '动作完成后的专题路径（delete_topic 为被删专题；其余为目标/所在专题）。' },
      name:              { type: 'string', description: '文献名（论文级动作）。' },
      new_name:          { type: 'string', description: 'rename_* 完成后的新名字。' },
      to_topic:          { type: 'string', description: 'move_paper 的目标专题。' },
      created:           { type: 'boolean', description: 'create_topic：true=本次创建，false=已存在（幂等，无改动）。' },
      bytes:             { type: 'integer', description: 'add_paper：写入的字节数。' },
      files:             { type: 'array', required: true, items: { type: 'string' }, description: '受影响的文件名（不含目录）；create_topic/rename_topic 为空数组。' },
      trashDir:          { oneOf: [{ type: 'string' }, { type: 'null' }], required: true, description: '删除动作的回收站绝对路径（恢复线索）；非删除或无隐藏条目时为 null。' },
      trashRel:          { oneOf: [{ type: 'string' }, { type: 'null' }], required: true, description: '回收站相对 dataDir 的路径（错误/成功都可展示，不含服务端绝对路径）。' },
      approval:          { type: 'string', required: true, enum: ['not-required', 'allowed-once'], description: '本次是否经过用户审批：add/create=not-required；其余=allowed-once。' },
      detachedSessions:  { type: 'integer', required: true, description: '因改名/移动/删除而不再自动挂到该路径的伴读会话数（只读统计，不删历史）。' },
      summary:           { type: 'string', required: true, description: '人类可读摘要（与 render 文本同源）。' },
    },
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: value.summary }],
}
```

字段填充矩阵：

| action | topic | name | new_name | to_topic | created | bytes | files | trashDir/Rel | approval | detachedSessions |
|---|---|---|---|---|---|---|---|---|---|---|
| create_topic | 新路径 | — | — | — | ✅ | — | `[]` | null | not-required | 0 |
| add_paper | 目标 | ✅ | — | — | — | ✅ | `[<name>.pdf]` | null | not-required | 0 |
| move_paper | 源 | ✅ | — | ✅ | — | — | 产物名 | null | allowed-once | 源篇会话数 |
| rename_paper | 所在 | 旧 | ✅ | — | — | — | 新产物名 | null | allowed-once | 篇会话数 |
| rename_topic | 旧 | — | ✅ | — | — | — | `[]` | null | allowed-once | 子树会话总数 |
| delete_paper | 所在 | ✅ | — | — | — | — | 已移文件名 | ✅ | allowed-once | 篇会话数 |
| delete_topic | 被删 | — | — | — | — | — | movedHidden | 可能有/可能 null | allowed-once | 子树会话总数 |

### 1.4 action 契约总表

| action | 必填字段 | 前置（全部只读） | 主要副作用 | 锁键（§3.3） | 审批 | 成功后额外动作 |
|---|---|---|---|---|---|---|
| `create_topic` | `topic` | `validateTopicPath(topic,false)`；已存在的祖先必须库内真目录 | `mkdir`（多级，recursive） | `topicKey(new)` | 否 | 失效迁移提示缓存；不建工作区缓存 |
| `add_paper` | `topic`,`source_path`；`name` 可选 | 专题存在；源文件常规/非空/`%PDF-`；目标不冲突 | 新建论文夹 + 原子复制 1 个 PDF | `topicKey(topic)`+`paperKey(topic,name)` | 否 | 失效迁移提示缓存 |
| `move_paper` | `topic`,`name`,`to_topic` | 源篇存在且为**新布局**；目标专题存在；目标不冲突；不在自己子树 | 论文目录整体 rename（全部产物随行） | from/to 两个 topic+paper 键 | **是** | 失效迁移提示缓存 |
| `rename_paper` | `topic`,`name`,`new_name` | 复用 `planPaperDelete` 全套校验；目标名不冲突 | `renamePaper`（目录+目录内文件，失败回滚） | `topicKey`+`paperKey(old)`（目标名冲突由锁内检查兜底） | **是** | 失效迁移提示缓存 |
| `rename_topic` | `topic`,`new_name` | `planTopicDelete` 存在性；目标不在自己子树 | `renameTopic`（目录整体改名） | 源+目标 `topicKey` | **是** | `guards.topicPathChanged(old)`（清工作区缓存）+ 失效迁移缓存 |
| `delete_paper` | `topic`,`name` | 复用 `planPaperDelete` 全套校验 | `deletePaper` → `.trash` | `topicKey`+`paperKey` | **是** | 失效迁移提示缓存 |
| `delete_topic` | `topic` | `planTopicDelete`；**非空即 409**（不递归删） | `deleteTopic` → 隐藏条目进回收站 + 非递归 rmdir | `topicKey` | **是** | `topicPathChanged(topic)` + 失效迁移缓存 |

> `delete_topic` **不会**提供「批量清空」语义：非空专题返回 `topic-not-empty`，agent 必须逐篇 `delete_paper`（每篇各自审批）。批量清空仍只留在界面（`src/host.ts:907-948`、`src/library-manage.ts:888-1054`），符合「破坏性操作逐次批准」的目标。

### 1.5 render / summary 文案（zh 默认，`DPR_LIBRARY_MANAGE_LANG=en` 切 en）

语言开关沿用库内先例：`promptLang()` 读 `DPR_MIGRATE_PROMPT_LANG`（`src/tools.ts:116-118`）；本工具读 `DPR_LIBRARY_MANAGE_LANG`（`en` → en，其余 zh），**每次调用现读**。

| action / 情形 | zh `summary` | en `summary` |
|---|---|---|
| create_topic `created:true` | `已创建专题：A/B（空专题；可用 add_paper 收录 PDF）` | `Topic created: A/B (empty; use add_paper to add PDFs)` |
| create_topic `created:false` | `专题已存在：A/B（未做任何改动）` | `Topic already exists: A/B (nothing changed)` |
| add_paper 成功 | `已收录《T/P》：N 字节，源文件 X.pdf 未被移动或删除` | `Added T/P: N bytes; source X.pdf left untouched` |
| move_paper 成功 | `已移动《T/P》→《S/P》：N 个产物随论文文件夹整体移动，内容未改；M 个伴读会话不再自动挂到新路径` | `Moved T/P → S/P: N artifacts moved with the paper folder, contents unchanged; M reader sessions no longer bind to the new path` |
| rename_paper 成功 | `已重命名《T/旧》→《T/新》：N 个文件同步改名；M 个伴读会话不再自动挂到新路径` | `Renamed T/old → T/new: N files renamed; M reader sessions no longer bind to the new path` |
| rename_topic 成功 | `已重命名专题《旧》→《新》：目录整体移动；M 个伴读会话不再自动挂到新路径` | `Renamed topic old → new: directory moved; M reader sessions no longer bind to the new path` |
| delete_paper 成功 | `已删除《T/P》→ 回收站 <trashRel>（N 个文件，X 字节；按相对路径可手工移回恢复）` | `Deleted T/P → trash <trashRel> (N files, X bytes; recover manually by moving them back)` |
| delete_topic 有隐藏条目 | `已删除空专题《T》→ 回收站 <trashRel>（隐藏条目已移入，可恢复）` | `Deleted empty topic T → trash <trashRel> (hidden entries preserved)` |
| delete_topic 无隐藏条目 | `已删除空专题《T》（无隐藏条目，未创建回收站目录）` | `Deleted empty topic T (no hidden entries; no trash bundle created)` |

`render` 直接输出 `value.summary`（与工具成功结果同源，避免两处文案漂移）；`execute` 的 `summary` 用同一个 `formatSummary()` 生成。

### 1.6 入参校验顺序与错误（全部在**任何写盘之前**）

| 顺序 | 检查 | 失败码 |
|---|---|---|
| 1 | `action` 在枚举内 | `bad-request` 400 |
| 2 | 该 action 的必填字段存在且为 string | `bad-request` 400（文案点名缺哪个字段） |
| 3 | 词法：`validateTopicPath` / `validateEntryBoundary` / `validatePaperName`（§3.2） | `bad-name` 400 |
| 4 | 存在性/布局/产物/目标冲突（`planPaperDelete` / `planTopicDelete` / 新 plan 函数） | `not-found` 404 / `target-exists` 409 / `legacy-layout` 409 |
| 5 | 源文件边界（仅 add_paper） | `source-not-found` 404 / `source-invalid` 400 / `source-empty` 400 / `source-not-pdf` 400 |
| 6 | 在途锁（§3.3） | `busy` 409 |
| 7 | 会话/翻译前置（§3.3） | `session-unknown` 503 / `session-running` 409 / `translation-busy` 409 |
| 8 | 审批（仅 §2.2 标 **是** 的动作） | `approval-rejected` 403 / `approval-cancelled` 409 / `approval-unavailable` 503 |
| 9 | 执行 | 见 §4 错误表 |

**不做会话自动绑定（冻结）**：现有 `locate()` 会在未给 `topic/name` 时按 `agent.id` 反解当前论文（`src/tools.ts:62-74`、`:70`）。`library_manage` 的**写动作一律不启用**这个回退：

- 理由 1：审批 reason 必须指名道姓（用户点「允许」时看到的必须是确切目标），模型省略参数时由服务端猜目标违背最小惊讶。
- 理由 2：删除/移动的自动目标一旦模型理解错会话，就是不可见的数据损失。
- 落地：`library_manage` 不复用 `locate()`，只吃显式 `topic/name`；缺参 → `bad-request`。测试 A2 钉住（在 `dpr-` 会话里调 `delete_paper` 缺 `name` 仍 400、且不弹审批）。

### 1.7 工具描述 / preset persona / 启动日志（实现时逐字使用的文案）

1. **工具 `description`**（模型可见）：
   ```text
   整理文献库。action 必填：create_topic=新建专题；add_paper=把本地 PDF 收进专题；
   move_paper=把一篇论文移到另一个专题；rename_paper=改论文名；rename_topic=改专题名/移动专题；
   delete_paper=删除论文（移入回收站，可手工恢复）；delete_topic=删除空专题（非空请逐篇删除）。
   delete/rename/move 必须由用户在 DSH 审批 UI 上逐次允许（ctx.approval），没有 confirm 参数；
   被拒绝/取消/审批通道不可用时不改动任何文件。迁移执行不在本工具内（只能在界面由用户确认）。
   ```
2. **preset persona 增补**：在 `presets/paper-reader/agent.cordis.yml:19-24` 的工具清单末尾加一行（缩进同列表项）：
   ```text
   - library_manage: 整理文献库（create_topic / add_paper / move_paper / rename_paper / rename_topic / delete_paper / delete_topic）。
     删除、改名、跨专题移动会触发宿主的**用户审批弹窗**；只有用户在审批界面上点「允许」才算确认——
     你在正文里问一句「确认吗」不算确认，也不存在 confirm 参数可以代替。审批被拒绝/取消/不可用时，
     如实告诉用户「未做任何改动」，不要换措辞重试或绕过。
     迁移（旧平铺 → 论文文件夹）没有工具入口：执行只能在「设置 → 论文伴读 → 查看论文状态」由用户点击确认；
     不要声称已迁移，也不要为了迁移自行移动文件。
   ```
3. **文件头注释与启动日志**：`presets/paper-reader/agent.cordis.yml:3-5` 的工具清单、`src/index.ts:16` 的 `registered tools:` 日志都要加 `library_manage`（库内已有「手写清单」漂移风险，测试 D1 断言两者都包含该名字）。

---

## 2. 审批门（冻结）

### 2.1 能力事实（只采信 DSH 类型/实现，不采信本文件）

- 唯一授权结果是 `'allowed-once'`；其余三态必须视为**拒绝**（`…/dsh-user-approval/lib/types/index.d.ts:110-127`、`:57-80`；outcome 闭集见 `…/types.d.ts:26`）。
- 请求必须带 `agent`（路由 + 审计），推荐带 `callId`（把弹窗挂到已展示的工具调用上）与 `signal`（取消传播）；三者都来自 `ToolRunContext`（`…/dsh-tools/lib/types/index.d.ts:197-221`、`:284-301`）。
- `request()` 在**没有打开 turn** 时会 reject（`…/dsh-user-approval/lib/types/index.d.ts:110-127`）；实现必须 `try/catch` 并降级为 `approval-unavailable`，**绝不能**因此继续执行。
- 无 answerer / answerer 抛错 → 服务返回 `'unavailable'`（fail closed）；`policy:'never'` → 确定性 `'rejected'`（`…/lib/types/index.d.ts:36-46`、`…/lib/index.js` 的 `NEVER_SENTENCE`）。
- 官方工具层与沙箱层都是「无 service / 无 agent → 拒绝」，且都是**运行时可选读取**而非 inject（§0.4 表中「官方 fail-closed 排序 / 官方工具层的同类实现 / 官方不把 approval 放进 inject」三行）。

### 2.2 哪些 action 必须过审批（冻结 + 理由）

| action | 过审批 | 理由（证据） |
|---|---|---|
| `delete_paper` | **必须** | 数据离开可检索位置（回收站可恢复但默认不可见）；UI 对删除同样加会话/翻译/在途三道前置（`src/host.ts:709-732`）。 |
| `delete_topic` | **必须** | 删除目录 + 隐藏条目进回收站（`src/library-manage.ts:705-754`）；即便只允许空专题，也删除用户可见结构。 |
| `rename_paper` | **必须** | 改的是**已存在条目**的身份：会话 id 内嵌 `topic/name`（`src/tools.ts:77-88`、`src/host.ts:247-249`），改名会让旧会话脱离（`src/host.ts:755-756` 明确回 `detachedSessions`）；路由把改名与删除放在同一套前置里（`src/host.ts:736-762`）。 |
| `rename_topic` | **必须** | 整棵子树换路径，可能一次影响多篇论文与多个会话（`src/host.ts:817-858`）；同属路由的破坏性集合。 |
| `move_paper` | **必须** | 与 rename 同类（路径/身份变化 + 会话脱离），且是跨专题写；不审批无法解释为何改名要审批而移动不要。 |
| `create_topic` | 不审批 | 只新增一个空目录，不改动任何既有数据；失败/误建可再删（删除本身要审批）。路由无确认字段（`src/host.ts:558-581`）。 |
| `add_paper` | 不审批 | 只新增一篇（源文件只读，不移动/不删除源）；目标冲突直接 409，绝不覆盖；失败清理到零改动。用户目标里的「把本地 PDF 收进库」是高频正向动作，逐次审批会劝退（失败清理语义见 §3.2.4）。 |

> 注意：**不审批 ≠ 无防护**。`create_topic/add_paper` 仍走同一套词法/realpath/冲突/在途检查；`add_paper` 不允许覆盖任何已存在条目。

### 2.3 四态 × 副作用矩阵（冻结）

对 §2.2 标「必须」的 5 个 action，`allowed-once` 之外的**任何**结果都要求「库内零副作用」；「零副作用」定义为：`dataDir` 下**不新增/不删除/不修改任何文件与目录**（含不创建 `.trash` bundle、不写 manifest、不建论文夹、不 mkdir）；唯一允许的变化是 DSH 自己的审批审计事件（`approval/asked` / `approval/decided`，写 session log，不是库文件，见 `…/types.d.ts:29-52`）。

| 审批结果 | 工具返回（抛 `ManageError`） | dataDir 副作用 | 锁 |
|---|---|---|---|
| `allowed-once` | 继续执行；成功后 `approval:'allowed-once'` | 见 §1.4 对应 action | 执行完 `finally` 释放 |
| `rejected` | `approval-rejected`（403）：`用户拒绝了本次<动作>；未做任何改动` | **零** | 释放 |
| `cancelled` | `approval-cancelled`（409）：`审批被取消；未做任何改动` | **零** | 释放 |
| `unavailable` | `approval-unavailable`（503）：`审批通道不可用（无 answerer / 无审批服务 / 无 agent），已拒绝执行；未做任何改动` | **零** | 释放 |

补充的 fail-closed 条件（在**调用 `request()` 之前**就判定，绝不「先做后问」）：

| 条件 | 结果 |
|---|---|
| `ctx.get('approval')` 为 `undefined`（headless/未装配） | `approval-unavailable`，零副作用（官方同款：`dsh-tools/lib/index.js:3439-3447`、`dsh-sandbox/lib/index.js:103`） |
| `exec.agent` 为 `undefined` | `approval-unavailable`，零副作用（`dsh-tools/lib/index.js:3448-3456`、`dsh-sandbox/lib/index.js:104`） |
| `exec.signal.aborted` 已为 true | `approval-cancelled`，连 `request()` 都不调 |
| `request()` reject（无 turn / 审计写失败等） | `approval-unavailable`，零副作用 |
| 返回了闭集外的值（旧/坏实现） | `approval-unavailable`，零副作用 |
| `allowed-once` 之后、第一个写操作之前 `exec.signal.aborted` 变 true | `approval-cancelled`，零副作用（每个 action 在 `mkdir/rename/copy/delete` 前各查一次） |

**顺序（冻结）**：词法/计划/冲突（只读）→ 在途锁 → 会话/翻译前置（只读）→ 审批 → 执行。理由：
1. 校验失败不该打扰用户点审批（也不该把不可执行的请求展示成弹窗）；
2. `newTrashBundle()` 本身会 `mkdir`（`src/library-manage.ts:396-409`），所以审批**必须早于** `deletePaper/deleteTopic` 的第一次调用；
3. 锁在审批前拿，保证「审批等待期间同一目标不会被另一个写操作插队」；`finally` 释放，取消/拒绝不泄漏锁。

### 2.4 审批请求内容（冻结格式）

只用 `reason`（0.1.5 没有 `displayReason`，§0.4）；为保证中英用户都能读懂，`reason` 为**双语单串**：

```text
【文献整理 / Library manage】<action>：《<topic>/<name>》<细节>。仅本次调用有效 / one-shot；
未获批准不会改动任何文件。 / Nothing changes unless you allow this one call.
```

`<细节>` 按 action：
- delete_paper：`N 个文件（X 字节）→ 回收站 .trash`
- delete_topic：`空专题；M 个隐藏条目 → 回收站`
- rename_paper：`旧名 → 新名（N 个文件同步改名）`
- rename_topic：`旧路径 → 新路径（整棵子树）`
- move_paper：`源专题 → 目标专题（论文文件夹整体移动）`

`request()` 参数固定为 `{ agent: exec.agent, toolName: 'library_manage', callId: exec.callId, reason, signal: exec.signal }`。`toolName` 必须是真实工具名，审计事件才可关联（`…/types.d.ts:29-52`）。

### 2.5 插件如何拿到 approval（不改 `inject`）

- `src/index.ts:12` 保持 `inject = ['tools']`；**不要**把 `approval` 加进 inject。理由：headless/未装配 profile 没有该服务，加进 inject 会让整个插件加载失败；官方 `dsh-tool-fs` 就是「inject 不含 approval、运行时 `ctx.get` 可选读」（`dsh-tool-fs/lib/index.js:1176-1181`、`:1134`）。
- 工具 execute 里：
  ```ts
  type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
  interface ApprovalAsk { request(req: { agent: unknown; toolName: string; callId: unknown; reason: string; signal: AbortSignal }): Promise<ApprovalOutcome> }
  const approval = ctx.get('approval') as ApprovalAsk | undefined
  ```
  这是**本地结构化类型**，不 import `@deepseek-ai/dsh-user-approval`，不新增依赖（理由见 §0.4 结论与 `dsh-sandbox` 先例）。
- `exec` 的类型来自 `defineTool` 的 `ToolRunContext`（`node_modules/@deepseek-ai/dsh-tools/lib/types/index.d.ts:284-301`），无需额外 import 类型即可拿到 `agent/callId/signal`。
- 测试替身：`registerTools` 的假 ctx 必须提供 `get(name)`（返回审批 mock 或 `undefined`）。现有测试的假 ctx 只有 `{tools:{register}}`（`test/migrate-prompt.test.mjs:162-167`），**实现方要同步改测试助手**（§6.1）。

### 2.6 paper preset 会话里审批 UI 是否可达

**静态证据（说明「应该可达」）**：
1. 审批服务由 base 装配：`dsh-base/cordis.patch.yml:245-248`（`id: approval` → `@deepseek-ai/dsh-user-approval`，默认 `policy: ask`，仅 `DSH_PERMISSION_MODE=danger-full-access` 时为 `never`）。
2. 审批 UI 由 web app 装配：`dsh-web-app/cordis.patch.yml:311-312`（`id: ui-approval` → `@deepseek-ai/dsh-client-ui-approval`）。
3. UI 侧是**会话级 composer 接管**，不是某个 preset 专属：`dsh-client-ui-approval/lib/client.js:343`（`ctx.uiSession.registerPendingInteraction`）、`:344-354`（注册 `conversation.composer` slot 的 `PendingApproval` 选择器）、`:355-357`（`ctx.remote.$on('approval/request', function(request, next){ return answerApproval(ctx, this, …) })`，`this` 是 scoped agent）。
4. paper preset 只声明 persona + compaction（`presets/paper-reader/agent.cordis.yml:9-66`），**没有**移除审批/改写审批策略的开关；伴读会话由 `sessionController.create({..., agentPreset: PAPER_PRESET_ID})` 创建（`src/host.ts:322-335`，`:328`），是宿主里的普通 session，因此 `approval/request` 的 agent scope 路由与普通会话同一条链路（`…/types.d.ts:67-78` 的 `Scoped<Agent>` 瀑布）。

**结论**：静态证据支持「paper preset 会话里审批 UI 可达」，但**未在本轮做真机点击**，故标 **「待验证」**。验证方法（t3/用户）：
1. 装好本分支构建产物（**部署是用户显式动作，不属于本任务**），`dsh --profile web`，通过阅读器打开一篇论文的伴读会话（该会话 id 形如 `dpr-<base64url(topic/name)>-N`，见 `src/host.ts:247-249`）。
2. 让模型调用 `library_manage(action:'delete_paper', topic, name)`：应看到 composer 位置出现审批卡（`ApprovalPanel`），`reason` 含目标名与「仅本次调用有效」。
3. 点拒绝（Esc）→ 工具返回 `approval-rejected`，用 sha256 快照证明库零变化；再重复并点允许（Enter）→ 文献进 `.trash`。
4. 反例（headless）：无 client answerer 的会话里调用同一动作 → 应得 `approval-unavailable`，库零变化。
5. 若第 2 步没有弹窗，记录会话 id 与 `approval/asked` 审计事件是否存在（session log），按「answerer 未覆盖该 agent」定位；**不得**因此改成模型自填 confirm。

### 2.7 禁止「模型自填 confirm/token」（红线）

- `library_manage` 的 parameters **没有** `confirm/confirmName/token/approve` 字段；`delete_*` 的审批只能来自 `ctx.approval.request`（§2.3）。
- 与迁移路由的 `confirm:'migrate-library'`（`src/host.ts:972-996`）区分：那是**界面点击**发出的固定值，不是模型可填的确认；本工具不暴露迁移执行，也不复用该值。
- 测试 A1 会断言 parameters 键集合与 §1.2 **完全相等**；任何新增确认字段直接红。

### 2.8 被否决的备选：用 `tools/execute` 策略层统一 ask

DSH 的工具注册表本身支持把 ask 决策走审批（`dsh-tools/lib/index.js:3430-3491` 的 `serviceAsk`）。**不采纳**，理由：
1. 注册表层的 ask 发生在 **execute 之前**，无法「先只读校验、再打扰用户」（§2.3 的顺序要求）；
2. 需要额外装配 permission 策略把 `library_manage` 标成 ask，配置面更大且不易在单测里构造；
3. 官方沙箱/工具族的先例也是在**工具内部**显式调用 `ctx.approval.request`（`dsh-tool-fs/lib/index.js:1111-1145`、`dsh-sandbox/lib/index.js:99-120`）。
> 但注册表层仍可能因其他策略对工具调用发起审批；本工具不去控制它，只在**自己的破坏性动作**上再要一次明确的「允许本次」。

---

## 3. 复用与新增（冻结）

### 3.1 必须复用的既有实现（禁止另写一套校验）

| 用途 | 复用函数 | 定义位置 | 备注 |
|---|---|---|---|
| 创建名（topic/paper） | `validateName` | `src/library-manage.ts:87-93` | trim、长度、控制字符、前导点、`/\..` |
| 已存在条目名/删除侧 | `validateEntryBoundary` | `:106-119` | 边界类；`.trash` 保留名；`basename===raw` |
| 专题路径（多级） | `validateTopicPath(raw, boundaryOnly)` | `:165-185` | 逐段；深度/段长/总长；编码变形 |
| 文献改名目标 | `validateNewPaperName` | `:122-129` | 见 §3.2 的 `validatePaperName` 拆分 |
| 库根 realpath | `realDataDir` | `:151-157` | 缺失 → 404 |
| 子路径包含 | `assertInside` | `:140-148` | 拒 `target===root` |
| 专题解析（写/存在） | `resolveTopicDir` / `resolveExistingTopicDir` | `:264-272` | 符号链接专题一律拒 |
| 论文解析（写/存在） | `resolvePaperDir` / `resolveExistingPaperDir` | `:248-255` | 新布局/旧布局回落 |
| 旧布局判定 | `isLegacyPaper` | `:242-245` | move 的拒绝依据 |
| 产物枚举/包含 | `listArtifacts` / `assertArtifactsContained` | `:324-342` / `:345-367` | 精确 stem；`.pdf` 最后；符号链接不跟随 |
| 删除计划 | `planPaperDelete` | `:516-552` | 只读；`.pdf` 必须是常规文件 |
| 删除文献 | `deletePaper` | `:566-627` | 回收站 + manifest + 非递归 rmdir |
| 专题删除计划/删除 | `planTopicDelete` / `deleteTopic` | `:676-695` / `:705-754` | 非空 409；隐藏条目进回收站 |
| 论文改名 | `renamePaper` | `:1080-1156` | 目录+文件两段式，失败回滚 |
| 专题改名/移动 | `renameTopic` | `:1219-1251` | 父目录必须存在；禁移进自己子树 |
| 回收站 | `TRASH_DIR` / `moveToTrash` / `newTrashBundle` | `:78` / `:444-498` / `:396-409` | 只在 `delete*` 内部被调用（工具不直接调） |
| 翻译在途 | `zhStatus` | `src/translate.ts:42-53` | 已导出纯函数，直接 import |
| 文献定位（只读） | `paperRefFor` / `paperPdfPath` | `src/library.ts:451-464` / `:206-212` | 供 `zhStatus` 取真实 pdfPath |
| 列表 | `listPapers` | `src/library.ts:160-203` | 专题级会话/翻译检查 |

**红线**：以上函数不得复制粘贴第二份；工具层只做「参数编排 + 审批 + 加锁 + 结果整形」。

### 3.2 `src/library-manage.ts` 的新增（这是唯一允许新增写逻辑的地方）

#### 3.2.1 新错误码（加入 `ManageCode` 闭集，位置 `:38-55`）

```ts
| 'source-not-found'    // 404 add_paper 源文件不存在/不可读
| 'source-invalid'     // 400 源不是常规文件（目录/符号链接/特殊文件）
| 'source-not-pdf'     // 400 源内容不含 %PDF- 头
| 'source-empty'       // 400 源文件 0 字节
| 'legacy-layout'      // 409 move_paper 遇到旧布局（迁移只能在界面）
| 'add-partial'        // 500 add_paper 复制/落盘失败（已回滚或部分残留，extra 说明）
| 'move-partial'       // 500 move_paper rename 失败（尽力回滚，extra 说明）
| 'session-unknown'    // 503 会话状态不可知；由 guards 抛（host 原本用裸 json，统一进闭集）
| 'approval-rejected'  // 403 用户拒绝
| 'approval-cancelled' // 409 审批取消/信号中止
| 'approval-unavailable' // 503 无审批服务/无 agent/无 answerer/request 抛错
```

#### 3.2.2 `validatePaperName(raw)`（从 `validateNewPaperName` 拆出，纯重构）

```ts
// 新建/收录论文名：命名规范类 + 不允许以 -en/-zh/-dual 结尾（否则被 isPaperPDF 当变体隐藏）
export function validatePaperName(raw: unknown): string {
  const name = validateName(raw, 'paper')
  if (name.toLowerCase().endsWith('.pdf')) throw new ManageError('bad-name', 400, '文献名不带 .pdf 后缀')
  if (/-en$|-zh$|-dual$/i.test(name)) throw new ManageError('bad-name', 400, '文献名不能以 -en/-zh/-dual 结尾（会被当作译文变体而从库中隐藏）')
  return name
}
// 向后兼容：validateNewPaperName = validatePaperName + 同名拒绝
export function validateNewPaperName(raw: unknown, current: string): string {
  const name = validatePaperName(raw)
  if (name === current) throw new ManageError('bad-request', 400, '新名称与原名称相同')
  return name
}
```

> 现状 `validateNewPaperName` 在 `:122-129`；拆出后 `renamePaper` 的调用点（`:1085`）同样会拒绝显式 `.pdf` 后缀的 to——这是**有意收紧**（否则会生成 `<X.pdf>/<X.pdf>.pdf` 的嵌套怪名；既有测试未覆盖该输入，补回归 C7）。命名规范的其他分支（空/长度/控制字符/前导点/`-en/-zh/-dual`）逐字不变。

#### 3.2.3 `createTopic(dataDir, raw): { topic: string; created: boolean }`

- 算法与路由 `src/host.ts:558-581` **同构**：`validateTopicPath(raw,false)` → `root=realDataDir` → 对每个已存在的祖先 `resolveTopicDir`（拒符号链接/逃逸）→ `dir=join(root,...segs)` → 已存在则 `resolveTopicDir` 复核后返回 `created:false`；否则 `assertInside(root,dir)` + `mkdirSync(dir,{recursive:true})` → `created:true`。
- 幂等语义与路由一致（路由 `:573-576` 对已存在目录返回 200）。
- 不写工作区缓存、不写 `.trash`、不做审批。

#### 3.2.4 `addPaper(dataDir, topic, sourcePath, name?, opts?): AddPaperResult`

```ts
export interface AddPaperOptions {
  /** 复制实现（仅测试注入；默认 copyFileSync） */
  copyImpl?: (from: string, to: string) => void
  /** 落盘实现（仅测试注入；默认 linkSync + unlinkSync，失败回退 renameSync） */
  linkImpl?: (from: string, to: string) => void
  renameImpl?: RenameImpl
}
export interface AddPaperResult {
  ok: true
  topic: string
  name: string
  bytes: number
  /** 落盘后的 PDF 绝对路径（与 transcribe_pdf 的 txtPath 同为绝对路径，库内先例 src/tools.ts:340） */
  pdfPath: string
  /** 源文件的 basename（不泄露源目录绝对路径；审批/文案只需要文件名） */
  sourceName: string
}
```

**源文件安全边界（全部在写盘前）**：

| 检查 | 规则 | 失败码 |
|---|---|---|
| 类型 | `typeof sourcePath === 'string'` 且非空 | `bad-request` 400 |
| 存在 | `lstatSync(resolve(sourcePath))` 成功 | `source-not-found` 404 |
| 常规文件 | `st.isFile() && !st.isSymbolicLink()`；目录/符号链接/设备一律拒 | `source-invalid` 400 |
| 非空 | `st.size > 0` | `source-empty` 400 |
| PDF 头 | 读前 1024 字节，包含 ASCII `%PDF-` | `source-not-pdf` 400 |
| 可读 | `realpathSync(source)` 成功（只用于一致性/日志；**不要求**在 dataDir 内，源可以在任意本地目录） | `source-not-found` 404 |

> 注意 `source-invalid` 与符号链接：拒绝的**不是**库内路径边界（源是用户显式给的本地文件），而是「符号链接不是文献」这一全库不变量（`src/library.ts:45-49`、`src/library-manage.ts:531-535`）。若用户确实要收录符号链接指向的 PDF，请传 `realpath`。

**论文名解析（冻结）**：显式 `name` → `validatePaperName(name)`；省略时取 `basename(resolve(sourcePath))`，若以 `.pdf` 结尾（大小写不敏感）去掉该后缀，再 `validatePaperName(...)`。两种路径都失败 → `bad-name` 400（消息说明具体原因）。

**目标冲突（任一命中 → `target-exists` 409，零写入）**：
1. `<topicDir>/<name>/` 存在（文件/目录/符号链接都算）；
2. `<topicDir>/<name>.pdf` 存在（旧布局平铺）；
3. `listArtifacts(topicDir, name).length > 0`（同名孤儿 sidecar，避免「新 PDF + 别人的旧缓存」混合）。

**写入与原子性（冻结）**：
1. `mkdirSync(targetDir, { recursive: true, mode: 0o700 })`（论文夹必须先建；`topicDir` 已存在）。mkdir 后立刻 `lstatSync(targetDir)` 复核：若目录已存在且不是本次创建（并发竞态），立即以 `target-exists` 失败，且**不得**删除既有目录。
2. 临时名：`<targetDir>/<name>.pdf.tmp-<pid>-<8 hex>`（与 `TMP_RE` 兼容：`src/library-manage.ts:284-285`、`src/transcribe.ts` 的 `atomicTempPath()`；这样中途残留也能被 `listArtifacts` 精确识别/清理，不会变成孤儿）。
3. `copyImpl(source, tmp)` 复制；`statSync(tmp).size === st.size` 校验。
4. 落盘（不覆盖）：先 `linkSync(tmp, final)`（同目录硬链接；目标已存在 → `EEXIST` → `target-exists`），再 `unlinkSync(tmp)`。若文件系统不支持硬链接（`EPERM/ENOSYS/EOPNOTSUPP`）：复核 `!existsSync(final)` 后 `renameSync(tmp, final)`（同目录 rename；单进程由锁串行化，跨进程并发不在本插件支持范围——与现有全部写路由一致）。
5. 失败清理：`unlink(tmp)`（force）+ 若 `targetDir` 是本次创建且为空则 `rmdirSync(targetDir)`；`final` 若已建则删除。清理成功 → 抛原始错误码（`file-busy` 409 / `add-partial` 500）；清理失败 → `add-partial` 500，`extra` 带 `{ tempLeft, dirLeft, cause }`。
6. 成功后 `pdfPath = final`；**不写任何 sidecar**（转录/学习档案仍由既有工具按需生成）。

> 与上传路由（`src/host.ts:585-636`）的区别：本函数不读 HTTP body、不做 header 解码、不覆盖、不写磁盘外路径；上传路由保持原样（UI 兼容），**本任务不修它**（§7）。

#### 3.2.5 `movePaper(dataDir, fromTopic, name, toTopic, renameImpl?): MoveResult`

```ts
export interface MoveResult {
  ok: true
  from: string        // 形如 T/P
  to: string          // 形如 S/P
  name: string
  moved: string[]     // 产物文件名（来自 listArtifacts；不含隐藏/未知条目）
  otherEntries: string[] // 论文夹里不属于产物族的条目（随目录一起搬走，如实报告）
  // 会话统计（detachedSessions）由工具层（guards）填：纯函数不依赖 Cordis
}
```

**语义（冻结）**：`move_paper` = **一次目录 rename** `<fromTopicDir>/<name>` → `<toTopicDir>/<name>`；不逐个搬文件、不改文件名、不重建 sidecar。

- 为什么用目录整体 rename：论文夹内的全部产物（`PAPER_STEM_SUFFIXES`/译文变体/`.study.json`/隐藏条目/未知用户文件）都在同一目录树内，同文件系统 rename 是**原子**的（`src/library-manage.ts:1101-1115` 的 `renamePaper` 第一步同款）；逐个搬才需要回滚，且会漏掉未知条目。
- `moved` 通过 `listArtifacts(sourceDir, name)` 计算（只读），`otherEntries` 通过 `readdirSync` 差集计算（只读），用于如实报告。
- 只有 `move_paper` 拒绝旧布局；`delete_paper`/`rename_paper` 仍复用既有函数，旧布局文献可删、可改名（与现有路由/`renamePaper` 的 legacy 分支 `:1086-1087` 一致），不额外加限制。

**前置（全部只读，任一失败零改动）**：

| 检查 | 规则 | 失败码 |
|---|---|---|
| 源专题 | `validateTopicPath(fromTopic,true)` + `resolveExistingTopicDir` | `bad-name`/`not-found`/`escape-rejected` |
| 目标专题 | `validateTopicPath(toTopic,true)` + `resolveExistingTopicDir`（**必须已存在**；历史怪名也可作为目标） | `not-found` 404 |
| 源篇 | `validateEntryBoundary(name)` + `planPaperDelete(dataDir, fromTopic, name)`（`.pdf` 常规文件、产物包含性） | `bad-name`/`not-found`/`escape-rejected` |
| 旧布局 | `plan.layout === 'legacy'`（`src/library-manage.ts:526-527`）→ **拒绝**：`该文献仍是旧布局（未迁移），请先在界面执行迁移后再移动` | `legacy-layout` 409 |
| 同名 | `target === sourceDir`（trim 后同名同专题） | `bad-request` 400 |
| 目标冲突 | `existsSync(target)` 或 `existsSync(toTopicDir/<name>.pdf)` 或 `listArtifacts(toTopicDir,name).length>0` | `target-exists` 409 |
| 自子树 | `target.startsWith(sourceDir + sep)` | `bad-request` 409（与 `renameTopic` `:1232-1235` 同口径） |
| 包含 | `assertInside(realDataDir(dataDir), target)` | `escape-rejected` 400 |

> **红线依据**：旧布局移动会把「平铺产物」变成「论文文件夹」，等于**替用户执行了一篇迁移**；迁移执行只允许在界面（`docs/migrate-prompt-plan.md:338`、`:520-527`、`:631`；`src/host.ts:972-996` 的 `confirm:'migrate-library'`）。因此工具拒绝，并让 agent 如实告诉用户去界面迁移。

**执行与回滚**：
1. 审批通过后：`renameImpl(sourceDir, target)`。
2. 失败：`EBUSY/EPERM` → `file-busy` 409（文案复用 `src/library-manage.ts:1242-1245` 的措辞）；其它带 `.code` 的 errno → `move-partial` 500（`extra.cause`），**零改动**（POSIX rename 失败不改动源/目标）。
3. rename 成功后的后置校验：`isPaperDir(target)`（`src/library.ts:138-145`）且 `!existsSync(sourceDir)`。若不成立 → 尽力 `renameImpl(target, sourceDir)` 回滚；回滚成功 → `move-partial` 500 with `{rolledBack:[name]}`；回滚失败 → `move-partial` 500 with `{rollbackFailed:[name], trashRel:null}`，文案明确「论文在目标路径，请手动检查」。
4. 成功：返回 `from/to/moved/otherEntries`。

### 3.3 `host.ts` 在途检查的复用（最小重构，具体到函数与调用点）

#### 3.3.1 新增 `src/library-guards.ts`（纯逻辑，不 import Cordis/host）

```ts
export interface PaperRefLike { topic: string; name: string }
export interface PaperSessionInfo { total: number; running: number; unknown: boolean }

export interface LibraryGuards {
  readonly dataDir: string
  /** web 侧注入：返回该篇的全部伴读会话（只读）。未注入 ⇒ unknown（fail closed）。 */
  setPaperSessionScanner(fn: ((ref: PaperRefLike) => Promise<Array<{ running: boolean }>>) | null): void
  /** web 侧注入：专题路径变化后的副作用（清 workspace 缓存）。工具成功后调用。 */
  setTopicPathChangedHook(fn: ((topicPath: string) => void) | null): void
  topicPathChanged(topicPath: string): void

  sessionInfo(ref: PaperRefLike): Promise<PaperSessionInfo>
  /** unknown → 503 session-unknown；running>0 → 409 session-running（extra.sessions）。 */
  requirePaperClear(ref: PaperRefLike): Promise<void>
  /** 对 listPapers(dataDir, topic) 的每篇调 requirePaperClear。 */
  requireTopicClear(topic: string): Promise<void>

  paperKey(topic: string, name: string): string // `${topic}\u0000${name}`（与 host 现格式一致）
  topicKey(topic: string): string               // `topic\u0000${topic}`（与 host 现格式一致）
  /** 全部键按字典序排序后一次性尝试；任一已占用 → 抛 ManageError('busy',409,原文案)。 */
  runExclusive<T>(keys: string[], fn: () => Promise<T> | T): Promise<T>
  tryAcquire(keys: string[]): boolean
  release(keys: string[]): void
  /** 保留 host 现有「子串包含」语义（src/host.ts:439-445），不趁重构改行为。 */
  isBusy(scopePath: string): boolean
}
export function createLibraryGuards(dataDir: string): LibraryGuards
```

`requirePaperClear` 的文案/字段必须与现状逐字一致：`session-unknown` 503「暂时无法确认该文献的伴读会话状态…」、`session-running` 409「该文献有 N 个正在运行的伴读会话…」+ `extra.sessions={total,running}`（现状 `src/host.ts:393-404`）。`runExclusive` 的 busy 文案沿用 `src/host.ts:421-425`。

#### 3.3.2 `src/host.ts` 的改动点（函数级）

| 现状 | 位置 | 改法 |
|---|---|---|
| `registerRoutes(ctx, config)` | `:214` | 加可选第三参 `guards: LibraryGuards = createLibraryGuards(resolveDataDir(config.dataDir))` |
| `scanPaperSessions(ref)` | `:254-272` | **保留**；在其定义后 `guards.setPaperSessionScanner(scanPaperSessions)` |
| `dropWorkspaceCache(topicPath)` | `:300-306` | **保留**；在其定义后 `guards.setTopicPathChangedHook(dropWorkspaceCache)` |
| `sessionInfo(ref)` | `:377-385` | 删本地实现，改调 `guards.sessionInfo`；`toWire` 保留给响应整形 |
| `requireSessionClear(ref,res)` | `:393-404` | 删；调用点改 `await guards.requirePaperClear(ref)`（抛出的 ManageError 由外层 `libFail` 输出） |
| `requireTopicSessionsClear(topic,res)` | `:407-412` | 删；调用点改 `await guards.requireTopicClear(topic)` |
| `inflight` Set / `withInflight` | `:421-433` | Set 移入 guards；本地 `withInflight(keys: string[], res, fn)` 保留为薄壳：`if(!guards.tryAcquire(keys)) { json(409 原文案); return }; try{ await fn() } finally { guards.release(keys) }`（原调用点把单个 key 包成数组；按 §3.3.3 扩展的用多键数组） |
| `scopeBusy(scopePath)` | `:439-445` | 删；`:1731` 改 `guards.isBusy(ctx.scopePath)` |
| 锁键集合 | 见下表 | 统一走 `guards.runExclusive(keys, fn)` / `tryAcquire`，键集合扩展到 topic 级（见 3.3.3） |

#### 3.3.3 受影响路由与锁键（全量清单）

| 路由（方法/路径） | handler 位置 | 现状用到的守卫 | 改造后的锁键 |
|---|---|---|---|
| `GET /api/library` | `:546-553` | 无（读） | 无 |
| `POST /api/library/topic` | `:558-581` | 无 | `[topicKey(new)]` |
| `POST /api/library/upload` | `:585-636` | 无 | **不改**（UI 上传；工具不走它） |
| `GET /api/library/paper/delete-plan` | `:679-705` | `sessionInfo`（`:689`） | 无（只读） |
| `POST /api/library/delete-paper`（别名 `paper/delete`） | `:709-732` | `withInflight`（`:715`）、`sessionInfo`（`:719`）、`requireSessionClear`（`:720`）、`zhStatus`（`:721`） | `[topicKey(topic), paperKey(topic,name)]` |
| `POST /api/library/rename-paper`（别名 `paper/rename`） | `:736-762` | `withInflight`（`:743`）、`sessionInfo`（`:749`）、`requireSessionClear`（`:750`）、`zhStatus`（`:751`） | `[topicKey(topic), paperKey(topic,old)]`（新名的冲突由锁内 `renamePaper` 的 `target-exists` 检查兜底；与现状语义一致，不在本批引入新名锁） |
| `POST /api/library/delete-topic`（别名 `topic/delete`） | `:770-814` | `withInflight`（`:781`）、`requireTopicSessionsClear`（`:800`）、`zhStatus` 逐篇（`:803`） | `[topicKey(topic)]` |
| `POST /api/library/rename-topic`（别名 `topic/rename`） | `:817-858` | `withInflight`（`:831`）、`requireTopicSessionsClear`（`:835`）、`sessionInfo`（`:840`）、`zhStatus`（`:846`） | `[topicKey(from), topicKey(to)]` |
| `GET /api/library/topic/clear-plan` | `:863-905` | `sessionInfo`（`:877`）、`zhStatus`（`:878`） | 无（只读） |
| `POST /api/library/topic/clear` | `:911-948` | `withInflight`（`:922`）、`requireSessionClear`（`:933`）、`sessionInfo`（`:934`）、`zhStatus`（`:935`） | `[topicKey(topic)]` |
| `POST /api/library/migrate` | `:972-996` | `withInflight('migrate\0library')`（`:978`） | `['migrate\u0000library']`（不变） |
| `POST /api/library/migrate-rollback` | `:997-1026` | `withInflight('migrate\0library')`（`:1013`） | 同上（不变） |
| `/api/library/ask`（问题入口） | `:1731-1733` | `scopeBusy` | 无（只读提示；改 `guards.isBusy`） |

> 锁键扩展（paper 操作同时拿 topic 键）是**有意的加固**：现状「删除论文」与「清空专题」只共享 `topic\0T` 或只共享 `T\0P`，会交错；统一后工具与路由共享同一把锁。代价是同一专题内的不同论文操作会多串行化一点点（可接受）。风险见 §3.4。

#### 3.3.4 `src/index.ts` 的装配（共享同一实例是硬要求）

```ts
export function apply(ctx: Context, config: PluginConfig = {}) {
  const guards = createLibraryGuards(resolveDataDir(config.dataDir)) // 与 registerTools 内的解析同一路径
  registerTools(ctx, config, guards)
  ctx.inject([...], (rctx) => registerRoutes(rctx, config, guards))
}
```

- 只有**同一个 guards 实例**同时给到工具与路由，`library_manage` 才能看见 HTTP 路由的在途锁（反之亦然）。`registerTools`/`registerRoutes` 的第三参默认值只服务于既有测试（不传时各自新建，互不共享）。
- `resolveDataDir` 会 `mkdir`（`src/library.ts:58-62`）；index 调用一次、registerTools 原本也会调，幂等无害。

#### 3.3.5 工具侧对同一批守卫的调用点

| 工具动作 | 调用 |
|---|---|
| 所有动作 | 先 `guards.runExclusive(keys, fn)`（键集合见 §1.4） |
| delete_paper / rename_paper / move_paper | `await guards.requirePaperClear({topic,name})`；`zhStatus(paperRefFor(dataDir,topic,name))`（`src/translate.ts:42-53`、`src/library.ts:451-464`）→ `translation-busy` |
| delete_topic / rename_topic | `await guards.requireTopicClear(topic)`；再对 `listPapers(dataDir,topic)` 逐篇 `zhStatus` → `translation-busy`（与 `src/host.ts:800-805`、`:834-848` 同序） |
| delete/rename/move 结果 | `detachedSessions = (await guards.sessionInfo(ref)).total`（改名/移动/删除前的统计，与 `src/host.ts:756`、`:852` 同口径） |
| delete_topic/rename_topic 的统计 | 对 `listPapers(dataDir, topic)` 逐篇累加 `(await guards.sessionInfo(p)).total`（子树合计；失败即整体拒绝，不审批） |
| rename_topic / delete_topic 成功后 | `guards.topicPathChanged(topic)`（host 注入 `dropWorkspaceCache`） |
| 所有写动作成功后 | `invalidateMigrationPromptCache(dataDir)`（`src/migrate-prompt.ts:276-279`） |

**重复审批/重复前置的边界**：工具自己调用库函数（`deletePaper` 等），**不经过 HTTP 路由**，所以路由里的前置不会自动生效——这正是 §3.3.5 必须逐项复刻的原因。实现时不得假设「路由已经检查过」。

### 3.4 回归风险（评审请逐条构造探针）

| 编号 | 风险 | 证据/后果 | 缓解/测试 |
|---|---|---|---|
| R1 | `session-running` 响应体少了 `sessions` 字段 | 现有用例 deepEqual 该字段（`test/library-clear-and-busy.test.mjs` 内的会话 409 断言组） | guards 的 `ManageError.extra.sessions` 与现状同形；重跑全量 `npm test` |
| R2 | 前置顺序变化（先翻译后会话等）导致错误码不同 | 现状顺序见 `src/host.ts:719-723`、`:748-753`、`:800-805` | 改造只替换函数名，不调整调用顺序；B 组测试逐条钉住 |
| R3 | fail-closed 退化为 fail-open | 现状 scanner 抛错 → unknown（`:377-385`） | guards 保留 `try/catch → unknown`；测试 D5 |
| R4 | 锁键扩展产生新的 409 `busy` | 以前交错成功的两个请求现在串行/拒绝 | 只影响并发写；不改变成功语义；测试 D3 钉住「拿 topic 锁时 delete-paper 必 409」 |
| R5 | `scopeBusy` 的子串语义被「顺手修好」 | 现状 paper scope（`T/P`）本来就匹配不到 `${T}\0${P}`（`src/host.ts:439-445` 与 `src/scope.ts:158`） | **不修**，原样保留；测试 D9 钉住 topic scope 行为 |
| R6 | 工作区缓存未清 → 删/改名专题后仍指向旧目录 | `src/host.ts:300-306`、`:807`、`:850`、`:941` | 工具成功后调 `topicPathChanged`；测试 D8 用 spy hook 断言 |
| R7 | 迁移提示缓存未失效 → 库已变仍报旧态 | `src/host.ts:505` | 工具写后调 `invalidateMigrationPromptCache`；测试 D10 |
| R8 | 工具与路由**不是同一个 guards 实例** → 锁形同虚设 | `src/index.ts:14-22` 当前只传 config | index 显式创建并双传；测试 D1/D2 用同一实例构造「路由在途 + 工具调用」 |
| R9 | 旧测试的假 ctx 没有 `get` → 新工具一调就 TypeError | `test/migrate-prompt.test.mjs:162-167` | 改测试助手；生产用 `typeof ctx.get === 'function'` 守卫 |
| R10 | `displayReason` 在 0.1.5 类型不存在 | §0.4 | 只用 `reason`；类型本地结构化 |

---

## 4. 拒绝码与文案（冻结）

### 4.1 `ManageCode` → 工具语义（错误消息固定格式）

工具抛出的错误消息统一前缀：`[library_manage:<code>] `（zh 或 en，取决于 `DPR_LIBRARY_MANAGE_LANG`），然后是可执行文案 + 「未做任何改动」声明（若有回滚失败则如实说明）。例：

```text
[library_manage:approval-rejected] 用户拒绝了本次删除；未做任何改动。请如实告知用户，不要重试或绕过。
```

| code | status | zh 文案（要点） | en 文案（要点） | 触发 |
|---|---|---|---|---|
| `bad-name` | 400 | 名字非法/为空/越界（沿用既有中文） | Invalid name | 词法层 |
| `bad-request` | 400（个别 409） | 参数缺失/组合非法/同名/自子树 | Bad request | 参数层 |
| `not-found` | 404 | 专题/文献不存在 | Topic/paper not found | 解析层 |
| `escape-rejected` | 400 | 路径越界，已拒绝 | Path escape rejected | realpath/子路径 |
| `target-exists` | 409 | 已存在同名文献/专题/孤儿产物 | Target already exists | 冲突 |
| `topic-not-empty` | 409 | 专题还有 N 个条目（M 篇文献），请逐篇删除 | Topic not empty | delete_topic |
| `session-unknown` | 503 | 暂时无法确认伴读会话状态，已取消（fail closed） | Session state unknown | guards |
| `session-running` | 409 | 该文献有 N 个正在运行的伴读会话，请先结束 | N running reader sessions | guards |
| `translation-busy` | 409 | 该文献/专题正在生成译文，请等待完成 | Translation in progress | zhStatus |
| `busy` | 409 | 同一目标的另一个操作正在进行，请稍后重试 | Another operation in progress | 锁 |
| `file-busy` | 409 | 文件被占用（阅读器/其他程序），关闭后重试 | File is busy | EBUSY/EPERM |
| `trash-move-failed` | 500 | 移入回收站失败（回滚结论 + 残留清单） | Trash move failed | deletePaper |
| `rename-partial` | 500 | 重命名中途失败（回滚结论 + 残留清单） | Rename partially failed | renamePaper |
| `legacy-layout` | 409 | 该文献仍是旧布局（未迁移），请先在界面执行迁移后再移动 | Legacy layout; migrate in UI first | move_paper |
| `source-not-found` | 404 | 源文件不存在或不可读 | Source not found | add_paper |
| `source-invalid` | 400 | 源必须是常规 PDF 文件（不接受目录/符号链接） | Source must be a regular file | add_paper |
| `source-empty` | 400 | 源文件为空 | Source is empty | add_paper |
| `source-not-pdf` | 400 | 源文件不是 PDF（缺 %PDF- 头） | Source is not a PDF | add_paper |
| `add-partial` | 500 | 收录中断，已清理到零改动 / 残留清单 | Add failed (cleaned up / residue listed) | addPaper |
| `move-partial` | 500 | 移动中断；回滚结论/残留路径 | Move failed; rollback result | movePaper |
| `approval-rejected` | 403 | 用户拒绝了本次操作；未做任何改动 | The user rejected this action; nothing changed | §2.3 |
| `approval-cancelled` | 409 | 审批被取消；未做任何改动 | Approval cancelled; nothing changed | §2.3 |
| `approval-unavailable` | 503 | 审批通道不可用（无服务/无 agent/无 answerer）；未做任何改动 | Approval channel unavailable; nothing changed | §2.3 |
| `confirm-mismatch` | 400 | **工具不使用**（保留给 HTTP 路由；出现即实现错误） | — | 不应出现 |

> 既有中文错误消息（`library-manage.ts` 里现成的文案）保持不变（测试按中文正则断言，见 `test/library-clear-and-busy.test.mjs:104-105`）。en 模式只替换**工具自己生成**的 summary/审批 reason/新错误消息；既有 ManageError 的 zh 文案在 en 模式后面追加 ` (en: <mapped>)`，避免谎称已本地化。

### 4.2 审批 reason 与 render 的语言

- `reason`：固定双语（§2.4），不随 env 变（审批弹窗由用户看，中英都给）。
- `summary`/`render`：随 `DPR_LIBRARY_MANAGE_LANG`（§1.5）。
- persona 增补句子：中文（preset 正文本身中英混排的现状见 `agent.cordis.yml:15-46`），不再加英文重复。

### 4.3 成功结果的可恢复线索（与既有 S15/O4 口径一致）

- 成功响应可带绝对 `trashDir`（既有裁定：成功响应里是刻意的恢复线索，`src/library-manage.ts:374-381`）；**错误响应绝不带绝对路径**，只带 `trashRel`（`:483-486`、`:748-750`）。
- 工具 output 同时给 `trashDir`（nullable）与 `trashRel`（nullable）；render 用 `trashRel`，避免在对话正文里暴露服务端绝对路径（工具结果会进入模型上下文）。

---

## 5. 红线（冻结）

1. **迁移执行不得进工具层**：
   - `library_manage` 的 action 枚举**没有** `migrate` / `migrate_rollback` / `clear_topic`；
   - `src/tools.ts` 顶部 import 不得出现 `runMigration` / `rollbackMigration`（现状 `migration_report` 只 import `planMigration`/`formatMigrationReport`，见 `src/tools.ts:15`、`:678-786`）；
   - 依据：`docs/migrate-prompt-plan.md:338`（「对话侧到此为止：agent 没有任何执行路径」）、`:520-527`（红线①机制）、`:631`（A1 明确否决「带 confirm 参数的执行工具」）。
2. **只读 `migration_report` 保持现状**：不加执行分支、不改尾句「我不会自动执行」（`src/tools.ts:746-756`）。
3. **删除只能进回收站**：工具不直接 `rm/unlink` 用户数据（`deletePaper/deleteTopic` 内部 `rename` 进 `.trash`，`src/library-manage.ts:444-498`、`:566-627`、`:705-754`）；`add_paper` 的临时文件清理是唯一例外，且只清理自己刚创建的 `.tmp-*`/空目录。
4. **不用模型自填确认**：§2.7；任何 `confirm` 参数 = 红线违反。
5. **不改界面**：本批不碰 `lib/client.js`、`reader/`、`dist/`（§7）；工具输出只面向模型/对话。

---

## 6. 测试计划（`test/library-manage-tools.test.mjs`）

### 6.1 测试基座（照抄库内已有做法）

- 只 import `dist/*.js`，跑前 `npm run build`（`package.json:45-49` 的 `pretest` 已自动 build；`test/library-clear-and-busy.test.mjs:11` 的约定）。
- 每个用例都在 `mkdtempSync` 临时库上操作，绝不碰真实 `~/.dsh-paper-reader/data`；`DSH_HOME` 指向临时目录（`test/library-clear-and-busy.test.mjs:28`）。
- 工具注册替身：
  ```js
  function makeTools(dataDir, { approval, guards } = {}) {
    const tools = {}
    const ctx = {
      tools: { register: (x) => { tools[x.name] = x } },
      get: (name) => (name === 'approval' ? approval : undefined),
    }
    registerTools(ctx, { dataDir }, guards)
    return tools
  }
  ```
- 审批替身：记录 `requests[]`，返回可配置的 `outcome`；可配置 `throw`。
- 执行上下文替身：`{ agent: {id:'dpr-...'}, callId: 'call-1', signal: new AbortController().signal, deferContext(){}, concludeTurn(){} }`（形状见 `node_modules/@deepseek-ai/dsh-tools/lib/types/index.d.ts:197-221`、`:284-301`）。
- **零副作用快照**（核心断言）：递归遍历 `dataDir`（**包含 `.trash`**），对每个常规文件算 `sha256` 并记录相对路径；目录记录 `[dir]`，符号链接记录 `[symlink]`。快照前后 `deepEqual`。参考实现：`test/library-clear-and-busy.test.mjs:39-51`（当前只比内容，本套件升级为 sha256 + 路径集合 + 文件数）。
- 路由基座沿用 `test/library-clear-and-busy.test.mjs:224-247` 的 `boot(dataDir)`（假 `webServer/connection/sessionController/...`），用于 D 组「工具 × 路由共享锁」用例。
- 假 babeldoc 造真实 `zhStatus().busy` 的手法沿用 `test/library-clear-and-busy.test.mjs:391-430`（win32 显式 skip 并注明未验证）。
- 变异工具沿用 `test/mutation-probe.mjs:2-16` 的方法论（注入缺陷 → 对应用例必须红 → 还原必须绿）。

### 6.2 用例清单（分组 = 评审可逐组跑 `--test-name-pattern`）

**A. 工具面 / schema / 入参（无审批）**
| ID | 用例 | 断言 |
|---|---|---|
| A1 | 工具 schema 快照 | `name==='library_manage'`；`Object.keys(parameters)` 恰为 `action,topic,name,new_name,to_topic,source_path`；parameters 里**没有** `confirm/confirmName/token/approve`；参数校验提前返回 |
| A2 | action 枚举闭集 | 7 个值逐个可识别；`action:'migrate'/'clear_topic'/''` → `bad-request`；在 `dpr-` 会话 id 下删 `delete_paper` 缺 `name` **仍 400 且不调审批**（钉住 §1.6 不做会话自动绑定） |
| A3 | 必填字段矩阵 | 7 个 action 各缺各的必填字段 → `bad-request`，消息点名缺哪个字段，库快照不变 |
| A4 | 非字符串/畸形参数 | `topic:123`、`name:null`、`source_path:{}` → `bad-request`/`bad-name`，不抛 TypeError |
| A5 | render 双语 | `DPR_LIBRARY_MANAGE_LANG` 未设 → zh summary；设 `en` → en；两条都含目标名/字节等关键数字 |

**B. 审批四态 × 5 个必须审批的 action（核心）**
| ID | 用例 | 断言 |
|---|---|---|
| B1 | 每个 action × `rejected`（5 条或参数化） | 抛 `ManageError{code:'approval-rejected',status:403}`；消息前缀 `[library_manage:approval-rejected]`；`sha256 snapshot` 完全不变（含无 `.trash`）；`approval.requests.length===1` 且 `toolName==='library_manage'`、`callId`/`agent`/`signal` 原样 |
| B2 | 每个 action × `cancelled` | `approval-cancelled` 409；快照不变 |
| B3 | 每个 action × `unavailable` | `approval-unavailable` 503；快照不变 |
| B4 | 每个 action × `allowed-once` | 动作真的发生（文件/目录按预期变化）；`approval.allowed===1`；返回 `approval:'allowed-once'` |
| B5 | 无审批服务 | `ctx.get('approval')` → `undefined` → `approval-unavailable`，快照不变 |
| B6 | 无 agent | `exec.agent=undefined` → `approval-unavailable`，快照不变 |
| B7 | `request()` 抛错 | `approval-unavailable`，快照不变（fail closed） |
| B8 | 闭集外的返回值 | mock 返回 `'allow'`（坏实现）→ `approval-unavailable`，快照不变 |
| B9 | signal 已中止 | `AbortController.abort()` 后调用 → `approval-cancelled`，**不调 request**，快照不变 |
| B10 | 审批前的只读校验失败 → 不打扰用户 | delete 不存在的文献 → `not-found`；`approval.requests.length===0`；快照不变 |
| B11 | 零副作用含 `.trash` | B1–B3 每例都断言 `!existsSync(dataDir/.trash)`（若夹具原本没有） |
| B12 | 创建/收录不审批 | `create_topic`/`add_paper` 成功且 `approval.requests.length===0`；结果 `approval:'not-required'` |

**C. 词法 / 穿越 / 符号链接 / 源文件边界**
| ID | 用例 | 断言 |
|---|---|---|
| C1 | topic 穿越 | `../x`、`A/../../x`、绝对路径、`A//B`、NUL、`%2E%2E%2F`、`.trash` → `bad-name`/`escape-rejected`，快照不变 |
| C2 | name 穿越 | `../p`、`a/b`、`..`、`.`、空串、NUL → `bad-name`，快照不变 |
| C3 | 专题符号链接 | `data/A -> /tmp/outside` → `escape-rejected`（create_topic 目标/其他动作源/目标都测） |
| C4 | 论文目录符号链接 | `data/T/P -> /tmp/outside`（内含 P.pdf）→ delete/rename/move 均 `escape-rejected` |
| C5 | 源文件边界 | source 不存在→`source-not-found`；目录→`source-invalid`；符号链接→`source-invalid`；0 字节→`source-empty`；改名成 `.pdf` 的文本→`source-not-pdf`；以上快照均不变 |
| C6 | 源文件只读 | add 成功后源文件 mtime/sha256 不变、仍存在 |
| C7 | 改名目标的 `.pdf` 后缀 | `rename_paper(new_name:"X.pdf")` → `bad-name` 400（收紧理由见 §3.2.2 注）；库快照不变 |

**D. 在途 / 会话 / 翻译（复用 host 语义）**
| ID | 用例 | 断言 |
|---|---|---|
| D1 | 路由在途 → 工具 busy | `boot(dataDir)` 用同一 guards；让 delete-paper 路由卡在 session 查询（延迟），同时调工具 delete_paper → `busy` 409，快照不变 |
| D2 | 工具在途 → 路由 busy | 工具 acquire 锁后不释放（注入 fn 挂起），POST 路由 → 409 `busy` |
| D3 | 方向锁 | 工具 delete_topic 在途时，同专题 delete_paper 路由 → `busy`（topic 键扩展生效） |
| D4 | 运行中会话 | scanner 返回 `running:true` → `session-running` 409，`extra.sessions` 同形，快照不变 |
| D5 | 会话不可知 | scanner 抛错 / 未注入（headless）→ `session-unknown` 503，快照不变（fail closed） |
| D6 | 翻译在途 | 假 babeldoc 造 `zhStatus().busy`（同 `test/library-clear-and-busy.test.mjs:391-430`，win32 skip）→ `translation-busy`，快照不变 |
| D7 | 成功后的统计 | rename/move/delete 的 `detachedSessions` = scanner 的 `total`（mock 3 → 返回 3） |
| D8 | 钩子 | rename_topic/delete_topic 成功 → `topicPathChanged` hook 收到 topic（spy）；删除论文不触发 topicPathChanged |
| D9 | 读路径 busy 提示 | 持 `topic\0T` 锁时，`guards.isBusy('T')` 为 true（`/api/library/ask` 的范围提示出现）；`isBusy('T/P')` 保持现状 false（不顺手修） |
| D10 | 迁移提示缓存失效 | 旧布局 2 篇夹具：`list_papers` 首次得到 `migration.papers=2`；工具删除 1 篇后再次 `list_papers` 必须得到 1（若未调 `invalidateMigrationPromptCache` 会仍报 2） |

**E. 冲突 / 零覆盖 / 回滚**
| ID | 用例 | 断言 |
|---|---|---|
| E1 | add 目标冲突 | 已存在同名论文夹 / 平铺 `<name>.pdf` / 孤儿 sidecar → `target-exists` 409；原文件 sha256 不变 |
| E2 | add 原子落盘 | 成功：目标 `<T>/<P>/P.pdf` 内容 sha256 == 源；无 `.tmp-*` 残留；目录权限/结构正确 |
| E3 | add 中断清理 | 注入 `copyImpl` 抛 `ENOSPC` → `add-partial` 500；无 `.tmp-*`、无空论文夹、快照不变（**变异靶子 M9**） |
| E4 | move 目标冲突 | 目标已存在论文夹/平铺 pdf/孤儿产物 → `target-exists` 409，快照不变 |
| E5 | move 全产物 | 夹具含 `.pdf/.txt/.pages.json/.transcript.json/.mineru.md/.mineru.json/.embeddings.json/.study.json/-zh.pdf/-dual.pdf` + 隐藏 `.DS_Store` + 未知 `notes.md` → 全部随目录移动，源目录消失，目标目录同名；每个文件 sha256 与移动前一致 |
| E6 | move 失败零改动 | 注入 rename 抛 `EBUSY` → `file-busy` 409；抛 `EXDEV` → `move-partial` 500；两种快照均不变 |
| E7 | move 后置校验失败回滚 | 注入 rename 使目标“改名成功后源仍在”或目标不是论文夹 → `move-partial` + `rolledBack`；快照不变；回滚也失败时 extra.rollbackFailed 如实列 |
| E8 | move 旧布局拒绝 | 平铺 `<T>/P.pdf` 夹具 → `legacy-layout` 409；消息含「界面」；快照不变（**红线**） |
| E9 | move 自子树 | 目标专题是 `T/P/Sub` 形态（构造 under source）→ `bad-request` 409，快照不变 |
| E10 | rename 冲突/回滚 | 复用既有 `renamePaper` 语义：目标名已存在 → `target-exists`；注入 EBUSY → `file-busy` 且库不变（既有测试已覆盖逻辑，本套件只验证工具映射） |
| E11 | delete 回收站可恢复 | delete_paper 后：`trashDir` 存在、manifest 含 `relativeDir/files`；把文件按相对路径移回 → 库恢复（内容 sha256 一致） |
| E12 | delete_topic 非空 | 非空专题 → `topic-not-empty` 409（带 `entries/papers`），不审批、快照不变 |
| E13 | delete_topic 空+隐藏 | `.DS_Store` → 删除成功、隐藏条目在回收站、`trashRel` 有值；无隐藏 → `trashDir:null` |
| E14 | create_topic 幂等 | 首次 `created:true`；再次 `created:false`，库快照不变（不覆盖已有目录内容） |
| E15 | 失败回滚不留空 bundle | E6/E7/E12 后 `.trash` 不新增空目录（deleting 的既有不变量） |

**F. 红线 / 回归**
| ID | 用例 | 断言 |
|---|---|---|
| F1 | 无迁移执行 | `library_manage` action 枚举不含 `migrate*`；`src/tools.ts` 文本不含 `runMigration`/`rollbackMigration`；调用 `action:'migrate'` → `bad-request`；全流程后无 `migration-logs/` 新文件 |
| F2 | `migration_report` 不变 | 调用前后快照不变；输出 `ok` 且尾句含「我不会自动执行」（`src/tools.ts:753`） |
| F3 | 既有全套回归 | `npm test` 全绿（重点 `library-*`、`migrate-prompt`、`reader-ux-*`） |
| F4 | 工具不写 sidecar | add_paper 后只有 `<P>.pdf`，没有 `.txt/.pages.json/...`（产物由既有工具按需生成） |
| F5 | 错误响应无绝对路径 | 所有失败用例的消息/extra 不含 `dataDir` 绝对路径（只允许 `trashRel`） |

### 6.3 给评审的变异靶子（实现方必须把这些加进 `test/mutation-probe.mjs` 的 `MUTATIONS`）

| ID | 注入（文件:锚点） | 必须变红的用例 | 说明 |
|---|---|---|---|
| M1 | `src/tools.ts` / 工具内审批分支：`if (outcome !== 'allowed-once')` → `if (false)` | B1–B3 | 绕过审批 |
| M2 | `src/tools.ts` / parameters 加 `confirm` 字段 | A1 | 模型自填确认 |
| M3 | `src/tools.ts` / `rejected` 分支改为 `return` 继续 | B1 | 拒绝当允许 |
| M4 | `src/tools.ts` / `unavailable` 分支改为继续 | B3 | fail open |
| M5 | `src/tools.ts` / 去掉 `exec.agent === undefined` 检查 | B6 | 无 agent 继续 |
| M6 | `src/tools.ts` / 审批调用移到 `planPaperDelete` 之前 | B10 | 先打扰用户再校验 |
| M7 | `src/library-manage.ts` / `addPaper` 去掉目标冲突检查 | E1 | 覆盖已有文献 |
| M8 | `src/library-manage.ts` / `addPaper` 去掉 `%PDF-` 检查 | C5 | 非 PDF 入库 |
| M9 | `src/library-manage.ts` / `addPaper` 失败时不删 tmp | E3 | 残留临时文件 |
| M10 | `src/library-manage.ts` / `movePaper` 改成逐个 copy+unlink（非原子） | E6/E7 | 破坏原子性/回滚 |
| M11 | `src/library-manage.ts` / `movePaper` 去掉 `legacy-layout` 拒绝 | E8 | 对话侧执行迁移 |
| M12 | `src/library-manage.ts` / `movePaper` 去掉自子树检查 | E9 | 移进自己子树 |
| M13 | `src/library-guards.ts` / `tryAcquire` 直接返回 true | D1–D3 | 锁失效 |
| M14 | `src/library-guards.ts` / `requirePaperClear` 空实现 | D4/D5 | 会话前置失效 |
| M15 | 工具内删掉 `zhStatus(...).busy` 检查 | D6 | 翻译前置失效 |
| M16 | `src/library-manage.ts` / `deletePaper` 改为 `rmSync(recursive)` | E11 | 不可恢复删除 |
| M17 | `src/tools.ts` / 审批前调用 `newTrashBundle` | B11 | 非 allowed-once 也写盘 |
| M18 | `src/host.ts` / `session-running` 响应去掉 `sessions` | 既有 `library-clear-and-busy` 用例 | 回归网 |
| M19 | `src/index.ts` / 工具与路由各建一个 guards | D1/D2 | 假共享 |
| M20 | `src/tools.ts` / 增加 `migrate` action 或 import `runMigration` | F1 | 红线 |

### 6.4 运行命令（实现/评审轮）

```bash
cd .worktrees/library-manage-tools
npm run build
node --test --test-timeout=60000 --test-concurrency=1 test/library-manage-tools.test.mjs
npm test                                         # 全量回归（F3）
node test/mutation-probe.mjs --only L             # 新增 L 组变异（实现方扩展）
```

### 6.5 平台备注

- Windows：假 babeldoc 的 `#!/bin/sh` 造不出 `translation-busy`（与 `test/library-clear-and-busy.test.mjs:391-397` 同因），D6 在 win32 **显式 skip 并注明未验证**，不得写成永真。
- 大小写不敏感文件系统：`target-exists` 的「大小写-only 改名」放行逻辑在 `renamePaper` 内（`src/library-manage.ts:1093-1099`）；本套件沿用既有判定，不为工具新增分支。
- 硬链接不可用的文件系统（FAT/exFAT）：`addPaper` 的 `linkSync` 会回退 `renameSync`（§3.2.4 第 4 步）；E2 在 Linux/macOS 正常路径覆盖，回退分支用 `linkImpl` 注入 `EPERM` 单测。

---

## 7. Out of scope（冻结）

1. **任何 UI 改动**：`lib/client.js`、`reader/index.html`、侧栏/设置面板/审批面板样式；本批只加 agent 工具。
2. **`lib/`、`dist/`**：不改动浏览器半边与构建产物；`dist/` 不入库。
3. **部署**：不改 `~/.dsh`、不 `dsh plugin add`、不重启 profile；验证用临时工作树。
4. **git 操作**：不 push、不合并主分支、不改其它分支；本分支只提交 `docs/`（本轮）与后续实现。
5. **迁移执行/回滚工具化**：不加 migrate/rollback/clear action；`migration_report` 保持只读（§5）。
6. **批量清空（clear_topic）**：保留为界面能力（`src/host.ts:907-948`）；工具只允许逐篇删除。
7. **回收站恢复工具**：本批不做 restore/undo（恢复仍按 §3.2/§4.3 的 `trashRel` 手工移回）。
8. **上传路由的重写**：`POST /api/library/upload` 的覆盖/非原子问题（`src/host.ts:629-634`）本批**不修**（避免动 UI 契约）；`add_paper` 用新函数，不复用它。
9. **文档用户手册**：README/docs/features 的功能描述更新由后续文档轮处理；本文件只需被 `git add`（README 守卫要求 docs 引用可解析，见 `AGENTS.md` 的「README 守卫」——本文件不被 README 引用，不需要改 README）。
10. **模型级独立测试**：不做「换模型重跑」的对照（团队协议已说明以方法独立性补偿）。

---

## 8. 验收对照（t1 acceptance → 本文件位置）

| acceptance | 位置 |
|---|---|
| docs 覆盖 objective 1–7、每项有 file:line | §1、§2、§3、§4、§5、§6、§7；锚点表 §0.3/§0.4 |
| 审批矩阵四态 + 非 allowed-once 零副作用 + fail closed | §2.3（矩阵 + fail-closed 表）、§6 B1–B11 |
| 工具 schema 与拒绝码可直接照做（参数名/类型/required/错误码明确） | §1.2、§1.3、§1.6、§4.1；新函数签名 §3.2 |
| move/add 的安全边界、冲突与回滚写死（realpath/非 PDF/空/覆盖） | §3.2.4、§3.2.5、§6 C/E |
| host 在途检查复用具体到函数与调用点 + 受影响路由 | §3.3.2、§3.3.3、§3.3.5；风险 §3.4 |
| 工作树已建 + 分支正确 + typecheck 通过 | §0.1 |
| docs 提交到分支、git status 干净、未改 src/test/lib | §0.1；本轮 commit 见 `git log -1 --stat` |

---

## 9. 待验证清单（实现/评审接手）

| # | 事项 | 现状证据 | 验证方法 |
|---|---|---|---|
| V1 | paper preset 会话的审批 UI 真机可达 | §2.6 静态证据；`dsh-base/cordis.patch.yml:245-248` + `dsh-web-app/cordis.patch.yml:311-312` + `client-ui-approval/lib/client.js:343-357` | §2.6 的 1–5 步（真机点击 + 审计事件） |
| V2 | 0.1.5-rc.3 的 `ApprovalService.request` 在无 open turn 时确实 reject | 类型注释 `…/index.d.ts:110-127` | 单测：mock 一个 reject 的 request → B7 断言 `approval-unavailable` |
| V3 | 硬链接落盘在用户文件系统可用（macOS APFS/Linux ext4/NTFS） | §3.2.4 | E2 在 CI 三平台跑；不可用平台走 `linkImpl` 注入 EPERM 的回退分支单测 |
| V4 | 锁键扩展不破坏既有并发用例 | §3.4 R4 | `npm test` 全量 + D1–D3 |
| V5 | `scopeBusy` 的 paper scope 历史缺陷不被误修 | §3.4 R5 | D9 钉住 topic scope；paper scope 维持现状并在实现注释标注「不在本批修」 |

---

## 附录 A：新增/修改文件清单（供 t2 排期）

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/library-manage.ts` | 改 | 新错误码（§3.2.1）、`validatePaperName` 拆分（§3.2.2）、`createTopic`、`addPaper`、`movePaper`（§3.2.3-3.2.5）；不改既有函数语义 |
| `src/library-guards.ts` | 新增 | §3.3.1 的 guards（session/翻译前置、锁、hooks） |
| `src/tools.ts` | 改 | 注册 `library_manage`（§1.2/§1.3/§1.4）；工具内的审批门（§2.3）与 action 编排；`registerTools` 加可选 guards 参数 |
| `src/host.ts` | 改 | §3.3.2 的替换点；锁键扩展；`registerRoutes` 加可选 guards 参数 |
| `src/index.ts` | 改 | 创建共享 guards 并双传（§3.3.4）；启动日志加工具名（§1.7） |
| `presets/paper-reader/agent.cordis.yml` | 改 | §1.7 的 persona 句子 + 头部注释工具清单 |
| `test/library-manage-tools.test.mjs` | 新增 | §6.2 全部用例 |
| `test/mutation-probe.mjs` | 改 | §6.3 的 M1–M20（L 组） |
| `docs/features.md` / `docs/features_EN.md` | 不改（out of scope） | 用户向文档后续轮补 |

## 附录 B：一句话给实现者

> 所有写操作 = `library-manage` 的既有函数；新增的只有「建空专题 / 原子收录 / 整目录移动」三个纯函数 + 一个共享 guards 模块；破坏性动作的顺序永远是「只读校验 → 锁 → 会话/翻译 → `ctx.approval.request` → 执行」，`allowed-once` 之外的任何结果都必须在**第一字节写入之前**停下。
