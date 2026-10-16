# 「未迁移提示」冻结方案（v1）

> 任务：t1（需求/方案轮）。作者：researcher。基线取证见 §0——**先读 §0.1，它决定 t2 从哪条分支切**。
> 纪律：本方案**只出方案不改代码**；不 commit / 不 push；未跑真实库迁移；未改主工作区源码。
> 产物：本文件 + `.probe/migrate-prompt/`（探针脚本与原始输出）。
>
> ⚠️ **UI 侧已被取代（本轮，逐条对照见 §9）**：本文 §3（界面侧入口/文案/弹层）与 §4 红线①里
> 「键入 `migrate` 才可执行」的描述，已被**逐篇状态面板 + 警示后一次点击确认**取代（本轮设计冻结见
> `docs/migrate-ui-requirements.md`）。**不被取代**的部分：§1–§2 的判据与对话侧提示（`list_papers` 的
> `migration` 字段、`migration_prompt_choice`）、`migration_report` 只读工具、CLI 干跑报告与 `--apply --yes`、
> 后端 `GET /api/library/migrate-plan` 与 `confirm:'migrate-library'` 栅栏，全部保留。

---

## 0. 基线与取证

### 0.1 基线声明（⚠️ 队长必读：任务描述的「最新 main」与磁盘事实不一致）

本机实测（`git fetch origin` 后）：

| 事实 | 命令 | 结果 |
|---|---|---|
| 上游 `origin/main` **没有**迁移代码 | `git cat-file -e origin/main:src/migrate.ts` | `fatal: path 'src/migrate.ts' does not exist in 'origin/main'` |
| `origin/main` 尖端 | `git log --oneline -1 origin/main` | `ec21969 docs: README 瘦身…` |
| 迁移/深色/子专题/按范围提问这批代码在哪 | `git rev-list --count origin/main..feat/darkmode-subtopic` | **15** 个提交，尖端 `fdb45f2`（= `fork/feat/darkmode-subtopic`，工作树 `/tmp/dpr-feat`；`/tmp/dpr-crlf` 是它的 detached 检出） |
| 迁移的起点提交 | `git log --oneline --all -- src/migrate.ts` | `9b8120f feat(migrate): 旧平铺布局 -> 按论文分文件夹…` `…` `fdb45f2 fix(migrate): 入口判定…` |
| 共享工作区的 HEAD | `git rev-parse --abbrev-ref HEAD` | `feat/selection-translate` @ `690fb44`（**另一条 PR 线**，同样没有 `src/migrate.ts`） |

**结论（P0 决策点）**：本方案一切 `file:line` 以 **`fdb45f2` 的工作树**为准（下称「基线树」）。
t2 若按字面「从最新 main 切分支」，会切出一条**没有 `src/migrate.ts`** 的分支，功能无从落地。
请队长裁定基线 = `fdb45f2`（或它合并成的集成分支），并要求 t2 从该提交切 worktree 到 `/tmp`。
本方案不自行改动分支/工作区。

另：t2 合同里的测试基线 `533/506/0/27` 由队长给定；本方案未重跑全量套件（非本任务验收项）。

### 0.2 现状锚点（全部为基线树 `fdb45f2` 的 file:line）

| 主题 | 锚点 | 事实 |
|---|---|---|
| 完成标记 / 部分完成标记 | `src/migrate.ts:25`、`:27` | `DONE_MARKER = '.migration-v1.done'`、`PARTIAL_MARKER = '.migration-v1.partial.json'` |
| 只读干跑（权威判据） | `src/migrate.ts:157-321` | `planMigration()`：`readdirSync` 遍历（`paperDirs` 命中即**不递归**，`:189-196`）、按 `matchArtifactName` 精确匹配产物（`:206-221`）、分类 `moves/alreadyDone/conflicts/quarantine/orphans/hidden/unreadable`（`:246-292`）、`totals`（`:311-317`）、读标记（`:318-319`） |
| 平铺扫描与 legacy 标记 | `src/library.ts:160-203`（`legacy: true` 在 `:185`） | 平铺 `<topic>/<名>.pdf` 仍被列为文献并带 `legacy:true`；**同名文件夹存在时平铺不再单列**（`:184` 文件夹赢） |
| 论文目录不变量 | `src/library.ts:138-145` | 目录内有 `<目录名>.pdf` 常规文件 ⇒ 论文目录 |
| 平铺路径回落 | `src/library.ts:206-212` | `paperPdfPath()`：论文夹优先，回落平铺 |
| `resolveDataDir()` **会 mkdir** | `src/library.ts:58-62` | ⇒ 判据**不得**调用它（否则「只读/不存在」场景会写盘，破红线④） |
| 产物后缀族 | `src/library-manage.ts:282-283`、`:302-309` | `PAPER_STEM_SUFFIXES` / `PDF2ZH_VARIANT_SUFFIXES` / `matchArtifactName()`（精确匹配，刻意不用 `startsWith`） |
| pdf2zh 变体不算文献 | `src/library.ts:45-49` | `isPaperPDF()` 排除 `-en/-zh/-dual` |
| 迁移日志落在库外 | `src/migrate.ts:107-109` | `migrationLogDir()` = `$DSH_HOME/.dsh-paper-reader/migration-logs`（`dshHome()` 见 `src/library.ts:52-55`） |
| HTTP 迁移路由 | `src/host.ts:938-946`（GET plan）、`:948-971`（POST，门 = `confirm:'migrate-library'`，`:950-952`）、`:973-998`（rollback，门 = `confirm:'rollback-library'`，`:975-977`） | 执行有两道显式门 |
| `/api/library` | `src/host.ts:531-538` | 返回 `{dataDir, topics, papers, tree}`；`papers` 直接带 `legacy`（`:534` 只补 `pdfPath`） |
| CLI 门 | `src/migrate.ts:694-750`（`--apply` 必须 `--yes`，`:720-723`；退出码契约 `:685-693`） | 无 `--yes` 直接 `64` |
| 对话侧工具 | `src/tools.ts:118-162`（`list_papers`）、`:164-238`（`transcribe_pdf`）、`:239-…`（`search_paper`）、`:412-…`（`study_progress`） | `list_papers` 的 `output.schema` 是 `{dataDir,topics,papers}` + `additionalProperties:false`（`:129-148`），`render` 生成文本（`:149-156`）；`registerTools` 在 `:118`，`resolveDataDir(config.dataDir)` 在 `:119` |
| **工具层无法触达迁移** | `grep -n "migrate\|runMigration" src/tools.ts src/index.ts` → 空 | 今天对话侧**没有任何**执行迁移的路径（红线①的现状基础） |
| 设置面板 | `lib/client.js:1690-1708`（`SettingsPanel`）、`:1521-1533`（`SET` 样式表）、`:1818-1859`（`apply()` 注册 `settings.section`，`:1856-1859`） | React 自绘，样式一律用 `--dsw-alias-*` 变量 |
| 侧栏文献库树 | `lib/client.js:860`（`LibraryTree`）、`:1346-1368`（wide 渲染：头 `:1353-1358`、树行 `:1367`）、`:1475-1495`（按需注册 `sidebar.workspaces`） | 横幅的插入点 = `:1359` 之前 |
| zh/en 词典 | `lib/client.js:92-193`（zh）、`:194-285`（en）；`t()`/`setT()` 在 `:287-288` | 中英双份；测试会正则抓词典断言（`test/darkmode-subtopic-features.test.mjs:352-364`） |
| 改名搬家的键前缀 | `lib/client.js:350-379` | `migrateLsKeys` **只搬** `dpr.variant.`（`:356`）与 `dpr.sessionN.`（`:363`）两个前缀，另只改 `dpr.last`（`:374-377`） |
| 全局键先例 | `lib/client.js:36-37`、`:69-79`、`:1595-1610` | `dpr.syncScroll`：**无 topic/name、不属那两个前缀 ⇒ 改名/移动都不可能搬丢**（`：69-74` 逐字写了这条论证） |
| storage 同步先例 | `lib/client.js:1598-1605` | 跨文档（设置面板 ↔ 阅读器 iframe）用 `storage` 事件同步同一个键 |
| 阅读器壳 | `reader/index.html:214-242`（`#bar` 工具栏）、`:243-245`（`#main`）、`:291-330`（`#cfg-pop` 浮层）、`:389`（`api()` 助手）、`:2`（`lang="zh"`）、`:223`+`:2266-2267`（**双语 inline** 的既有写法：`同步滚动 / Sync scroll：…`） | 阅读器**没有** i18n 词典，双语靠 inline 拼 |
| 迁移的冻结语义（上一批裁定） | `/tmp/dpr-feat/docs/darkmode-subtopic-plan.md:546-566`（§B1.4）、`:926-994`（附录 Z；`:938` 明确「legacy 标记（UI/迁移据此提示）」；Z.4 第 3 条：本批**不删** legacy 双读分支） | 提示功能是上一批明确留给「UI/迁移」的接口 |

### 0.3 本轮取证（探针与实测输出）

`.probe/migrate-prompt/`（只写 `/tmp` 夹具库，**不碰**真实库 `~/.dsh-paper-reader/data`；目录说明见该目录 `README.md`）：

| 文件 | 作用 |
|---|---|
| `probe-criterion.mjs` | 用**既有** `dist` 的 `planMigration()`/`listPapers()` 在 **12 个夹具库**上推导判据原型，并交叉核对两条来源 |
| `probe-criterion-output.txt` / `.json` | 原始输出（下表数据来源） |
| `probe-cost.mjs` / `probe-cost-output.txt` | 判据三种实现的代价实测（§1.4 红线③用） |

**12 个夹具的实测结果**（`node .probe/migrate-prompt/probe-criterion.mjs`）：

