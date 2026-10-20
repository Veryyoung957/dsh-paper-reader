# 「文献整理工具」独立验证报告（t3）

> 任务：t3（独立验证，只报事实）。作者：verifier。attempt：`1378e1e7-14f8-4c3b-a8c1-76598a0f7b8b`。
> 被测对象：`.worktrees/library-manage-tools`，分支 `feat/library-manage-tools`；被测**实现提交**
> `af8d87d`（父 `d37fe49` 契约文档；基线 `57309b2` = `feat/migrate-prompt`）。本报告单独以
> 一个 `docs:` 提交落盘（只含本文件，不改代码）。
> 冻结契约：[`docs/library-manage-tools-plan.md`](library-manage-tools-plan.md)（下称「方案」）。
> 纪律：**不采信实现方自述与它自己的测试结论**。本报告的每条结论都来自本轮新建的夹具与探针；
> 探针脚本放在工作树内被 `.gitignore` 忽略的 `.probe/t3-verify/`（不提交，见 §10 环境限制），
> 全部只 import 分支构建产物 `dist/*.js`，不 import `test/` 下的任何断言。
> 未修改 `src/`、`test/`、`lib/`。本文件是本轮唯一新增的受版本控制文件。

---

## 0. 结论摘要（只列事实）

| # | 验收项 | 结果 |
|---|---|---|
| 1 | 审批四态（allowed-once / rejected / cancelled / unavailable）各有独立命令与输出证据；非 allowed-once 零副作用（sha256 快照） | **通过**：5 个破坏性 action × 3 个拒绝态 = 15 例全部零字节变化；5 例 allowed-once 动作真实发生；另 6 条 fail-closed 路径（无服务 / 无 agent / request 抛错 / 闭集外值 / signal 已中止 / 无 `get`）全部拒绝且零副作用 |
| 2 | 回收站可恢复性经「真实搬回 + sha256 比对」 | **通过**：`manifest.json` 与回收站实物逐文件一致；按 manifest 的 `relativeDir`/`trashSubdir` 把文件搬回后，删除前 12 个文件的 sha256 逐个一致；专题删除的隐藏条目同样可恢复；非空专题 409 且零改动 |
| 3 | 穿越 / 符号链接 / 冲突 / add / move 边界 ≥ 6 条独立用例 | **通过**：自建 **49 例**（穿越 10、名字 6、符号链接专题 1 + 论文目录 3、add 16、move 11、rename 冲突 3、move 注入失败/回滚 4 等），每例都断言 sha256 快照不变（拒绝类） |
| 4 | 红线：无迁移执行路径；既有两个迁移工具未变 | **通过**：`src/tools.ts` 只 import `planMigration`/`formatMigrationReport`；新增模块无 `runMigration/rollbackMigration/applyMigration` 调用；`migration_report`/`migration_prompt_choice` 的 description、parameters、output schema、执行结果、render 文本与基线**逐字节一致**（归一化临时路径/时间戳后深比较） |
| 5 | 全量 `npm test` 数字 + 基线自测对比 | **通过**：分支 `634 tests / 598 pass / 0 fail / 36 skipped`（exit 0）；基线（新 clone `57309b2`）`582 / 546 / 0 / 36`（exit 0）。差值 = 新增测试文件的 +52 例，全部 pass；skip 数不变 |
| 6 | 文档含复现命令、期望/实际、环境限制；未改 src/test/lib | **通过**：见各节与 §10；`git diff HEAD -- src test lib` 为空 |

另有 **2 条低风险事实**（见 §9 F1/F2）与 **1 条高优先级缺陷**（见 §9 F3）：
`af8d87d` 在「论文夹 + 同 stem 平铺残留」的混合布局下，`delete_paper`/`rename_paper`/`move_paper`
会**只处理论文夹那一半却返回 `ok:true`**（删除后文献仍在；改名/移动后同一篇出现两次）。
该缺陷由 t4 评审（`0f09dde` 的 F2）先指出，本轮在**干净 clone 的 af8d87d** 上独立复现；
本报告落盘时工作树里已有另一会话的**未提交**修复（`layout-conflict`/`assertNoLayoutConflict`），
**本轮没有验证该修复**。正文 §9 F3 给了复现命令与期望/实际。

---

## 1. 复现命令与证据文件

全部在 `.worktrees/library-manage-tools` 下执行；前置 `npm run build`（`npm test` 的 pretest 会构建）。