| 夹具 | state | 还有 N 篇（分类） | 可迁移 | 文件 | 标记 | 判据完整 | 可发问 | `plan.totals.papers` |
|---|---|---|---|---|---|---|---|---|
| F1 纯旧布局 | unmigrated | 3（flat 3） | 3 | 9 | 无 | ✅ | ✅ | 3（一致） |
| F2 已迁移 + `.done` | migrated | 0 | 0 | 0 | done | ✅ | ✖ | 0 |
| F3 `.done` 在、但有平铺论文 | **marker-mismatch** | 1（flat 1） | 1 | 3 | done | ✅ | ✅ | 1 |
| F4 **无标记但已是新布局** | migrated | 0 | 0 | 0 | 无 | ✅ | ✖ | 0 |
| F5 文件夹赢 + 平铺残留（同内容） | residue | 1（residue 1） | 1 | 3 | 无 | ✅ | ✅ | 1 |
| F6 残留但**内容不同** | needs-manual | 1（conflict 1） | 0 | 1 | 无 | ✅ | ✖ | **0（少算！）** |
| F7 子树 `chmod 000` | **unknown** | 1（**不用于文案**） | 1 | 3 | 无 | ❌（`unreadable=[{dir:"B私有",cause:"EACCES"}]`） | ✖（不误报） | 1 |
| F8 名太长（quarantine）+ `.partial` | needs-manual | 1（quarantine 1） | 0 | 3 | partial | ✅ | ✖ | **0（少算！）** |
| F9 只有孤儿文件 | migrated | 0 | 0 | 0 | done | ✅ | ✖ | 0 |
| F10 空库 | empty | 0 | 0 | 0 | 无 | ✅ | ✖ | 0 |
| F11 `.partial` + 还有可迁移平铺 | partial | 1（flat 1） | 1 | 3 | partial | ✅ | ✅ | 1 |
| F12 `.partial` 残留但已无平铺 | migrated | 0 | 0 | 0 | partial | ✅ | ✖ | 0 |

**三个由实测（而非推演）得到的关键结论**：

1. **`plan.totals.papers` 不能当提示数字**：F6/F8 里磁盘上明明还留着平铺产物，`totals.papers` 却是 **0**（conflict/quarantine 被从 `moves/alreadyDone` 里剔掉了，`src/migrate.ts:297`、`:311-317`）。若拿它报数 → 「无需迁移」的假结论。
2. **只跑 `listPapers()` 也不够**：F5 的平铺副本被「文件夹赢」（`src/library.ts:184`）掩掉，`legacy` 为 0，但平铺文件仍在。
3. **「只看标记」会双向出错**：F4（无标记、已是新布局）会被误报成「未迁移」；F3/F8/F11（标记说完成/部分，实际还有平铺）会被漏报。⇒ 判据必须**实际扫目录**，标记只当「元信息」用来如实表达分歧。

**交叉核对（探针内置）**：便宜的「只 readdir + 比 size」扫描与既有 `planMigration()+listPapers()` 在 12 个夹具上 **`onlyPlan=[]、onlyScan=[]、classMismatch=[]`（零差异）** ⇒ 判据可以**不 hash 文件内容**就得到与权威报告一致的「还有 N 篇 + 分类」。这是 §1 判据敢用轻扫描的依据。

**复跑方式**（实现/验证轮自查用）：

```bash
# 0) 探针不 import 源码，只 import 编译产物 ⇒ 先有一份 fdb45f2 的 dist
git -C /home/vr/My_Projects/dsh-paper-reader worktree add /tmp/dpr-base fdb45f2   # 或用集成分支
cd /tmp/dpr-base && ln -s <既有 node_modules> node_modules 2>/dev/null; npm run build
# 1) 跑判据原型（12 个夹具，全部在 /tmp 里创建与清理）
DPR_DIST=/tmp/dpr-base/dist node .probe/migrate-prompt/probe-criterion.mjs          # 人类可读
DPR_DIST=/tmp/dpr-base/dist node .probe/migrate-prompt/probe-criterion.mjs --json    # 机器可读
# 2) 跑代价实测
DPR_DIST=/tmp/dpr-base/dist node .probe/migrate-prompt/probe-cost.mjs 300
```

本机跑这两条时的 `DPR_DIST` 是 `/tmp/t1-probe/dist`（从基线树的构建产物 `/tmp/dpr-crlf/dist` 复制而来）；探针只用它做 import，不修改它。

---

## 1. 未迁移态的准确判据（冻结）

### 1.1 判据定义

新增模块 **`src/migrate-prompt.ts`**（纯 Node，不依赖 Cordis，便于测试与工具/路由共用）：

```ts
export type MigrationClass = 'flat' | 'residue' | 'conflict' | 'quarantine'
export type MigrationState =
  | 'unmigrated'      // 有平铺论文（无同名文件夹）
  | 'residue'         // 文件夹已赢，平铺副本还在（只差清源）
  | 'partial'         // 上次写了 .partial（有跳过项），且仍有可迁移的平铺论文
  | 'marker-mismatch' // 有 .done/.partial 标记，但实际仍有平铺产物（用户手动动过文件）
  | 'needs-manual'    // 只剩 conflict / quarantine：迁移也修不了，须人工
  | 'migrated'        // 实际扫描无平铺产物（无论有无标记）
  | 'empty'           // 库里还没有论文
  | 'unknown'         // 读不进去 / 扫描预算超限 ⇒ 无法判定（不得猜）

export interface MigrationNeed {
  dataDir: string; scannedAt: string
  state: MigrationState
  papers: number                                   // ★ 文案里的「还有 N 篇」
  files: number                                    // 这些论文留在平铺位置的产物文件数
  byClass: Record<MigrationClass, number>
  migratable: number                               // flat + residue（迁移真正能收口的篇数）
  orphans: number; paperDirs: number
  unreadable: Array<{ dir: string; cause: string }>
  certain: boolean                                 // unreadable.length === 0 && !budgetExceeded
  markers: { done: boolean; partial: boolean }
  markerSync: 'none' | 'conflict' | 'stale'        // 标记与实际的**关系**（如实表达用）
  fingerprint: string                              // sha256(path|class … + unreadable 计数) 前 12 位
}
export function detectMigrationNeed(dataDir: string, opts?: { force?: boolean; hash?: boolean }): MigrationNeed
```

**扫描算法（逐条冻结，与 `planMigration()` 的遍历口径**必须**一致）**：

1. 根 = `resolve(config.dataDir ?? DSH_PAPER_READER_DATA ?? ~/.dsh-paper-reader/data)`；
   **不调用 `resolveDataDir()`**（它会 `mkdirSync`，`src/library.ts:58-62`）——不存在就按 `empty` 处理并立即返回。
2. 逐层 `readdirSync(withFileTypes)`；命中论文目录（`isPaperDir`，`src/library.ts:138-145`）⇒ 登记 stem 后**不递归**（结构不变量，防套娃）；
   `.` 开头且非论文目录 ⇒ 跳过（与 `listPapers` 同口径）；`readdir` 抛错 ⇒ 记入 `unreadable` 并**继续**其它子树。
3. 每个目录内收集 stem：`①` 平铺 `<名>.pdf` 且 `isPaperPDF()`（排除 `-en/-zh/-dual`，`src/library.ts:45-49`）；`②` 已存在的论文目录名。
4. 按 `matchArtifactName(stem, entry)`（`src/library-manage.ts:302-309`）统计该 stem 的平铺产物数 `flatCount`。
5. 分类：
   - `flatCount > 0` 且**无**同名文件夹 ⇒ `flat`；
   - 有文件夹，且每个平铺产物在文件夹里的同名文件**size 相同**（不 hash）⇒ `residue`；
   - 有文件夹，但存在同名文件缺失或 size 不同 ⇒ `conflict`；
   - `paperDirNameProblem(stem)`（`src/migrate.ts:806-808`）非空 ⇒ `quarantine`（这一类**只能**由该函数判定，文件系统上看不出来）。
6. `papers = |{stems with flatCount>0}|`，`files = Σ flatCount`，`migratable = byClass.flat + byClass.residue`。
7. `certain = unreadable.length === 0 && !budgetExceeded`；扫描预算 `MAX_SCAN_ENTRIES = 20000`（readdir 条目计数），超限置 `budgetExceeded` 并把 state 降为 `unknown`。
8. `markerSync`：`papers > 0 && (done || partial)` ⇒ `conflict`；`papers === 0 && partial && !done` ⇒ `stale`；否则 `none`。
9. `fingerprint` 必须**含分类**：`sha256(sorted("path|class") + "\nunreadable:" + n)`。
   （实测教训：只 hash 路径时 F5-residue 与 F6-conflict 撞同一个指纹 ⇒ 从「残留」恶化为「冲突」时反而不再提示。）
10. `state` 由 `papers / byClass / certain / 标记` 按 §1.2 表得出。

**判据与权威报告的边界（必须写进代码注释与文案）**：本判据是 **size 级**的（不读文件内容），
迁移干跑报告（`GET /api/library/migrate-plan`）是 **hash 级**的权威。两者在 12 个夹具上零差异（§0.3），
但文案只给**篇数**、不展开 `residue/conflict` 的细节；细节一律以报告为准（避免把 size 级的判断说成结论）。

### 1.2 状态机（判据 → 提示级别 → 是否发问）