```bash
cd .worktrees/library-manage-tools
node .probe/t3-verify/probe-approval.mjs      # 34/34 PASS：四态×5 action、fail-closed、顺序、schema
node .probe/t3-verify/probe-trash.mjs        # 10/10 PASS：manifest↔实物、真实搬回 sha256、非空专题
node .probe/t3-verify/probe-boundaries.mjs   # 49/49 PASS：穿越/符号链接/冲突/add/move/回滚
node .probe/t3-verify/probe-inflight.mjs     #  9/9  PASS：在途/会话/翻译/钩子/迁移缓存/共享锁
node .probe/t3-verify/probe-migration.mjs "$PWD" > .probe/t3-verify/migration-branch.json
node .probe/t3-verify/compare-migration.mjs .probe/t3-verify/migration-branch.json \
     .probe/t3-verify/migration-baseline.json   # → MIGRATION-TOOLS-IDENTICAL
npm test                                     # 634/598/0/36（见 §8）
```

基线自测（必须是真实 git 检出，**不是** `git archive` 解包——后者不是 git 仓库会让 VC1 等用例误红）：

```bash
git clone -q /home/vr/My_Projects/dsh-paper-reader/.git /tmp/base
cd /tmp/base && git checkout -q 57309b2
cp -r <worktree>/node_modules /tmp/base/node_modules   # 工作树内已验证可用的安装（方案 §0.2）
npm test
```

本地证据文件（`.probe/t3-verify/`，gitignored，不入库）：`probe-approval.mjs`、`probe-trash.mjs`、
`probe-boundaries.mjs`、`probe-inflight.mjs`、`probe-migration.mjs`、`compare-migration.mjs`、
`redline.txt`、`branch-test.log`、`baseline-test.log`、`migration-branch.json`、`migration-baseline.json`。

### 1.1 探针基座（可据此重建）

「零副作用」判定 = 对 `dataDir` 递归快照（**含 `.trash`**）：常规文件记 sha256、目录记 `[dir]`、
符号链接记 `[symlink:target]`；前后 `deepEqual`。审批替身记录每次请求的 `toolName/callId/agent/signal/reason`，
并可配置四态、抛错、或挂起（用于顺序证据）。

```js
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
function snap(dir) { /* 递归：目录 → '[dir]'，符号链接 → '[symlink:…]'，文件 → sha256；按名字排序 */ }

function fakeApproval(outcome) {
  const state = { outcome, throws: false, calls: 0, requests: [], atRequest: null, snapFn: null, gate: null }
  const service = { async request(req) {
    state.calls++; state.requests.push({ ...req, keys: Object.keys(req).sort() })
    if (state.snapFn) state.atRequest = state.snapFn()   // 审批时刻的文件系统快照（顺序证据）
    if (state.gate) await state.gate
    if (state.throws) throw new Error('approval backend exploded')
    return state.outcome
  } }
  return { service, state }
}

function makeTools(dataDir, { approval, scanner = async () => [], guards } = {}) {
  const g = guards ?? createLibraryGuards(dataDir)
  g.setPaperSessionScanner(scanner)                      // 模拟 web 侧注入的会话扫描器
  const tools = {}, ctx = { tools: { register: (x) => { tools[x.name] = x } },
                            get: (n) => (n === 'approval' ? approval : undefined) }
  registerTools(ctx, { dataDir }, g)
  return { tool: tools.library_manage, guards: g }
}
const execOf = (over = {}) => ({ agent: { id: 'dpr-…' }, callId: 'call-xyz',
  signal: new AbortController().signal, deferContext() {}, concludeTurn() {}, ...over })
```

> 注意（验证基座事实）：没有注入 scanner 时，带会话前置的动作一律 `session-unknown` 503（fail-closed）。
> 这是**正确行为**，但写探针时若不注入 scanner，「审批四态」会被 `session-unknown` 提前拦下——
> 本轮第一版探针就因此得到 20 个假 FAIL，修正后全绿。实现方测试也必须注入 scanner 才测得到审批分支。

---

## 2. 审批四态 × 5 个破坏性 action

命令：`node .probe/t3-verify/probe-approval.mjs`（34/34 PASS）。每个 action 用**全新夹具**，
审批替身返回指定 outcome；断言组合 = 错误码/状态 + 消息前缀 `[library_manage:<code>]` +
dataDir sha256 快照前后相等 + 审批请求次数/字段 + `.trash` 不存在。

| action | rejected（403） | cancelled（409） | unavailable（503） | allowed-once |
|---|---|---|---|---|
| delete_paper | 快照不变，calls=1 | 快照不变，calls=1 | 快照不变，calls=1 | 论文目录消失，`approval:'allowed-once'` |
| delete_topic（空+隐藏条目） | 快照不变 | 快照不变 | 快照不变 | 专题目录消失 + `.trash` 出现 |
| rename_paper | 快照不变 | 快照不变 | 快照不变 | `T/P → T/Q` |
| rename_topic | 快照不变 | 快照不变 | 快照不变 | `T → S` |
| move_paper | 快照不变 | 快照不变 | 快照不变 | `T/P → S/P`（整目录） |

代表性输出（原始 stdout）：

```text
PASS delete_paper/rejected code=approval-rejected/403 snapEq=true calls=1 noTrash=true
PASS move_paper/unavailable code=approval-unavailable/503 snapEq=true calls=1 noTrash=true
PASS rename_topic/allowed-once ok=true approval=allowed-once changed=true atRequestUntouched=true \
     keys=agent,callId,displayReason,reason,signal,toolName
```

### 2.1 fail-closed 补充路径（全部零副作用、且审批不被调用或按预期拒绝）

| 条件 | 期望 | 实际（`probe-approval.mjs`） |
|---|---|---|
| `ctx.get('approval')` 返回 `undefined` | `approval-unavailable` 503 | PASS，calls=0 |
| `ctx` 无 `get` 方法（旧宿主/坏替身） | `approval-unavailable` 503 | PASS |
| `exec.agent` 为 `undefined` | `approval-unavailable` 503 | PASS，calls=0 |
| `request()` 抛错 | `approval-unavailable` 503 | PASS，快照不变 |
| `request()` 返回闭集外值 `'allow'` | `approval-unavailable` 503 | PASS，快照不变 |
| `signal` 已中止 | `approval-cancelled` 409，**不调 request** | PASS，calls=0 |
| 未注入会话 scanner（headless） | `session-unknown` 503，零副作用 | PASS |

### 2.2 「先写后问」不可能：顺序证据

1. **审批时刻快照 = 调用前快照**：5 个 action 的 allowed-once 用例里，`request()` 被调用的**那一刻**
   对 `dataDir` 做 sha256 快照（`state.atRequest`），与调用前 `deepEqual`——说明审批之前
   **没有创建 `.trash` bundle、没有 mkdir、没有 rename**（对应方案 §2.3/M17）。
   输出中体现为 `atRequestUntouched=true`。
2. **锁在审批之前拿到**：审批替身挂起（gate）期间，同目标第二个写操作 `rename_paper` 得到
   `busy 409`；此时快照仍未变；放行后第一个删除成功。输出：
   `PASS lock-held-across-approval atApprovalEqBefore=true second=busy/409 first=true`。
3. **只读预检失败不打扰用户**：删除不存在文献 → `not-found`，`approval.calls=0`；`move_paper`
   目标专题不存在 → `not-found`，`calls=0`；`delete_topic` 非空 → `topic-not-empty`，`calls=0`
   （见 §3/§4）。
4. **会话/翻译检查在审批之前**：`session-running`、`session-unknown`、`translation-busy` 三例
   `approval.calls=0`（见 §6）。
5. **审批请求内容**：`{agent, toolName:'library_manage', callId, reason, displayReason, signal}`
   （`keys=agent,callId,displayReason,reason,signal,toolName`）；`reason` 为双语单串，含
   `《T/P》`、文件数/字节数、`仅本次调用有效 / one-shot`、`Nothing changes unless you allow this one call.`
6. **参数面**：`parameters.properties` 的键恰为 `action,name,new_name,source_path,to_topic,topic`，
   无 `confirm/token/approve`；`action` 枚举 7 值且不含 `migrate*`/`clear*`；`action:'migrate'`
   → `bad-request`；`create_topic`/`add_paper` 即使在审批会拒绝的替身下也 `calls=0` 且成功。

---

## 3. 回收站：manifest ↔ 实物 ↔ 真实搬回

命令：`node .probe/t3-verify/probe-trash.mjs`（10/10 PASS）。夹具：新布局论文 `T/P`，含
`.pdf/.txt/.pages.json/.transcript.json/.mineru.md/.mineru.json/.embeddings.json/.study.json/-zh.pdf/-dual.pdf`
+ 隐藏 `.DS_Store` + 未知用户文件 `notes.md`（共 12 个文件，事先记录 sha256）。

期望/实际：

| 断言 | 期望 | 实际 |
|---|---|---|
| `manifest.json` 位置 | `<trashDir>/manifest.json` 与 `<trashDir>/P/manifest.json` 两份，内容一致 | 一致（`kind:'paper'`，`relativeDir:'T/P'`，`trashSubdir:'P'`） |
| manifest 与实际文件 | manifest 列出 10 个产物；回收站子目录里产物 + `.DS_Store` + manifest 本身 | `manifest=10 subFiles=11`（10 产物 + `.DS_Store`），`bytes` 字段与实物大小一致 |
| 未知用户文件 | 非递归 rmdir：`notes.md` 留在原处，论文目录不整删 | 目录里只剩 `["notes.md"]`（`dirRemoved:false` 语义） |
| 真实搬回后 sha256 | 按 `relativeDir` + `trashSubdir` 搬回，12 个文件逐个 sha256 与删除前一致 | `restored=11 sameAsBefore=true files=12`（11 个从回收站搬回 + `notes.md` 原位） |
| 回收站线索 | `trashRel` 是 dataDir 相对路径且存在；`trashDir` 是绝对路径 | `.trash/2026…-hex` 存在；`trashDir` 绝对 |
| 非空专题 | `topic-not-empty 409`，`extra.entries/papers`，**不审批**、零改动 | 一致（`extra={"entries":["P"],"papers":["P"],"subtopics":[]}`，calls=0） |
| 空专题 + 隐藏条目 | 成功；manifest `kind:'topic-hidden'`；隐藏条目进回收站；专题目录消失 | 一致；把隐藏文件搬回后 sha256 与删除前一致 |
| 空专题无隐藏条目 | 成功且不创建 `.trash`（`trashDir/trashRel` 均 null） | 一致 |
| rejected 删除 | 不创建 `.trash`、快照不变 | 一致 |