```
                     ┌─ certain=false ─────────────────────────► info（不说篇数）
papers>0 ────────────┤
                     ├─ flat>0 且 .done ───────────────────────► marker-mismatch（ask）
                     ├─ flat>0 且 .partial ────────────────────► partial（ask）
                     ├─ flat>0 且 无标记 ──────────────────────► unmigrated（ask）
                     ├─ migratable>0（residue）───────────────► residue（ask）
                     └─ migratable==0（只剩 conflict/quarantine）► needs-manual（info，不问）
papers==0 ∧ certain ─┬─ done ∨ paperDirs>0 ────────────────────► migrated
                     └─ 其它 ────────────────────────────────► empty
```

发问门（纯函数，便于单测；**服务端强制**，不依赖 agent 自觉）：

| 判据 state | `choice=idle` | `choice=asked` | `choice=later` | `choice=declined` |
|---|---|---|---|---|
| `unmigrated`/`residue`/`partial`/`marker-mismatch`（`migratable>0`） | **ask** | 同 fingerprint → info；**fingerprint 变了 → ask**（情况变了，带新数字再问一次） | 同 `asked` | **永不 ask**（除「重新检查」） |
| `needs-manual` | info | info | info | info |
| `unknown` | info（无篇数） | info | info | info |
| `migrated` / `empty` | silent | silent | silent | silent |

**`ask` 一旦被服务端给出，就写 `choice='asked'`**（`at/declaredPapers/fingerprint/by`）⇒ 同一 fingerprint 下**第二次调用绝不再 ask**（红线②的服务端保证）。
`declined` 是**吸态**：任何检测（含新论文出现）都只降级为 info，只有用户显式「重新检查」才回 `idle`。

### 1.3 「标记与实际不符」如何如实表达（冻结文案）

| 情形 | `markerSync` | 表达 |
|---|---|---|
| `.done` 在，实际还有平铺 | `conflict` | 明确说**不一致**，并说明以实际扫描为准：`注意：检测到「已完成」标记，但目录里确实还有 N 篇处于旧布局——标记与磁盘不一致（可能你手动动过文件）。以实际扫描为准。` |
| `.partial` 在，实际还有平铺 | `conflict` | `检测到「部分完成」标记（上次有跳过项），且仍有 N 篇处于旧布局：需要先处理上次的跳过项，再跑迁移。` |
| `.partial` 残留，实际已无平铺 | `stale` | 只**备注**、不报警：`上次迁移留下了「部分完成」标记，但当前没有发现平铺产物（可能你已自行整理）。` |
| 无标记，实际已无平铺（F4） | `none` | **什么都不说**（绝不因为「没有标记」就说未迁移） |
| 无标记，实际有平铺 | `none` | 只说未迁移，不提标记 |

### 1.4 代价与缓存（红线③的依据）

实测（`node .probe/migrate-prompt/probe-cost.mjs 300`；每态 300 篇 × 4 文件 = 1200 文件）：

| 场景 | `listPapers()` | `planMigration()` | 轻扫描（本方案判据的原型） |
|---|---|---|---|
| 全旧布局 | 7.1 ms | 57.9 ms | 36.1 ms |
| 已迁移（新布局） | 1.4 ms | 2.3 ms | 1.1 ms |
| 残留（两端各一份，会触发 sha256） | 2.2 ms | 61.3 ms | 32.6 ms |

⇒ 单次判据成本是**几十毫秒级**（真实库 14.3 MiB，见原方案 §B1.2），但 `list_papers` 会被频繁调用，故**必须**：

- 进程内缓存 `MigrationNeed`，TTL 默认 **60 s**（`DPR_MIGRATE_PROMPT_TTL_MS`）；
- 失效点：`POST /api/library/migrate` 成功、`POST /api/library/migrate-rollback` 成功、上传/删除/改名/新建专题/清空专题、`force`（＝「重新检查」）；
- 判据**绝不抛**：任何异常 → `state:'unknown'` + `certain:false` + 不写偏好；
- 逃生开关 `DPR_MIGRATE_PROMPT=off` ⇒ 判据直接返回 `silent`（运维/排障用）。

---

## 2. 对话侧入口（冻结）

### 2.1 用哪个工具、何时带提示

| 工具 | 角色 | 触发条件 |
|---|---|---|
| `list_papers`（`src/tools.ts:118-162`） | **主入口（必做）** | 每次调用都计算 `migration`；`level` 由 §1.2 决定 |
| `transcribe_pdf`（`:164-238`） | **次入口（必做）**，覆盖「打开/读某篇论文」 | 同上（同一次扫描，走缓存） |
| `search_paper`（`:239-…`）、`study_progress`（`:412-…`） | P2（可选） | 复用同一个 helper，一行接入；本批不做（避免每个工具都重复同一句话，稀释信号） |

实现落点：
- `list_papers.execute`（`:158-161`）返回体加 `migration` 字段；`render`（`:149-156`）末尾追加 `value.migration.text`。
- `output.schema`（`:129-148`）**必须**新增 `migration` 属性（现在是 `additionalProperties:false`）；`render` 里 `text` 为 `''` 时不追加空行。
- 两个新工具也在 `registerTools`（`:118`）注册，并在 `src/index.ts:16` 的日志行里列出。

### 2.2 返回字段与精确文案（要带数字）

`migration` 字段（`level` 之外的字段在 `silent` 时也保留，便于断言）：

```json
{
  "level": "ask",
  "state": "unmigrated",
  "papers": 3,
  "files": 9,
  "migratable": 3,
  "byClass": { "flat": 3, "residue": 0, "conflict": 0, "quarantine": 0 },
  "certain": true,
  "markerSync": "none",
  "fingerprint": "7b738cd0180b",
  "reportTool": "migration_report",
  "askOnce": true,
  "text": "…见下…"
}
```

`level='ask'` 的 `text`（zh，逐字冻结；`{n}/{f}` 用实际数字替换）：

```
【布局提示】文献库还是旧（平铺）布局：还有 3 篇论文的产物散落在专题目录里（共 9 个文件）。
旧布局照常可用——列表/打开/检索/删除/改名都不受影响，这条提示不阻塞任何操作。
要不要迁移到新布局「按论文分文件夹」？
 · 先出只读干跑报告（不改任何文件），你看完报告再决定；
 · 真正的执行只能在阅读器/设置面板里做，我这边没有执行入口，**绝不会自动迁移**；
 · 不想迁就回「不用」，之后不再主动问；改主意可在「设置 → 论文伴读 → 重新检查」。
要看详情可以让我调用 migration_report（只读）。
```

`level='ask'` 的 en（逐字冻结）：

```
[Layout notice] Your library still uses the old flat layout: 3 paper(s) are not in their own folders yet (9 files).
The old layout keeps working — listing/opening/searching/deleting/renaming are unaffected; this notice blocks nothing.
Migrate to the new "one folder per paper" layout?
 · First a read-only dry-run report (no file is changed), then you decide;
 · Actual execution only happens in the reader/settings panel — I have no execution path and will never migrate automatically;
 · Say "not now" and I won't ask again; you can re-check later under Settings → Paper Reader → Re-check.
I can call migration_report (read-only) for details.
```

`level='info'` 的三种短文案（**不带问句、不带篇数的情形绝不硬凑数字**）：

| reason | zh | en |
|---|---|---|
| `marker-mismatch` 的**备注句**（接在 ask 文案末尾，不单独成 level） | 见 §1.3 | — |
| `needs-manual` | `【布局提示】有 1 篇需要人工确认：同名文件夹里已有不同内容的文件，迁移会跳过该篇（详见迁移报告）。` | `[Layout notice] 1 paper(s) need manual review: a same-named folder holds different content, so migration will skip them (see the report).` |
| `unreadable` | `【布局提示】有 1 棵子树读不进去（权限），暂时无法判断是否还有未迁移的论文——不显示篇数以免误导。` | `[Layout notice] 1 subtree(s) are unreadable (permissions); cannot tell whether migration is needed — no count is shown to avoid a wrong claim.` |
| `already-asked` / `declined` | （`text = ''`，不往工具结果里塞噪音） | — |

### 2.3 agent 拿到后该怎么问（服务端保证「只问一次」）

字段 `askOnce:true` + `text` 里的第 3 段已写明「回『不用』就不再问」。另外给 agent 一条**可机械遵守**的指令字段（短，避免污染正常回答）：

```json
"ask_hint": "若用户这次问的正是文献库，用一句话问：「库还是旧布局，还有 3 篇没归到文件夹里，要不要现在迁移？迁移前会先给你一份只读报告。」不要重复问；用户答「不用」就调用 migration_prompt_choice(choice:'later') 或 'declined'。"
```

- **只问一次不是靠 agent 自觉**：第一次 `level='ask'` 返回时服务端就把 `choice` 置为 `asked` + 记 `fingerprint`，同一状态下后续调用只会得到 `level='info'`（`text=''`）。⇒ 即便 agent 忽略提示、或用户在别的会话里再问一次文献库，也不会重复询问（红线②）。
- `ask_hint` 只在 `level==='ask'` 时出现；`level==='info'/'silent'` 时该字段为 `null`。

### 2.4 用户答「要」之后：干跑 → 报告 → 用户确认 → 才执行

新增**只读**工具 `migration_report`：

```
name: migration_report
description: 只读干跑报告：扫描文献库并列出「旧（平铺）→ 按论文分文件夹」需要收口的论文/文件、
             冲突与跳过项、读不进去的子树。**只读：不修改任何文件，也绝不执行迁移**；
             执行只能在阅读器/设置面板里由用户确认（「查看论文状态」面板内警示后点一次「确认迁移」）。
parameters: {}（库级，不分专题）
output: { ok, dataDir, report(≤8000 字符，超出截断并注明), need:<MigrationNeed>, plan:{moves,alreadyDone,conflicts,quarantine,orphans,unreadable,totals}, error? }
render: report 原文 + 固定尾句：
        「以上为只读报告，未改动任何文件。执行入口：设置 → 论文伴读 → 查看论文状态（在警示后点一次「确认迁移」）；我不会自动执行。」
```