---

## 4. 边界：穿越 / 符号链接 / 冲突 / add / move / 回滚

命令：`node .probe/t3-verify/probe-boundaries.mjs`（49/49 PASS；不照抄实现方用例，夹具与断言均为本轮自建）。
所有拒绝类用例同时断言 `dataDir` sha256 快照不变。

| 组 | 用例（数量） | 期望（全部实际命中） |
|---|---|---|
| create_topic 词法/穿越 | `../x`、`A/../../x`、绝对路径、`A//B`、NUL、`%2E%2E%2F`、`.trash`、101 字符段、17 层、控制字符（10） | `bad-name 400`，零改动 |
| create_topic 符号链接 | `data/LinkTopic -> 库外目录`（1） | `escape-rejected 400`，库外 marker 未变 |
| create_topic 合法/幂等 | `A/B/C` 首建 `created:true`；再次 `created:false` 且快照不变（2） | 一致 |
| delete_paper 名字 | `../p`、`a/b`、`..`、`.`、NUL → `bad-name`；空串 → `bad-request`（字段层）（6） | 一致，`calls=0` |
| 符号链接论文目录 | `data/S/P -> 库外/P`：delete/rename/move 三动作（3） | 均 `escape-rejected 400`；库外内容不变 |
| rename_paper 目标名 | `new_name:'X.pdf'`（1） | `bad-name 400` |
| add_paper 源边界 | 不存在/目录/符号链接/0 字节/文本改名 `.pdf`/名字带 `.pdf`/名字 `-en`/专题不存在（8） | `source-not-found 404`、`source-invalid 400`、`source-empty 400`、`source-not-pdf 400`、`bad-name 400`、`not-found 404` |
| add_paper 冲突 | 同名论文夹 / 孤儿 sidecar / 平铺 `<name>.pdf`（3） | `target-exists 409`，原文件 sha256 不变 |
| add_paper 成功 | 原子落盘、`bytes`、源只读、无 `.tmp-*`、无 sidecar（3） | 落点 `T/Good/Good.pdf`，sha256 == 源；目录内仅 1 个文件；源仍在且 sha256 不变 |
| move_paper 前置 | 旧布局 / 目标专题不存在 / 目标已有同名夹 / 目标平铺 pdf / 同专题 / 自子树（6） | `legacy-layout 409`（消息含「界面」）、`not-found 404`、`target-exists 409`×2、`bad-request 400`、`bad-request 409` |
| move_paper 成功 | 10 个产物 + 隐藏 + 未知 + 用户自建 `Sub/` 全部随目录搬走；源目录消失；sha256 不变（1） | 一致（`otherEntries` 不在工具输出里，但目录整体 rename 已由文件集合证明） |
| 已授权但后置失败 | rename_paper 目标已存在 / rename_topic 目标存在 / rename_topic 进自己子树（3） | `target-exists 409` / `bad-request 409`，快照不变（审批已发生 1 次） |
| movePaper 注入失败 | EBUSY → `file-busy 409`；EXDEV → `move-partial 500`；后置校验失败 → `move-partial` + `rolledBack:['P']` 且库恢复原状；回滚失败 → `rollbackFailed:['P']` + `trashRel:null`（4） | 全部一致（函数层注入 `renameImpl`；工具层无注入口，已在输出中注明） |

---

## 5. 在途 / 会话 / 翻译 / 钩子 / 缓存 / 与路由共享锁

命令：`node .probe/t3-verify/probe-inflight.mjs`（9/9 PASS）。路由用假 `webServer/connection/sessionController`
启动真实 `registerRoutes`（与工具**共用同一个 guards 实例**）。

| 用例 | 期望 | 实际 |
|---|---|---|
| 路由在途（session 查询挂起 400ms）→ 工具同目标 | `busy 409`，审批 calls=0 | PASS；路由随后 200 完成删除 |
| 工具在途（持锁卡在审批）→ HTTP 路由 | `409 busy` | PASS |
| 工具在途（持锁卡在审批）→ 同 scope 第二个写操作 `rename_paper` | `busy 409` | PASS |
| 运行中会话 | `session-running 409`，`extra.sessions={total:2,running:1}`，零改动、calls=0 | PASS |
| 会话扫描抛错 | `session-unknown 503`（fail-closed），零改动 | PASS |
| 未注入 scanner（headless） | `session-unknown 503`，零改动 | PASS |
| 翻译在途 | `translation-busy 409`，零改动、**不弹审批** | PASS（假 babeldoc 进程造出**真实** `zhStatus().busy`：`started=true busy=true`，calls=0，`.trash` 不存在） |
| 缓存钩子 | `rename_topic` 成功 → hook 收到旧路径 `T`；`delete_paper` 不触发 | PASS（`hooked=["T"]`） |
| 迁移提示缓存失效 | 旧布局 2 篇 → `list_papers.migration.papers=2`；删 1 篇后 = 1 | PASS（`before=2 after=1`） |

### 5.1 造不出的在途态与局限（如实登记）

- **Windows `EBUSY/EPERM` 真机占用**：Linux 上造不出。本报告只在**函数层**用注入的 `renameImpl`
  验证了 `movePaper` 的 `file-busy` / `move-partial` / 回滚分支；**工具层没有注入口**，
  未做工具层的 EBUSY 注入。
- **DSH 真实审批服务**（`dsh-user-approval`）的 turn 生命周期、`approval/asked|decided` 审计事件：
  本轮用「本地结构化替身」验证工具侧 fail-closed 语义，**没有**连接真实服务。
- **paper preset 会话里审批 UI 真机可达**（方案 §2.6 / V1）：需要部署并重启 profile（本轮明令不做），
  **未验证**。只能引用方案的静态证据。
- **跨进程并发**：实现与方案都声明「单进程锁、跨进程竞争不在支持范围」；本轮未做多进程压测。
- 假 babeldoc 只造 `busy` 状态，**不验证真实 babeldoc 翻译链路**（与本工具无关）。

---

## 6. 红线核查（命令与输出见 `.probe/t3-verify/redline.txt`）

| 检查 | 命令 | 实际 |
|---|---|---|
| 新增/修改模块无迁移执行调用 | `grep -rn "runMigration(\|rollbackMigration(\|applyMigration(" src/tools.ts src/library-guards.ts src/index.ts src/library-manage.ts` | 无匹配（`src/tools.ts:994` 只在**注释**里提到「连 `runMigration` 都不 import」） |
| tools.ts 对 migrate 的唯一 import | `grep -n "from './migrate.ts'" src/tools.ts` | `import { formatMigrationReport, planMigration } from './migrate.ts'`（仅只读两函数） |
| `src/migrate.ts` 未被改动 | `git diff --stat 57309b2..af8d87d -- src/migrate.ts` | 空 |
| 提交内容 | `git diff --stat 57309b2..af8d87d` | 12 个文件，+3593/−109；`src/migrate.ts` 不在其中 |
| mutation-probe 只有新增 | `git diff --numstat 57309b2..af8d87d -- test/mutation-probe.mjs` | `64 0`（0 删除行）；`grep -c "LM[0-9][0-9]"` = 20 |
| mutation-probe 不随 `npm test` 跑 | `grep -n "mutation-probe" package.json` | 无匹配（test 只跑 `test/*.test.mjs`） |
| src 无变异残留开关 | `grep -rn "if (false)\|__mut\|MUTATION\|DPR_MUT" src/` | 无匹配 |
| 两个既有迁移工具行为未变 | 分支 vs 基线分别运行 `probe-migration.mjs`，再 `compare-migration.mjs` | `MIGRATION-TOOLS-IDENTICAL`：description、parameters、output.schema、report 全文、render 文本、choice 三态输出全部一致（仅归一化临时路径/时间戳/长 hex） |
| 只读报告的尾句仍在 | `.probe/t3-verify/redline.txt` §9 / `src/tools.ts:1107` | `…执行入口：设置 → 论文伴读 → 查看论文状态…；我不会自动执行。` |

`git status` 时间线（如实记录）：本报告落盘前工作树对 tracked 文件干净（`git diff HEAD` 为空）；
中途曾出现另一个并发轮次留下的未跟踪目录 `docs/review/`（20:47 出现，含 `mutations.mjs`/`probes.mjs`，
后由该轮次提交为 `0f09dde docs(review): t4 对抗评审…`）；20:51 起同一工作树出现**另一个会话的未提交
修改**（`src/library-manage.ts`、`src/tools.ts`、`test/library-manage-tools.test.mjs`、
`test/mutation-probe.mjs`，见 §10.2 第 4 条）。以上均**不是本轮产物**，本轮未触碰。

---

## 7. 全量回归与基线对比（两处都自测）