> ⚠️ **已被取代（本轮，见 §9）**：上面两处原文分别是「执行只能在阅读器/设置面板里由用户确认（需要输入
> migrate）」与「执行入口：设置 → 论文伴读 → 查看迁移报告（需输入 migrate 确认）」——键入确认已被逐篇状态
> 面板的**警示后一次点击**取代，入口名改为**「查看论文状态」**。`migration_report` 工具本身、它的只读性质
> 与尾句承诺「我不会自动执行」全部保留（真实实现见 `src/tools.ts` 的 `migration_report`）。

流程（对话侧，冻结）：

```
用户问文献库 → agent 调 list_papers（level=ask，带 3 篇）
  → agent 只用一句话问用户（ask_hint）
用户回「要」
  → agent 调 migration_report（只读）→ 把 report 的**要点**贴回对话：
     「待迁移 3 篇 / 9 个文件 / 需额外空间约 7697 字节；冲突 0、跳过 0、未处理子树 0」
  → 并告诉用户执行入口：「去 设置 → 论文伴读 → 查看论文状态」，在面板警示后点一次「确认迁移」（原措辞「查看迁移报告，输入 migrate 确认执行」已被取代，见 §9）；或 CLI：node dist/migrate.js --data-dir <库> [--apply --yes]
  → **对话侧到此为止**：agent 没有任何执行路径（现状 grep 已确认；本方案不新增执行工具）
用户在界面确认 → 界面 POST /api/library/migrate {confirm:'migrate-library'} → 执行 → 刷新状态
```

用户答「不用」：agent 调 `migration_prompt_choice(choice:'later'|'declined')`（见 §3.5 的键），之后不再问。

```ts
name: migration_prompt_choice
description: 记录用户对「是否迁移文献库布局」的回答。**只写提示偏好，绝不迁移任何文件、不读库内容**。
             仅在用户明确回答后调用：later=以后再说（库变化时可再问一次）；declined=不再提醒（除「重新检查」外永不问）；
             recheck=重新检查（清掉之前的回答，允许再问一次）。
parameters: { choice: 'later'|'declined'|'recheck' }
output: { ok, state:{choice,at,declaredPapers,fingerprint}, willAsk:boolean }
```

### 2.5 失败回退表（对话侧）

| 失败 | 工具侧行为 | agent 该说什么 |
|---|---|---|
| 判据抛错 / `dataDir` 不可读 | `level='silent'`，`text=''`，`migration.error='scan-failed'` | 什么都不说，照常回答文献库问题（**绝不**编造「可能需要迁移」） |
| 扫描预算超限 | `level='info'`，文本为 unreadable 变体（无篇数） | 「库很大，这次没扫完；要判断得看迁移报告」 |
| `migration_report` 失败 | `{ok:false,error}`，render 写「无法读取文献库：<原因>（未做任何改动）」 | 原样转述，不猜测 |
| 报告超长 | 截断到 8000 字符 + 尾注「已截断，完整报告见 设置/CLI」 | 转述要点 + 提示看界面 |
| 偏好文件写失败（`DSH_HOME` 只读） | 退回进程内记忆；本次仍返回 `level='ask'` | 照常询问；**不报错**给用户（这不是用户能修的错） |
| 用户答「要」但界面执行失败 | 界面显示服务端原文（400/409 + `logPath`） | 转述错误与日志路径，不重试执行 |

---

## 3. 界面侧入口（冻结）

### 3.1 三个表面与插入点

| 表面 | 位置（file:line） | 何时显示 | 作用 |
|---|---|---|---|
| **S1 侧栏横幅（主）** | `lib/client.js` 的 `LibraryTree` wide 分支：`S.head`（`:1353-1358`）之后、树行（`:1367`）之前插入 `h(MigrationBanner,null)`（约 `:1359`）；`data-dsh-part="migration-banner"` | `level='ask'/'info'` 且 `choice∈{idle,asked,later}`；`level='silent'` 或 `choice='declined'` 时**不渲染** | 用户浏览文献库时当场可见；按钮「查看论文状态」「以后再说」 |
| **S2 设置卡片（常驻 + 重新检查）** | `SettingsPanel`（`:1690-1708`）里加 `h(MigrationCard,null)`（放最前：它是**状态**不是配置）；slot 注册见 `:1856-1859` | 始终渲染 | 状态行（未迁移 N 篇 / 已迁移 / 无法判定 / 已选择暂不迁移）+ 「查看论文状态」+「重新检查」+「不再提醒」 |
| **S3 阅读器条（P2，可选）** | `reader/index.html`：`#bar`（`:214-242`）之后、`#main`（`:243-245`）之前插 `#migrate-banner`；数据走既有 `api()`（`:389`） | 同上 | 阅读时也能看见。**本批不做**：阅读器无 i18n 词典（`:2` `lang="zh"`，双语只能 inline，见 `:223`/`:2266-2267`），且布局是**库级**问题、与「正在读哪篇」无关；先做 S1+S2 可少一个分叉面 |

rail 态（侧栏收起，`:1347-1351`）不显示横幅（36px 图标位放不下），由 S2 兜底。

> ⚠️ **已被取代（本轮，见 §9）**：表中两个表面的入口按钮名由「查看迁移报告」改为**「查看论文状态」**
> （表中已就地改名，旧名记在此处）。显示门（`level='ask'/'info'`、`choice` 门控）、设置卡片的常驻性、
> 「重新检查 / 不再提醒」、S3 阅读器条本批不做——全部保留。

### 3.2 文案（zh/en 双份，键名与 en 逐字冻结）

> ⚠️ **本表的 UI 键已被本轮取代（本节末注记 + §9）**：删死键 / 改写 / 新增的完整清单见表后注记，
> 键名与文案以设计文档 §3.4 为准；下表原文保留作历史对照。

新增键（zh 加在 `lib/client.js:92-193`、en 加在 `:194-285`；`t()` 见 `:287-288`）：

| key | zh | en |
|---|---|---|
| `migBannerAsk` | `文献库还是旧（平铺）布局：还有 {n} 篇论文没有归到自己的文件夹里。要不要现在迁移？` | `Still on the old flat layout: {n} paper(s) are not in their own folders yet. Migrate now?` |
| `migBannerQuiet` | `文献库仍是旧（平铺）布局：还有 {n} 篇待收口。` | `Still on the old flat layout: {n} paper(s) left to tidy up.` |
| `migBannerDesc` | `迁移前先给一份只读干跑报告，你确认后才执行；不迁移也照常使用。` | `A read-only dry-run report comes first; nothing runs until you confirm. Skipping changes nothing.` |
| `migMarkerMismatch` | `注意：存在「完成」标记，但实际还有 {n} 篇处于旧布局（标记与磁盘不一致，以实际扫描为准）。` | `Note: a "done" marker exists, but {n} paper(s) are still flat on disk (the marker disagrees with the files).` |
| `migNeedsManual` | `有 {n} 篇需要人工确认（同名文件夹里已有不同内容），迁移会跳过它们。` | `{n} paper(s) need manual review (a same-named folder holds different content); migration will skip them.` |
| `migUnknown` | `有 {n} 棵子树读不进去（权限），暂时无法判断是否需要迁移。` | `{n} subtree(s) unreadable (permissions) — cannot tell whether migration is needed.` |
| `migMigrated` | `文献库已是新布局（按论文分文件夹）。` | `Library already uses the new per-paper folder layout.` |
| `migDeclinedRow` | `已选择暂不迁移（不会再主动询问）` | `You chose not to migrate (won't ask again)` |
| `migViewReport` | `查看迁移报告` | `View migration report` |
| `migLater` | `以后再说` | `Not now` |
| `migNever` | `不再提醒` | `Don't ask again` |
| `migRecheck` | `重新检查` | `Re-check` |
| `migReportTitle` | `迁移报告（只读干跑，未改动任何文件）` | `Migration report (read-only dry run; nothing was changed)` |
| `migReportIntro` | `` `待迁移 {papers} 篇 / {files} 个文件；需额外空间约 {bytes} 字节。冲突 {conflicts} 个、跳过 {quarantine} 个、子树未处理 {unreadable} 个。` `` | `` `{papers} paper(s) / {files} file(s); needs about {bytes} extra bytes. Conflicts {conflicts}, skipped {quarantine}, unreadable subtrees {unreadable}.` `` |
| `migConfirmHint` | `确认执行：在下面输入 migrate（我不会替你输入）` | `To execute, type migrate below (nothing runs until you do)` |
| `migExecute` | `确认执行迁移` | `Execute migration` |
| `migExecuting` | `迁移中…（先复制后删，可中断、可复跑）` | `Migrating… (copy-then-delete; interruptible and repeatable)` |
| `migExecPartial` | `部分完成：跳过 {n} 篇（源文件原地未动，详见报告与日志）` | `Partially done: {n} paper(s) skipped (their files are untouched; see report and log)` |
| `migReportFail` | `拿不到迁移报告` | `Could not fetch the migration report` |

注：`migUnknown` 的 `{n}` 是**子树棵数**（读不进去的目录数），不是论文篇数——不得与「还有 N 篇」混用同一个数字。

（实现时用同一套键名，测试按 `test/darkmode-subtopic-features.test.mjs:352-364` 的写法正则断言 zh/en 都在。）