| 检出 | 提交 | tests | pass | fail | skipped | exit | 日志 |
|---|---|---|---|---|---|---|---|
| 工作树（验证开始时，`git status` 干净） | `af8d87d` | **634** | **598** | **0** | **36** | **0** | `.probe/t3-verify/branch-test.log` |
| 新 clone `/tmp/af`（干净检出，权威数字） | `af8d87d` | **634** | **598** | **0** | **36** | **0** | `.probe/t3-verify/af8d87d-clean-test.log` |
| 新 clone `/tmp/base` | `57309b2` | **582** | **546** | **0** | **36** | **0** | `.probe/t3-verify/baseline-test.log` |
| 差值 | | +52 | +52 | 0 | 0 | | 新增 `test/library-manage-tools.test.mjs` 的 52 例 |

- 两处测试文件均为 36 个；`node --test --test-timeout=60000 --test-concurrency=1 "test/*.test.mjs"`。
- 36 个 skip 全为环境性（缺真实 MinerU / 真实 PDF 样本；本地 MinerU 不可达），两处一致，**没有**
  因本轮改动新增 skip。
- 分支上实现方自报 `634/598/0/36` 与本轮独立复跑**一致**；基线数字是本轮新 clone `57309b2` +
  同一 `node_modules` 实测（不是采信旧报告）。
- 分支日志有 4 处 `EROFS` 警告：测试环境里 `$DSH_HOME` 指向只读的真实 `~/.dsh` 时 preset 安装回退，
  不影响任何用例结果（preset 安装失败有显式回退）。基线同样行为。
- 附注 1：第一次基线尝试用 `git archive` 解包到 `/tmp`（不是 git 仓库）导致 `VA11`/`VC1` 两条
  依赖 `git` 的用例误红（541 pass/2 fail）；换成真实 clone 后 **546 pass/0 fail**。此处如实记录，
  避免把「解包目录」当成有效基线。
- 附注 2（并发污染，已规避）：本轮验证进行中，同一工作树出现了**另一个并发会话**的未提交修改
  （`src/library-manage.ts`、`src/tools.ts`、`test/library-manage-tools.test.mjs`、
  `test/mutation-probe.mjs`，mtime 20:51，内容是对 t4 评审 F2 等 finding 的修复，不是本轮产物）。
  因此「`af8d87d` 的全量数字」以**干净 clone** 的复跑为准（上表第二行）；工作树那一行是在
  `git status` 干净的时点跑的，数字一致。本轮**没有**在任何时点执行 `checkout/reset/stash`，
  未触碰并发会话的改动。

---

## 8. 预期/实际对照：验收项逐条

| 验收原文 | 期望 | 实际 |
|---|---|---|
| 审批四态各有独立命令与输出证据，非 allowed-once 零副作用（sha256 快照）可复现 | §2 表格 15 例 + 6 条 fail-closed | 全 PASS，stdout 可复现 |
| 回收站可恢复性经真实搬回 + sha256 比对 | manifest 与实物一致，搬回后逐文件 sha256 一致 | §3，12 文件全部一致 |
| 穿越/符号链接/冲突/add/move 边界 ≥ 6 条独立用例，且非照抄实现方 | 自建夹具/断言 | §4，49 例 |
| 红线核查有 grep 证据 | 无执行路径 + 两工具未变 | §6，`MIGRATION-TOOLS-IDENTICAL` |
| 全量 npm test 数字如实记录并与基线对比（基线自测） | 分支 vs 基线各自实跑 | §7 |
| 文档含复现命令/期望实际/环境限制；未改 src/test/lib | 本文件；本轮只 `git add docs/library-manage-tools-verification.md` | 满足（工作树里另有并发会话的未提交 src/test 修改，见 §10.2 第 4 条与 §11） |

---

## 9. 发现的问题（事实记录）

### F1（低）`create_topic` 目标已存在且是普通文件时返回 404，而非 `target-exists 409`

- 位置：`af8d87d` 的 `src/library-manage.ts:1321`（`if (existsSync(dir)) { resolveTopicDir(dataDir, topic) … }`）
  ——`existsSync` 对「文件」也为真，随后 `resolveTopicDir` 走 `lstat` 判定非目录 → `not-found`。