> ⚠️ **已被取代（本轮，见 §9）**：本表的 UI 键有增删改，键名与文案以本轮冻结的新键清单为准（设计文档 §3.4）。
> 下表原文保留，用于对照「当时为什么这么写」：
> · **删死键**：`migViewReport`（新键 `migViewStatus`）、`migReportTitle`、`migReportIntro`、`migConfirmHint`、
>   `migReportFail`；`migReportManual` 改为 `migManualNote`。
> · **改写**：`migBannerDesc`（不再承诺「先给一份只读干跑报告」）、`migExecute`/`migExecuting`/`migExecPartial`、
>   `migDone`（以刷新后的逐篇状态为准）、`migNeedsManual`（中性「需人工处理，迁移会跳过」——含 quarantine，
>   不能只说同名冲突）。
> · **保留**：`migBannerAsk`/`migBannerQuiet`、`migMarkerMismatch`、`migUnknown`、`migMigrated`、
>   `migDeclinedRow`、`migLater`/`migNever`/`migRecheck` 与真实删除/恢复/busy 文案。
> · **新增**：`migStatusTitle`/`migStatusDesc`/`migPending`/`migManualNote`、面板列头 `statusPaper`/
>   `statusTranslation`/`statusMineru`/`statusMigration`、三态 `statusComplete`/`statusIncomplete`/
>   `statusUnknown`、`statusScope`/`statusUnreadable`/`migWarning`/`migNotExecutable`/`migExecFail`、
>   删除与清空的 `delTopicWarning`/`delWarning`（`delTopicTypeName` 删除）。

### 3.3 「查看迁移报告」弹层（⚠️ 整体已被取代，见 §9）

> ⚠️ **整体已被取代（本轮，见 §9）**：弹层不再是「`<pre>` 文字报告 + 逐篇 skipped/失败原因 + 键入 `migrate`」，
> 而是**逐篇状态面板**（每篇论文的 翻译 / MinerU 转录 / 迁移 三态 + 「待迁移 N 篇 / 其中 M 篇需人工处理」
> + 警示 + 一次点击「确认迁移」）。下面的旧描述只作历史对照；**仍然有效**的是：`GET /api/library/migrate-plan`
> 只读预检路由、`POST /api/library/migrate {confirm:'migrate-library'}` 服务端栅栏（仅由用户点击携带）、
> 执行结果取 `r.copied/skipped/removed/dirsRemoved/logPath`、失败原样显示且不自动重试。

- 打开：`GET /api/library/migrate-plan`（`src/host.ts:938-946`，**已存在，只读**）→ `{ok, plan, report}`。
- 内容：顶部 `migReportIntro` 用 `plan.totals` 填；主体 `<pre>` 渲染 `report`（等宽、`max-height:60vh`、可滚动）；
  `conflicts/quarantine/unreadable` 非空时**在顶部单独一行警告**（这三类是「不会被自动收口」的部分）。
- 按钮（`SET.row` + `SET.btn/btnGhost`，`lib/client.js:1527-1529`）：
  - `以后再说`（写 `later`）/`不再提醒`（写 `declined`）；
  - `确认迁移`（原 `确认执行迁移`）：加载中/检查失败/状态未知/无可迁移项时 disabled 并说明原因，
    `need.certain && need.migratable > 0` 时可点 → `POST /api/library/migrate {confirm:'migrate-library'}`（`:948-971`）。
    **已取代**：原为「`确认执行迁移`：**默认 disabled**，仅在输入框内容 === `migrate` 时启用」——键入与
    输入框已取消（见 §9）。这一步仍是「用户确认」的**唯一**入口，也是红线①的结构性保证（模型没有这个点击）。
- 执行结果：
  - `200` → `migExecuting` → 成功：`已迁移 N 篇…`（用 `r.copied/skipped/removed/dirsRemoved/logPath`，`src/migrate.ts:75-93`）；刷新 → 横幅消失；
  - `200 + partial:true` → 显示 `migExecPartial{n=skippedPapers.length}` + `skippedPapers` 列表（`:88-91`），横幅转 `needs-manual`；
  - `400 confirm-mismatch` / `409 MigrationAborted`（含 `done/remaining/unlinked/logPath`，`:95-105`）/ `409 MigrationError` / 其它 → 原样显示 `error` 与 `logPath`，**不自动重试**；
  - `回滚`：本批**不做**（路由已在 `:973-998`，P2 再接）。
- 弹层用 `createPortal`（`lib/client.js:87` 已 import）挂 `document.body`，与既有 `AskText` 弹层同一套路（`:1377-1405`）。

### 3.4 与既有面板样式的统一

- 一律复用 `SET`（`lib/client.js:1521-1533`）的 `card/title/desc/label/row/btn/btnGhost/ok/err/meta`；
  横幅 = `SET.card` + 左侧 3px 强调条（`borderLeft:'3px solid var(--dsw-alias-state-warning-primary,#d29922)'`），不新造颜色。
- 所有颜色走 `--dsw-alias-*`（既有的深色模式就是靠这套变量跟随，`:1522-1532`）；不得写死亮色底色。
- 根节点属性与既有卡片一致：`data-dsh-plugin="dsh-paper-reader"`、`data-dsh-surface`（侧栏 `sidebar`，见 `:1371`；设置 `settings-modal`，见 `:1691`）、卡片 `data-dsh-part="settings-card"`（`:1574`）。
- 文案全部走 `t()`；不出现「undefined」——en/zh 同步（测试断言）。

### 3.5 持久化：「已询问 / 已拒绝」的全局键

**权威 = 服务端全局状态文件**（对话侧读不到 localStorage，两个入口必须共享同一份记忆，否则「界面拒绝后对话又问」＝每次都问）：

```
路径：join(dshHome(), '.dsh-paper-reader', 'migration-prompt.json')   // 本机实测：/home/vr/.dsh/.dsh-paper-reader/migration-prompt.json
      · dshHome() 见 src/library.ts:52-55（$DSH_HOME > ~/.dsh；本机 DSH_HOME=/home/vr/.dsh）
      · 同目录既有 `migration-logs/`（src/migrate.ts:107-109）与 `embed.json`（本机实测 ls）——完全沿用既有约定
      · **必须放在库外**：放进 dataDir 会被判据当成 orphan/hidden 参与迁移与列表（同 src/migrate.ts:10-11 的理由）
      · 测试可覆盖：DSH_HOME=<临时目录>（既有机制），另加 DPR_MIGRATE_PROMPT_STATE=<文件> 便于夹具库
内容：{ "v":1, "key":"migratePrompt.v1", "choice":"idle|asked|later|declined", "at":"ISO",
        "by":"tool|ui|null", "declaredPapers":3|null, "fingerprint":"7b738cd0180b"|null, "pluginVersion":"1.6.0" }
写：tmp + rename（沿用 src/embed.ts:193 的 tmp 命名、src/transcribe.ts:332 的原子语义），权限 0o600（沿用 src/theme-config.ts:120）
读：任何字段非法/文件缺失/JSON 坏 ⇒ 回落 {choice:'idle'}（最坏结果是多问一次，不致命）
```

**镜像 = 浏览器 localStorage 键 `dpr.migratePrompt`**（JSON 字符串，同结构）：
- 作用：横幅**第一帧**就能渲染（不等网络）；隐私模式写不了也不影响（服务端权威）。
- 写入顺序：先 `POST` 服务端成功，再写镜像；读时以**服务端**为准覆盖镜像。

**核对自己改名的前缀逻辑不会搬丢它（验收点，必写进测试）**：
- `migrateLsKeys(oldTopic,newTopic,oldName,newName)`（`lib/client.js:350-379`）**只搬** `dpr.variant.`（`:356`）与 `dpr.sessionN.`（`:363`）两个前缀，另只改 `dpr.last`（`:374-377`）；
- `dpr.migratePrompt` **不含 topic/name、也不属那两个前缀** ⇒ 论文改名、专题改名/移动都不会搬它、更不会删它；
- 同一套论证在 `lib/client.js:69-74` 已经为 `dpr.syncScroll` 写过（可逐字对照）；全库也没有 `localStorage.clear()`（`grep` 实测）。
- 服务端那份在 `$DSH_HOME`（库外），迁移/回滚/清空专题都不会碰它。

路由（新增，形制照抄 `/api/theme/config` 的 GET/POST/DELETE，`src/host.ts:1309-1337`）：

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| GET | `/api/library/migrate-prompt` | `?force=1`（＝重新检查） | `{ok, need:<MigrationNeed>, prompt:{level,reason,text}, state:{choice,at,declaredPapers,fingerprint}}` |
| POST | `/api/library/migrate-prompt` | `{choice:'asked'|'later'|'declined'|'idle', declaredPapers?, fingerprint?}` | `{ok, state, willAsk}` |
| DELETE | `/api/library/migrate-prompt` | — | 重置为 `idle`（等价「重新检查」） |

UI 侧行为矩阵（冻结；t3 按此逐格验）：

| `level` | `choice` | 侧栏横幅 S1 | 设置卡片 S2 |
|---|---|---|---|
| ask | idle | 询问文案 + `migViewReport` + `migLater` | 状态行 + 三按钮；打开报告时**不**自动写 asked（只有真正渲染出问句才写，见下） |
| info（已问过/以后再说） | asked/later | 安静条 `migBannerQuiet` + `migViewReport`（无问句、无数字变化） | 状态行 + `migRecheck` |
| info（已拒绝） | declined | **不渲染**（符合「拒绝后消失」） | `migDeclinedRow` + `migRecheck` |
| info（needs-manual） | 任意 | `migNeedsManual` + `migViewReport`（**不发问**） | 同上 |
| info（unknown/权限） | 任意 | `migUnknown`（**不显篇数**、不发问） | 同上 |
| silent | 任意 | 不渲染 | `migMigrated` / 空库文案 |
| — | — | — | 迁移执行成功且需要新态 ⇒ `force` 重新扫描并刷新 |

> 「ask 的写盘时机」= 横幅**渲染出询问文案**后立即 `POST{choice:'asked', fingerprint, declaredPapers}`；
> 对话侧的 ask 由工具调用时写。两者共用同一状态 ⇒ **同一时间内不会两边同时问**。
>
> ⚠️ **本轮取代（见 §9）**：上面矩阵里的 `migViewReport` 一律按新键 `migViewStatus`（入口改为**逐篇状态面板**）读；
> 门控（`level`×`choice` 矩阵、写 `asked` 的时机、同指纹去重）**全部不变**；`migBannerDesc`/`migNeedsManual`
> 等文案的改写见 §3.2 注记。

---

## 4. 四条红线（机制 / 证据 / 变异靶子）

### 红线① 只提示，绝不自动迁移（执行仍须 只读预检 → 用户确认；确认方式本轮改为一次点击，见 §9）

- **机制**：对话侧工具层**没有任何**执行路径（现状 `grep -n "migrate\|runMigration" src/tools.ts src/index.ts` 为空，基线树实测）；
  本方案新增的两个工具：`migration_report` 只调用 `planMigration()`（`src/migrate.ts:157-321` 全部是 `readdir/lstat/readFileSync`，纯只读），
  `migration_prompt_choice` 只写 `$DSH_HOME` 下的偏好文件（库外、不碰库）。
  执行需要**两道门同时过**：HTTP `confirm:'migrate-library'`（`src/host.ts:950`）或 CLI `--yes`（`src/migrate.ts:720`），
  而 UI 侧的 `confirm` 只能由用户在逐篇状态面板的警示后**点一次「确认迁移」**得到（已取代原「在输入框里
  键入 `migrate`」，见 §9）。
- **证据**：`GET /api/library/migrate-plan` 走 `planMigration`（`:938-946`）；POST 缺 confirm 直接 400（`:950-952`）；CLI 缺 `--yes` 退出码 64（`:720-723`）。
- **变异靶子**：把 `migration_report` 内部改成调用 `runMigration`；或把 POST 的 confirm 检查删掉 ⇒ 用例「调用三个新工具后夹具库**逐字节不变**、且无 `migration-logs/` 新文件」必须变红。

### 红线② 不许每次都问（记住已询问/已拒绝；设置里有「重新检查」）

- **机制**：§1.2 的发问门（服务端强制、纯函数可单测）+ §3.5 的全局状态（服务端权威 + localStorage 镜像）。
  `ask` 一旦给出即写 `asked`；同 fingerprint 不再问；`declined` 是吸态；`recheck`（= DELETE 路由 / 卡片按钮）才回 `idle`。
- **证据**：`migrateLsKeys` 只搬 `dpr.variant.`/`dpr.sessionN.`（`lib/client.js:356,363`）⇒ 全局键不会被改名/移动搬丢（`:69-74` 的同款论证）。
- **变异靶子**：删掉 ask-once 判断（每次 `idle` 化）⇒ 用例 P6「同一 fingerprint 第二次调用不得为 ask」、P4「declined 后仍 ask」变红。

### 红线③ 提示不得阻塞旧布局的正常使用

- **机制**：判据全程 try/catch，任何异常降级 `silent`；结果进程内缓存 TTL 60 s；工具侧只在返回里**追加一行文本**，
  不改 `papers`/`tree` 的内容与顺序；偏好写失败不回错误给用户。
- **证据（实测）**：300 篇/1200 文件全旧布局：轻扫描 36.1 ms、`listPapers` 7.1 ms、`planMigration` 57.9 ms；已迁移库 1.1/1.4/2.3 ms（`probe-cost-output.txt`）。
  旧布局的可用性今天已由既有能力保证：`listPapers` 平铺分支（`src/library.ts:179-187`）、`paperPdfPath` 回落（`:206-212`）、按 Z.4 第 3 条不删 legacy 分支。
- **变异靶子**：让 `detectMigrationNeed` 的异常冒泡 ⇒ 用例 P18「`dataDir` 不可读/不存在时 `list_papers` 仍 200 且论文列表与迁移前一致」变红。

### 红线④ 无权限 / 只读时不得误报

- **机制**：`certain=false`（`unreadable` 非空或扫描预算超限）⇒ **不发问、不写偏好**、只给无篇数的中性说明；
  `dataDir` 不存在 ⇒ `empty`（**绝不** `mkdir`：判据不允许调用 `resolveDataDir`，见 `src/library.ts:58-62`）；
  判据只读目录项与 `size`，不读文件内容 ⇒ 库可读但文件不可读时仍能正确判定。
- **证据**：探针 F7（`chmod 000` 子树）⇒ `state=unknown`、`unreadable=[{dir:"B私有",cause:"EACCES"}]`、`可发问=false`；既有实现的同一口径在 `src/migrate.ts:172-181`、R2-2 注释。
- **变异靶子**：删掉 `certain` 判断（unreadable 也发问）⇒ 用例 P12 变红；把判据改成调用 `resolveDataDir` ⇒ P13（库不存在时目录**未被创建**）变红。

---

## 5. 可执行验收（t2 实现 / t3 验证共用）

**命令**：`npm run typecheck` → `npm run build` → `npm test`（LF 与 CRLF 两种检出，0 fail、总数只增不减、零新增 `t.skip`）。
新用例建议落在 **`test/migrate-prompt.test.mjs`**（沿用 `test/darkmode-subtopic-features.test.mjs:54-55` 的「只 import dist」与「夹具库一律 `/tmp`」套路）。
夹具四态由探针脚本可直接复用：`.probe/migrate-prompt/probe-criterion.mjs`（12 个夹具，含四态与三种不一致）。