- 复现（在本工作树内直接运行；构造 `data/A` 为普通文件后调用 `create_topic('A')`）：

  ```bash
  cd .worktrees/library-manage-tools && node --input-type=module -e '
  import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
  import { tmpdir } from "node:os"; import { join } from "node:path"
  import { pathToFileURL } from "node:url"
  const R = process.cwd()
  const { registerTools } = await import(pathToFileURL(join(R,"dist/tools.js")).href)
  const { createLibraryGuards } = await import(pathToFileURL(join(R,"dist/library-guards.js")).href)
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(),"h-"))
  const data = join(mkdtempSync(join(tmpdir(),"c-")),"data"); mkdirSync(data)
  writeFileSync(join(data,"A"), "i am a file")               // 同名普通文件
  const tools = {}; const g = createLibraryGuards(data); g.setPaperSessionScanner(async()=>[])
  registerTools({ tools:{register:x=>{tools[x.name]=x}}, get:()=>undefined }, { dataDir:data }, g)
  try { await tools.library_manage.execute({action:"create_topic",topic:"A"},
        {agent:{id:"x"},callId:"c",signal:new AbortController().signal}) }
  catch(e) { console.log("ERR code=",e.code,"status=",e.status) }   // 实际 not-found / 404
  '
  # 实际：ERR code=not-found status=404 msg=[library_manage:not-found] 专题不存在：A
  # 期望（方案 §1.6 step4「目标冲突」）：target-exists 409
  ```
- 影响：零副作用（未写入），但错误码对模型不精确（404 会让 agent 以为「专题不存在、可以再试」，
  实际是路径被同名文件占用）。不属于本轮验收项，未判失败。

### F2（低）`addPaper` 成功路径上 `unlink(tmp)` 失败被静默吞掉，可能留下 `.tmp-*`

- 位置：`af8d87d` 的 `src/library-manage.ts:1448`（`try { unlinkSync(tmpPath) } catch { /* 临时名残留：清理阶段兜底 */ }`）。
  该 catch 之后函数直接返回成功；外层清理只在**抛错**时运行，因此「link 成功、unlink 失败」会留下
  `<name>.pdf.tmp-<pid>-<8hex>`。该残留会被 `listArtifacts` 识别为 `tmp` 产物，之后删除/改名会把它一并处理，
  不属于孤儿，也不会覆盖数据。
- 局限：`unlink` 失败需要故障注入或特殊文件系统；本轮**未能复现**，属代码审阅观察（`file:line` 如上）。
  若要关闭，建议在成功路径上把「清理临时名失败」降级为显式告警/或把残留写进返回值。

### F3（高，`af8d87d`）混合布局（论文夹 + 同 stem 平铺残留）下破坏性动作「半成功却报 ok」

- 位置（`af8d87d`）：布局判定 `src/library-manage.ts:569`（`isLegacyPaper` → 文件夹赢）、
  `planPaperDelete` `:556`、`deletePaper` `:606`、`renamePaper` `:1120`、`planMovePaper` `:1521`。
  `listPapers` 的确定性优先级是「论文夹赢」，因此专题目录里同 stem 的平铺产物成了**不可见的第二身份**；
  三个动作都只操作论文夹，平铺那半原样留下。
- 复现（干净 clone `af8d87d` + `npm run build`，在库内构造混合态后调用工具；核心断言如下）：

  ```bash
  # 夹具：data/T/P/P.pdf（论文夹） + data/T/P.pdf、data/T/P.txt（同 stem 平铺残留）
  # 然后分别调用 library_manage（scanner 注入空数组、approval 返回 allowed-once）
  ```
  ```text
  before papers: ["T/P"]
  [delete] ok= true moved= ["P.pdf"] after papers: ["T/P"]      T dir: ["P.pdf","P.txt"]
  [rename] ok= true new_name= Q      after papers: ["T/P","T/Q"] T dir: ["P.pdf","P.txt","Q"]
  [move]   ok= true to= S            after papers: ["S/P","T/P"] T dir: ["P.pdf","P.txt"]  S dir: ["P"]
  ```
- 期望：混合态是「迁移冲突后的真实形态」（方案 §3.2.5 的红线取向：迁移执行只留在界面）。
  破坏性动作应**拒绝并提示先在界面完成迁移**（或对两半都做完整处理），而不是返回 `ok:true`
  让用户看到「删了还在 / 一篇变两篇 / 移动后两处都有」。
- 实际（`af8d87d`）：三种都 `ok:true`，数据出现在两个位置或删除不生效；无越界写入、无数据丢失，
  但用户可见语义错误。**该缺陷已被 t4 评审 F2 指出**；本轮只做独立复现与事实记录，未验证工作树里
  正在进行的修复（`layout-conflict` + `assertNoLayoutConflict`，未提交、非本轮产物）。
- 对 t3 验收的影响：不在本轮 6 条 acceptance 的字面范围内（审批/回收站/边界/在途/红线/回归均通过），
  但**集成前必须包含该修复**，并应新增「混合态 delete/rename/move」用例钉住。

### F4（提示，非缺陷）`test/reader-ux-verification.test.mjs` 白名单新增 `presets/` 的评估

- 事实：该守卫用 `git status --porcelain` 的 touched 路径逐个匹配白名单（`test/reader-ux-verification.test.mjs:1799-1808`）；
  本轮交付按方案 §1.7/附录 A 确实修改了 `presets/paper-reader/agent.cordis.yml`（persona 增加
  `library_manage` 安全用法），未提交前会以 ` M presets/…` 出现在 status 里 → 旧正则不匹配、VC1 会红。
  因此**同步白名单是必要改动**（否则守卫会把本轮合法的 inScope 交付判成越界）。