| # | 验收点 | 断言要点 |
|---|---|---|
| P1 | 未迁移库提示出现且数字正确 | `list_papers` 返回 `migration.level='ask'`、`papers=3`、`text` 含「还有 3 篇」 |
| P2 | 已迁移（有 `.done`）后不再提示 | `level='silent'`、`text=''` |
| P3 | **无标记但已是新布局**不得误报 | `level='silent'`（防「只看标记」） |
| P4 | 拒绝后不再出现 | 写 `declined` → 后续调用 `level='info'`、`text=''`；界面横幅不渲染（源码级断言 + 路由状态断言） |
| P5 | 「重新检查」后再次出现 | `DELETE /api/library/migrate-prompt`（或 `?force=1`）→ 回到 `ask` |
| P6 | 不许每次都问 | 同一 fingerprint 第二次调用不得为 `ask` |
| P7 | 情况变了可再问一次 | 新增一篇平铺论文 → `ask` 且 `papers` +1 |
| P8 | 标记与实际不符（`.done` 在、仍有平铺） | `markerSync='conflict'`、`level='ask'`、文案含「标记与磁盘不一致」 |
| P9 | 残留（文件夹+平铺同内容） | `papers=1` 且**不是**靠 `listPapers().legacy`（该值为 0） |
| P10 | 冲突（两边不同内容） | `level='info'`（不发问）、报告里 `conflicts` 列出、库未被改动 |
| P11 | quarantine（名 >100 字符） | `level='info'`，且 `papers` 取自**扫描**（不是 `plan.totals.papers=0`） |
| P12 | 子树不可读 | `level='info'`、文本**不含**篇数、偏好文件**未写** |
| P13 | `dataDir` 不存在 | `level='silent'`，且目录**未被创建** |
| P14/P15 | 空库 / 只有孤儿文件 | `level='silent'` |
| P16 | 红线① | 调 `list_papers`/`migration_report`/`migration_prompt_choice` 前后：夹具库文件清单+size+mtime 指纹不变、无 `migration-logs/` 新文件 |
| P17 | 红线② | `declined` → 横幅消失；`recheck` → 横幅再现 |
| P18 | 红线③ | 未迁移库上 `list_papers`/`resolvePaper`（打开论文）照常成功；`dataDir` 不可读时工具不抛 |
| P19 | 红线④ | 只读挂载（库目录 0o555 + `DSH_HOME` 只读）⇒ 不误报、不抛、不写 |
| P20 | 缓存与失效 | 同进程第二次调用不再走扫描（计数器断言）；迁移执行成功后缓存失效 |
| P21 | i18n | 新增 zh/en 键两套齐全（沿用 `:352-364` 的正则断言） |
| P22 | 界面元素（**本轮已修订**） | 横幅/卡片/**逐篇状态面板**（`data-part=paper-status-panel`）的 `data-dsh-part`、按钮文案、**无输入框**；加载中/失败/未知/`migratable=0` 时执行按钮 disabled 并说明，可迁移时**单击只发一个 POST** 且 `confirm` 令牌保留（原为「报告弹层 + 未输入 `migrate` 时执行按钮 disabled」，见 §9） |
| P23 | 键不会被搬 | 改论文名/专题名后 `dpr.migratePrompt` 仍在（复用既有 `migrateLsKeys` 断言套路） |

**变异验证（写进 `test/mutation-probe.mjs`，改回缺陷态必须对应用例变红）**：

| 变异 | 靶子用例 |
|---|---|
| M1 去掉 ask-once 判断 | P6 |
| M2 判据只看标记（不扫目录） | P3、P8、P9 |
| M3 去掉 `certain` 判断 | P12 |
| M4 判据改用 `resolveDataDir()` | P13 |
| M5 `migration_report` 改成调 `runMigration` | P16 |
| M6 fingerprint 去掉分类 | P9→P10 的恶化不得再问（P7 变体） |
| M7 文案去掉篇数 | P1 |
| M8 只加 zh 不补 en | P21 |

---

## 6. 风险清单

| # | 风险 | 触发 | 后果 | 缓解 |
|---|---|---|---|---|
| R1 | **基线错位** | t2 从 `origin/main` 切分支 | 拿不到 `src/migrate.ts`，功能无处落 | §0.1；请队长裁定基线 = `fdb45f2` |
| R2 | 超大库扫描超预算 | >20000 个目录项 | 判据不完整 | 降级 `unknown`/info、不发问、不写偏好；`DPR_MIGRATE_PROMPT=off` |
| R3 | 偏好文件被用户删掉 | 手动清理 `$DSH_HOME` | 可能再问一次 | 可接受；设置里「重新检查」即同一语义 |
| R4 | 多标签页并发写 | 两处同时改 | 覆盖 | tmp+rename 原子写；读时容错；最坏多问一次 |
| R5 | 隐私模式 localStorage 不可写 | 浏览器隐私模式 | 镜像缺失 | 服务端权威；横幅渲染前 `await GET` |
| R6 | 提示数字与报告数字口径不同 | 存在 conflict/quarantine | 用户以为数字打架 | 统一叫「还有 N 篇待收口」；细节只在报告里展开；P10/P11 固化 |
| R7 | 用户绕过提示手动跑迁移 | CLI | 缓存 60 s 内可能显示旧数字 | TTL 自愈；报告/执行按钮始终实时 `GET migrate-plan` |
| R8 | 新写入落点相反 | 上传落论文夹（`src/host.ts:617-618`），但用户手动放平铺文件 | 篇数不降反升 | 按实际扫描刷新即可（这正是判据要扫目录的理由） |
| R9 | 阅读器条（P2）与 S1/S2 重复提示 | 三处同时可见 | 骚扰 | 同一状态门控；阅读器条本批不做 |

---

## 7. 明确不做 / 延后

1. **不做任何自动迁移**，也不做无警示的一键执行（**本轮修订**）：迁移只在逐篇状态面板的明确警示后由用户**单击一次**「确认迁移」触发；原「不做一键迁移按钮（必须输入 `migrate` 确认）」中的键入确认已取消（见 §9）。
2. **不动运行期布局读取分支**（legacy 双读保留，上一批 Z.4 第 3 条裁定）。
3. **不做回滚 UI**（路由已存在 `src/host.ts:973-998`，P2 再接）。
4. **不把提示铺到 `search_paper`/`study_progress`**（P2：接入点一行，helper 已共用）。
5. **不做阅读器条 S3**（P2，见 §3.1）。
6. **不做「旧版插件检测新布局」的反向提示**（原方案 R8，属另一批）。

---

## 附录 A：已否决的备选方案（附理由）

| 备选 | 否决理由 |
|---|---|
| A1 给对话 agent 一个「执行迁移」工具（带 `confirm` 参数） | 参数由模型自己填 ⇒ 不是用户确认；违背红线①，且 t4 的旁路探针必然打出缺口。执行只留在界面（原「需人手输入 `migrate`」；本轮改为面板警示后一次点击，见 §9） |
| A2 判据只看 `.migration-v1.done` / `.partial` | 探针实测 F3/F8/F11 漏报、F4 误报（§0.3） |
| A3 判据直接用 `planMigration()`（含 sha256） | 只采纳「报告用它」；提示判据用 size 级扫描（12 个夹具零差异），避免每次读全库字节与 IO 错误面 |
| A4 偏好只存 localStorage | 对话侧（工具进程）读不到；UI 拒绝后对话仍会问 = 破红线② |
| A5 偏好存进 dataDir | 会被当成 orphan/hidden 参与迁移与列表（同 `src/migrate.ts:10-11` 的理由） |
| A6 横幅加 ✕ 关闭 | 关闭即丢答案，破红线②；改用「以后再说 / 不再提醒」两个显式选项 |
| A7 用 `plan.totals.papers` 当提示数字 | F6/F8 实测为 0（但磁盘上还有平铺产物）⇒ 假结论 |

## 附录 B：探针原始输出（节选，全文见 `.probe/migrate-prompt/`）

```
── F1-flat-only（未迁移）
   state=unmigrated  还有N篇=3（flat3 / residue0 / conflict0 / quarantine0）可迁移=3 文件=9
   plan.totals={"papers":3,"files":9,...}  交叉核对={onlyPlan:[],onlyScan:[],classMismatch:[]}
── F6-conflict（两边不是同一份）
   state=needs-manual  还有N篇=1（flat0 / residue0 / conflict1 / quarantine0）可迁移=0 文件=1
   plan.totals={"papers":0,"files":0,...}      ← 数字来自扫描，plan 少算
── F7-unreadable（子树读不进去）
   state=unknown  判据完整=false 可发问=false  unreadable=[{"dir":"B私有","cause":"EACCES"}]
── F12-stale-marker（.partial 残留、其实已无平铺产物）
   state=migrated  还有N篇=0   markerSync=stale（只备注，不报警）
```

```
dist=/tmp/t1-probe/dist  每态 300 篇 × 4 个文件
场景                                   listPapers_ms  planMigration_ms  lightScan_ms  plan_papers
flat（全旧布局）                              7.1            57.9           36.1          300
migrated（全新布局）                          1.4             2.3            1.1            0
residue（文件夹 + 平铺各一份，会触发 sha256）    2.2            61.3           32.6          300
```

---

## 8. 更正（t6 repair-round-2，队长裁定覆盖本节涉及的原条款）

> 背景：t4 评审对 t2 的实现提了 10 条（F1–F10），队长逐条裁定后由 t6 修复。本节把**与原方案冲突**或
> **方案没写清**的地方如实记录；§1–§7 的其余条款仍然有效。实现改动见同一提交里的
> `src/migrate-prompt.ts` / `src/host.ts` / `src/tools.ts` / `lib/client.js`。

### 8.1 §3.3 的弹层篇数口径作废（队长裁定 a）：改用判据 `need`，并注明口径

原 §1.1 第 5 条说 `plan.totals.papers` 在 conflict/quarantine 情形**会少算成 0、不能当提示数字**，
而 §3.3 又要求弹层顶部用 `plan.totals` 填 `migReportIntro` —— **那是方案自己的口径缝**。
裁定：**弹层与横幅同源**（`need.papers` / `need.files`），`{bytes}/{conflicts}/{quarantine}/{unreadable}`
仍取干跑报告（判据没有这些量）；并在顶部**明确注明**口径：有 conflict/quarantine 时加一行
`migReportManual`（「其中 {n} 篇需人工处理（迁移不会自动收口它们）。」）。
理由：同一屏上两个数字（横幅「还有 3 篇」vs 弹层「待迁移 0 篇」）就是构造性说谎。
**这条取舍属产品定义，请用户拍板**：备选是「可自动收口 migratable 篇 / 待人工 conflict+quarantine 篇」
双数字（信息更全但更长），或保留 `plan.totals` 但在顶部标注口径。当前实现是前者（同源 + 注记）。

> ⚠️ **本轮同步（见 §9）**：N/M 同源口径**保留**（N=`need.papers`、M=`conflict+quarantine`）；但这条注记的
> 落点已不是报告弹层顶部，而是逐篇状态面板的汇总行；键名由 `migReportManual` 改为 `migManualNote`；
> `{bytes}/{conflicts}/{quarantine}/{unreadable}` 仍取干跑报告。

### 8.2 发问门增加「库身份」这个正交轴（队长裁定 b）

原 §1.2 只按 `fingerprint`（库形态）判断「同一情况不再问」。裁定：再加一条**库身份 = 库根 realpath**
（`MigrationNeed.dataDirId`，偏好文件里记 `dataDir`）。规则：

| 情形 | 行为 |
|---|---|
| 同一个库、同一 fingerprint（asked/later） | info（不再问）—— §1.2 原样 |
| 同一个库、fingerprint 变了（篇数/分类变化） | ask（带新数字再问一次）—— §1.2 原样 |
| **另一个库**（库根 realpath 不同） | **ask**（哪怕形状一模一样）—— 本次新增 |
| declined | **同一个库内**是吸态（原样）；**换库**则重新问一次 |

理由：两种失败模式不对称 —— 纳入库身份后「换库」只是**多问一次**（轻微烦人）；
不纳入则「同形状的另一个库」会被当成**已经问过** ⇒ **静默漏提示**。漏提示比多问一次差。
**已知取舍（请用户知悉）**：① 偏好文件是**全局**的（`$DSH_HOME` 下，库外），所以「换库」在
declined 下也会重新问一次；若产品上要求「declined 对机器上所有库永久生效」，把 declined 分支的
`sameLibrary` 判断去掉即可（一行）。② **库内改名仍会再问一次**：`fingerprint` 含路径（M6 要求分类
进指纹、P7 要求篇数变化要再问），改名会改变路径集合 ⇒ 按 §1.2「情况变了」再问一次。这不是本次引入的
行为，且与「库身份」正交；若要改成「改名也不问」，必须同时放弃 P7 与 M6 的语义，故不做。
③ **（t8 R4，队长裁定 b）偏好只存【一条】记录 ⇒ 换库会【覆盖】上一条 declined**：
`A(declined) → 切到 B(asked) → 切回 A` 时，库里那一份 `declined` 已经被 B 的那条回答**顶掉**，
于是回到 A 会**重新问一次**（而不是「A 仍然保持不再提醒」）。这是**有意选择**：
单条记录的失败方向是「回到旧库多问一次」（烦人但安全），而改成「每库一条 map」需要额外处理过期与清理，
且失败的另一个方向可能是**漏问**——按本轮已确立的原则「漏问比多问一次差」，故保持单条。
（t7 评审的 `G6-back-to-a-still-declined` 探针断言的是「库 B 的回答不污染库 A 的 declined」，
那条期望与本裁定相反，属**期望需随裁定更新**，不是实现缺陷。）
④ **（t8，界定的边界）「拒弱回答降级」只加在界面那条 POST 路由上**，不拦对话侧的
`migration_prompt_choice(later)`：前者防的是**陈旧界面**（另一个标签页还挂着旧快照的问句按钮，
点一下就把吸态复活）；后者是 agent 在**用户明确回答后**才调的（工具描述里写死），属一次新的用户决定，
而且用户想恢复「可以再问」本来就有「重新检查」这条路。⇒ 两条回答通道的作用域不同是**有意**的，
不是漏了一处；若要两者完全一致（连工具也拒），改 `src/tools.ts` 一处即可。

### 8.3 「渲染出问句 ⇒ 记 asked」提高到两个表面共享（队长裁定 c）

原 §3.5 只写「横幅渲染出询问文案后立即 POST{choice:'asked'}」。实测（评审 F1）：**侧栏收起（rail）时
横幅根本不渲染**、问句由设置卡片 S2 兜底，而写 `asked` 的 `useEffect` 只在横幅里 ⇒ 用户每开一次设置
就被问一次、服务端始终 `idle`、对话侧随后**再问一次** ⇒ 红线②的意图被击穿。
裁定：把「问句真的渲染出来 ⇒ 记 asked」提到 `useMigration`（两个表面共享，同一 fingerprint 只回写一次；
本表面不因此切换成安静条 —— 否则问句会在用户眼前消失），并给设置卡片补一个**非吸态**的「以后再说」
（否则卡片里只剩「不再提醒」这条吸态路径）。S3 阅读器条**维持本批不做**（§7 第 5 条，独立表面的评审负担）。

### 8.4 其余七条（F3/F5/F6 低危修复 + F7/F8/F9/F10 记录项）

- **F3（declined 可被 asked 覆盖）**：服务端在 `choice='asked'` 且当前为 `declined` 时**拒绝降级**
  （200 + `willAsk:false` + `refused:'declined'`），竞态下最终仍是 declined；界面侧同时做
  「镜像 state 与 prompt 自洽」（见下一条）。
- **F5（镜像存的是更新前的快照）**：镜像里 `state` 是最新的、`prompt` 是「拿到它那一刻」的 ⇒
  首帧会闪一个「已经问过」的问句。新增纯函数 `dprMigrateMirrorPrompt`：`choice∈{asked,later,declined}`
  且 `prompt.level==='ask'` 时降级为 `info`（写镜像时与读镜像时各调和一次）。
- **F6（空库 + 陈旧 `.done`）**：原判据 `markers.done || paperDirs>0 ⇒ migrated` 会让**一篇论文都没有**
  的库显示「已是新布局」。改为 `papers===0 && paperDirs===0 ⇒ empty`（标记只进 `markerSync`，
  不再单独构成「已迁移」的证据）。
- **F7（记录项，已顺手把描述改准）**：`migration_report` 走 `planMigration`，而后者经
  `resolveDataDir` 会**确保数据目录存在** ⇒ 与「只读：不修改任何文件」的描述不符。工具描述已改为
  「**除「确保数据目录存在」外不修改任何文件**」。若后续要求「连目录都不许建」，需给报告路径换一个
  不 mkdir 的入口（`detectMigrationNeed` 已是那种实现，但它给的是判据不是报告）。
- **F8（记录项，已顺手改成严格校验）**：`/api/library/migrate-prompt` 的 POST 原先用
  `String(body.choice)` 做枚举校验 ⇒ `{"choice":["asked"]}` 会被强转放行。已改为
  `typeof body.choice === 'string'` + 枚举（数组/数字/`null`/多余空格一律 400）。
- **F9（安全记录项，本批不改）**：这两个新端点（GET/POST/DELETE `/api/library/migrate-prompt`）
  与其他本地端点一样**不校验来源**，只依赖「只有本机能看到这个端口」。建议在后续安全批次里统一
  要求 `application/json` 或加本地 token；本批只记录（不扩大改动面）。
- **F10（方法学记录项）**：`test/mutation-probe.mjs` 有多条**多行**锚点，必须**在 LF 检出**里运行
  （`core.autocrlf=true` 的 CRLF 检出会让锚点「命中 0 次」⇒ 显式 FAIL，不会静默）。已写进该文件头部。
  t4 评审一度据此误报「44/64」，补建真 LF 检出后复跑为 **64/64**（已撤回）。

---

## 9. UI 同步（本轮：逐篇状态面板取代「文字报告弹层 + 键入 migrate」）

> 本轮设计冻结见 `docs/migrate-ui-requirements.md`（§2 三轴状态契约、§3.2 三表面、§3.3 警示 + 一次点击、
> §3.4 zh/en 新键）。本节只做两件事：把**被取代的旧冻结陈述**如实标注（原文一律保留，不删历史），
> 并写明**取代后的做法**。本节未列出的条款——判据（§1）、对话侧提示与偏好路由（§2/§3.5）、
> `migration_report` / `migration_prompt_choice`、CLI、四条红线中的②③④——继续有效。

| 旧条款（本文位置） | 状态 | 现在的做法 |
|---|---|---|
| §2.4 `migration_report` 描述尾句「执行只能在阅读器/设置面板里由用户确认（需要输入 migrate）」 | 已取代（原文见 §2.4 上方注记） | 执行入口仍是界面，确认方式改为**逐篇状态面板警示后点一次「确认迁移」**；工具描述已同步（`src/tools.ts`） |
| §2.4 报告 render 尾句「执行入口：… 查看迁移报告（需输入 migrate 确认）」 | 已取代 | 同一次点击；入口名改为**「查看论文状态」**。agent 只读报告本身保留，尾句「我不会自动执行」保留 |
| §2.4 对话侧流程末步「去看迁移报告，输入 migrate 确认执行」 | 已取代 | 改为「去 设置 → 论文伴读 → 查看论文状态」，警示后点一次「确认迁移」；CLI `--apply --yes` 不变 |
| §3.1 两个表面的入口按钮名「查看迁移报告」 | 已取代（表中已改名） | 「查看论文状态」；显示门、设置卡片常驻性、偏好按钮、S3 不做——全部保留 |
| §3.2 `migViewReport` / `migReportTitle` / `migReportIntro` / `migConfirmHint` / `migReportFail` | 死键，已删除 | 替代键见设计文档 §3.4（`migViewStatus`、面板列头/三态/警示/结果文案） |
| §3.2 `migReportManual` | 键名已取代 | `migManualNote`（设计文档 §3.4）；口径不变（§8.1） |
| §3.2 `migBannerDesc` | 已改写 | 不再承诺「先给一份只读干跑报告」；面板即入口 |
| §3.2 `migExecute`/`migExecuting`/`migExecPartial`/`migDone` | 已改写 | 「确认迁移」/「正在迁移…」/「部分完成…查看状态与迁移日志」/「迁移执行结束，以刷新后的逐篇状态为准」 |
| §3.2 `migNeedsManual` | 已改写 | 中性「需人工处理，迁移会跳过」——含 quarantine，不能只说同名冲突 |
| §3.3 整个弹层（`<pre>` 文字报告 + 逐篇 skipped/失败原因） | 已取代 | 弹层改逐篇状态面板（`data-part=paper-status-panel`）：按专题的逐篇三态（翻译/MinerU 转录/迁移）+「待迁移 N 篇 / 其中 M 篇需人工处理」+ 警示 + 一次点击。**逐篇原因不再展示**（聚合注记、日志与 agent 报告仍在） |
| §3.3「`确认执行迁移` 默认 disabled，输入框 === `migrate` 才启用」 | 已取代 | 无输入框：加载中/失败/未知/`need.migratable=0` 时禁用并说明；`certain && migratable>0` 可点；busy 同步锁防连点 |
| §3.3 执行结果列 `skippedPapers` | 已取代 | 只聚合成功/部分完成/失败 + 日志位置，随后强制刷新逐篇状态；部分完成保留 M 注记 |
| §4 红线①「UI 的 confirm 只能由用户键入 `migrate` 得到」 | 已取代 | confirm 仍只来自**用户在界面上的显式操作**，但那是一次点击；服务端 `confirm:'migrate-library'` 栅栏**保留**，不称其为密码或人类身份证明 |
| §5 P22「未输入 migrate 时执行按钮 disabled」 | 已取代（行已就地修订） | 验收改为：三轴面板 part、无输入框、加载/失败/未知/busy 禁用、可迁移时单击只发一个 POST 且 confirm 令牌保留（测试断言同步改写，见设计文档 §5.1） |
| §7.1「不做一键迁移按钮（必须输入 migrate 确认）」 | 已修订 | 仍然**不做任何自动迁移**、不做无警示的一键执行；迁移只在面板明确警示后由用户单击一次触发 |
| 附录 A1「执行只留在界面（需人手输入 `migrate`）」 | 已修订 | 不变：**对话侧/agent 没有任何执行路径**；变的是确认方式 = 一次点击 |
| §8.1 弹层顶部口径注记 | 口径保留、落点与键名已取代 | N/M 同源不变；落在面板汇总行，键 `migManualNote` |

**不取代（明确保留）**：`migration_report`（只读）、`migration_prompt_choice`（只写偏好）、CLI 干跑报告与
`--apply --yes` 门、后端 `GET /api/library/migrate-plan`、以及红线②「不每次都问」/③「不阻塞旧布局」/
④「无权限不误报」。

**本轮新增的只读端点**：`GET /api/library/paper-status`（分页逐篇三态，面板打开才惰性加载，失败与分页独立）；
它不改变上述任何执行路径，执行仍走原 `POST /api/library/migrate` 并在服务端重新权威预检。