- 偏宽：新增项是 `presets\/`（整个目录），而本轮实际只改了一个文件；更紧的写法是
  `presets\/paper-reader\/agent\.cordis\.yml$`。这是测试侧护栏的精度问题，无运行时影响；
  且该守卫注释明确要求「随各轮契约的 inScope 同步」。
- 现状：HEAD 已提交该文件，`git status` 不再显示它；全量 `npm test` 的 VC1 通过（634/0 fail）。

---

## 10. 不能证实的事项与环境限制

### 10.1 不能证实（本轮没有证据，不写成「已验证」）

1. **paper preset 会话里审批 UI 真机可达**（方案 §2.6/V1）：需要部署 + 重启 profile，本轮禁止部署。
   只有方案的静态证据，未做真机点击；`approval/asked|decided` 审计事件也**未**观察。
2. **真实 DSH `approval` 服务**的 turn 语义（无 open turn 时 reject 等，V2）：只用结构化替身覆盖了
   工具侧 fail-closed；没有连真实服务。
3. **win32/macOS**：本轮只在 Linux 跑。假 babeldoc 造 `translation-busy` 依赖 `#!/bin/sh` +
   `.venv-pdf2zh/bin/babeldoc` 路径（win32 不适用）；`EBUSY/EPERM` 真机占用、APFS/NTFS 大小写不敏感、
   硬链接不可用的回退分支均**未在真实平台验证**。
4. **跨进程并发**：单进程锁之外的竞态未验证（实现也声明不在支持范围）。
5. **工具层 EBUSY/EXDEV 注入**：工具层没有故障注入口；只在 `movePaper` 函数层验证。

### 10.2 环境限制（影响取证方式，不影响结论）

1. **本会话的 `/tmp` 是「每次 bash 调用独立」的**：跨调用写入 `/tmp` 的文件会消失（实测：
   `echo > /tmp/x` 后下一次调用 `ls /tmp/x` 不存在）。因此探针与证据放在工作树内被 `.gitignore`
   忽略的 `.probe/t3-verify/`，**不提交**；基线检出在**同一次调用内**完成 clone → build → test
   （跨调用无法复用 `/tmp/base`）。这与任务建议「探针放 /tmp」的偏离是环境所致，已如实记录。
2. 基线必须用**真实 git 检出**：`git archive` 解包目录不是 git 仓库，会让依赖 `git` 的既有用例
   （VC1/VA11）误红（见 §7 附注）。
3. 测试环境里 `$DSH_HOME` 可能指向只读的 `~/.dsh`，preset 安装报 `EROFS` 并回退；与用例结果无关。
4. **并发轮次在同一工作树活动**（本轮**未触碰**其内容）：
   - 20:47 出现未跟踪 `docs/review/`（t4 评审的自造探针/变异），后由该轮次提交为
     `0f09dde docs(review): t4 对抗评审 library_manage…`；
   - 20:51 起同一工作树出现**未提交**修改：`src/library-manage.ts`（+127/−…，新增
     `layout-conflict`/`assertNoLayoutConflict`/`RenamePaperPlan` 等）、`src/tools.ts`、以及
     `test/library-manage-tools.test.mjs`、`test/mutation-probe.mjs`（`git diff --stat` 合计
     4 files, +376/−40，随该会话继续变化）。这不是 `af8d87d` 的内容，也不是本轮改动；
   - 因此 `af8d87d` 的「全量回归」结论取自**干净 clone**（§7 第二行），不依赖工作树当前状态。
     本报告落盘时工作树**不再**是「对 HEAD 干净」的状态，这一事实不应归因于 t3。
5. `node_modules` 沿用方案 §0.2 的既有可用安装（复制自 `.worktrees/migrate-ui-report`），
   `package.json` 未改、未安装新依赖。

---

## 11. 未修改声明

- 本轮只新增并提交 `docs/library-manage-tools-verification.md`（`git add` 只加了这一个文件）；
  探针/日志在 gitignored 的 `.probe/t3-verify/`，未提交。
- 本轮**没有**修改 `src/`、`test/`、`lib/`：`git show --stat c55c4d3` 只有本文件；本轮也没有执行
  `checkout/reset/stash/restore`。
- **落盘时工作树并非「对 HEAD 干净」**：`src/library-manage.ts`、`src/tools.ts`、
  `test/library-manage-tools.test.mjs`、`test/mutation-probe.mjs` 有另一个并发会话的未提交修改
  （见 §10.2 第 4 条）。这不是本轮产生的，本轮也没有把它们加入提交。
- 未改 `dist/`（由 `npm test` 的 pretest 构建，gitignored）；未 push、未部署、未合并主分支。
