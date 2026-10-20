# t7 对抗评审（第二轮）：`library_manage` 的 t6 修复复核

- 评审对象：`feat/library-manage-tools` @ `89a1186`（t6 repair-round-2；父 `044b7b5`；基线上轮 `af8d87d`）
- 上一轮：[docs/library-manage-tools-review.md](library-manage-tools-review.md)（t4，verdict=needs_revision，F1–F4）
- 修复记录：[docs/library-manage-tools-repair.md](library-manage-tools-repair.md)（t6，自述 —— 本报告**不采信**，全部重跑）
- 方法与第一轮相同：自造探针（现 38 条）+ 自造变异（现 10 条）+ 沙箱副本里复跑实现方 LM01–LM25；不改被评审检出
- 环境：Node v22.22.1；`@deepseek-ai/dsh-tools` 0.1.5-rc.2；`@deepseek-ai/dsh-user-approval` 0.1.5-rc.3

## 0. 结论

**verdict: needs_revision** —— 上一轮的 **F1–F4 全部修复且我独立验证通过**（含修复自身的 TOCTOU、对照组不过度拦截）；红线未见回归。判 needs_revision 的**唯一实质原因**是 t6 的修复把一条既有变异靶子的锚点改死了：

- **R-F1（medium）**：`test/mutation-probe.mjs` 的 `LM04-no-service-continues` 锚点（`const svc = …`）在 t6 的 F4 修复后已不存在（改成 try 内的 `svc = …`）⇒ `node test/mutation-probe.mjs --only LM04` **exit 1（锚点命中 0 次）**，`--only LM` 全量 24/25。t6 只跑了 `--only LM2`（LM20–LM25）子集，因此没发现。这是「无审批服务时伪造 allow」这条关键 fail-open 的变异靶子，属质量门回归（不是运行期缺陷）。**一行修**：锚点改成新行的 4 空格缩进 `svc = …` / `svc = (…) ?? ({request: async()=>'allowed-once'})`。我在沙箱副本里实测：改完后 LM04 = 注入红/还原绿/diff clean。
- **R-F2（low）**：`docs/library-manage-tools-repair.md` 数字自相矛盾（`:22` 写「52 → 59」实际 62；`:74` 写「641 tests / 605 pass」实际 644/608）。
- **R-F3（low）**：`create_topic` 对「祖先段是普通文件」仍给 404 `not-found`（`src/library-manage.ts:1433-1436` 的祖先循环未改），而「精确目标段是普通文件」已改成 409 `target-exists`（`:1437+`）——同一类「名字被占用」两个码（继承行为，可选修）。

**用户目标层面：通过。** 建专题 / 收录 / 改名 / 跨专题移动 / 删除（回收站可恢复）五个动作在正常库、纯旧布局、纯新布局、迁移冲突后的混合布局四种形态下都有独立证据；破坏性动作仍只认 `allowed-once`、零副作用、无「模型自填确认」、无迁移执行路径。

## 1. 基线数字（自跑，如实记录）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run typecheck` | 0 | tsc 无输出 |
| `npm test` | 0 | `# tests 644` / `# pass 608` / `# fail 0` / `# skipped 36` |
| `node --test test/library-manage-tools.test.mjs` | 0 | `# tests 62` / `# pass 62` / `# skipped 0`（G 组 10 条新用例） |
| `node .probe/t4/probes.mjs` | 0 | **38/38 PASS**；逐条 `--only <id>` 退出码全 0（`.probe/t4/r2-probe-matrix.txt`） |
| `node .probe/t4/mutations.mjs` | 0 | **10/10**「注入必红 / 还原必绿 / diff clean」 |
| 沙箱 `node test/mutation-probe.mjs --only LM` | **1** | **24/25**：仅 `LM04` 锚点命中 0 次（R-F1） |
| 沙箱（锚点按建议更新后）`--only LM04` | 0 | 注入=1 / 还原=0 / diff=clean（证明 requiredFix 有效） |
| `git diff af8d87d..HEAD -- docs/library-manage-tools-plan.md src/host.ts src/index.ts src/library-guards.ts lib/` | 0 | 空（冻结契约、UI、装配、guards 均未被本轮改动） |

## 2. 上一轮 F1–F4 的复核（逐条独立证据）

| 上轮 finding | t6 口径 | 我的独立证据 | 结论 |
| --- | --- | --- | --- |
| **F1 high** rename 只查论文夹 ⇒ 静默遮蔽既有 legacy 文献 | 三路冲突 + 审批前 | **R1**（目标被 legacy 占用）：`target-exists`、`requests===0`、快照不变、`listPapers` 仍 `[P, Q(legacy)]`；**R2**（目标论文夹）/ **R3**（只剩孤儿 sidecar 与变体）同样拒；**R4** 大小写-only 改名仍放行（不过度拦截）；**M6** 把三路判定短路 → R1 变红 | 已修复 |
| **F2 medium** 混合布局（论文夹+同 stem 平铺）半篇操作 + 假成功 | `layout-conflict` 409 | **R5/R6/R7**：delete/rename/move 均 `layout-conflict`、`requests===0`、快照不变、`listPapers` 只一个身份；R5 的 `extra.files` 点名 `P.pdf`/`P.txt`；**R8** 对照组：纯 legacy delete/rename 仍可、move 仍 `legacy-layout`、纯 folder delete `dirRemoved:true`；**R13** 混合态并发三动作全 `layout-conflict`、零写盘；**M7** 短路检测 → R5 变红 | 已修复 |
| **F3 low** 丢弃 `otherEntries`/`dirRemoved` | 输出 + 摘要 | **R9**：`otherEntries` 恰为 `['fig','notes.md']` 且摘要逐个点名；`dirRemoved:false` + 摘要含「未删净/同名子专题」；M9/M10 分别把两处改死 → R9 变红 | 已修复 |
| **F4 low** `ctx.get` 抛错冒泡裸 Error | 统一 `approval-unavailable` | **R10** / **A4**：`ManageError{code:'approval-unavailable',status:503}`、消息以 `[library_manage:approval-unavailable]` 开头、快照不变、无 `.trash`；**M8** 回退成 `finally` → R10 变红 | 已修复 |

**修复自身的 TOCTOU（新增攻击 R12，上轮没有）**：审批挂起期间把「混合态/目标占位」造出来，执行期必须重新预检——
- 12a delete：预检干净 → 挂起时写 `T/P.pdf` → 执行期 `layout-conflict`，论文夹未动、无 `.trash`；
- 12b move：同注入 → `layout-conflict`，目标专题未出现论文夹（不会「同一篇两处」）；
- 12c rename：挂起时写 `T/Q.pdf` → 执行期 `target-exists`，源未改名、目标未出现。
⇒ `renamePaper`/`deletePaper`/`movePaper` 都在执行期重算计划，工具层预检只是「提前拒绝 + 不打扰用户」，不是「用旧计划执行」。

**UI 路由共用同一实现（静态+库层实证）**：`src/host.ts` 本轮未改，仍直接调用 `planPaperDelete`/`deletePaper`/`renamePaper`（`:656/:686/:693/:716/:723`）。库层实测：`renamePaper` 对 legacy 目标 = `target-exists`、对混合态 = `layout-conflict`、`deletePaper`/`planMovePaper` 对混合态 = `layout-conflict` ⇒ 修复不是只加在工具层。`lib/client.js` 的 `errText` 无 `layout-conflict` 分支，走 `err.message` 兜底（不会空白）。

**「先在界面完成迁移」的提示不是死路（实证）**：用迁移预检（只读）分类混合态 —— 同内容残留被认作 `alreadyDone`（迁移会清源收口）；异内容残留报 `conflict` 并注明「文件夹赢：不覆盖、不删源」（须用户自己定夺）。见 `.probe/t4/r2-migration-hint.mjs` 输出。

## 3. 本轮攻击清单（38 条，每条可单独复跑）

命令：`node .probe/t4/probes.mjs --only <id>`（一条一个进程；退出码矩阵见 `.probe/t4/r2-probe-matrix.txt`，38/38 为 0）。

- **A 审批门（7 条）**：闭集外 10 种返回值、控制组、自填确认参数、四种通道不可用（含 `get` 抛错现在必须带机器码）、挂起期间 abort、载荷形状、锁持有/释放 —— 全部 PASS（与第一轮同断言，新 HEAD 复跑）。
- **B 路径安全（6 条）**：库内符号链接专题 ×4 动作、库外符号链接论文夹、12 种词法变形 ×4 写路径、**move TOCTOU 链接替换**、旧布局移动拒绝、源文件边界（FIFO/设备/目录/链接/空/非 PDF）—— 全部 PASS。
- **C 破坏性正确性（8 条）**：回收站逐文件 sha256 + manifest + 按相对路径恢复、5 路并发删除、移动 vs 删除并发、整目录移动含隐藏目录/链接、收录原子性、收录目标竞态不覆盖、失败零残留、空专题隐藏条目 —— 全部 PASS。
- **D/ E（4 条）**：rename 冲突零副作用（**新口径：`requests===0`**）、同名改名不弹审批、大小写/变体口径、无迁移执行路径 —— 全部 PASS。
- **R 本轮新增（13 条）**：

| id | 攻击 | 结果 |
| --- | --- | --- |
| R1 | rename → 被 legacy 平铺文献占用的名字 | `target-exists`、审批 0 次、快照不变、不遮蔽 |
| R2 | rename → 已存在论文夹 | `target-exists`、审批 0 次、快照不变 |
| R3 | rename → 只剩孤儿 sidecar / 变体（`Q.mineru.json`、`Q-zh.pdf`） | `target-exists`、快照不变 |
| R4 | 大小写-only 改名 `P→p`（对照组，防过度拦截） | 成功，`listPapers=['p']` |
| R5 | 混合态 delete | `layout-conflict` 409、`extra.files` 点名、审批 0 次、快照不变 |
| R6 | 混合态 rename | `layout-conflict`、审批 0 次、快照不变 |
| R7 | 混合态 move | `layout-conflict`、审批 0 次、快照不变、源/目标无重复身份 |
| R8 | 对照组：纯 legacy delete/rename、legacy move、纯 folder delete | 依既有语义（成功/成功/`legacy-layout`/`dirRemoved:true`） |
| R9 | move 的 `otherEntries` / delete 的 `dirRemoved` 与摘要 | 逐项如实，摘要点名 |
| R10 | `ctx.get` 抛错 | `approval-unavailable` 503、带前缀、零副作用 |
| R11 | `create_topic` 同名普通文件 / 真目录 / 符号链接 | 409 `target-exists` / 幂等 `created:false` / `escape-rejected` |
| R12 | **修复自身的 TOCTOU**（审批挂起期间造混合态/目标占位，delete/move/rename 各一） | 执行期重算 ⇒ `layout-conflict`/`layout-conflict`/`target-exists`，零副作用 |
| R13 | 混合态并发 delete+rename+move | 三者全 `layout-conflict`、零写盘、审批 0 次 |

## 4. 变异测试（10 条自造 + 25 条复核）

沙箱副本执行（`.probe/t4/sandbox`），判定器为**我自己的探针**或既有契约用例；还原后文件 blob 必须逐字节等于 `HEAD`。

| id | 注入的缺陷 | 判定器 | 注入 | 还原 | diff |
| --- | --- | --- | --- | --- | --- |
| M1 | 审批门短路 | 用例 B1 | 1 RED | 0 GREEN | 251d483dfbc9 |
| M2 | 批准后不复查 abort | 探针 A5 | 1 RED | 0 GREEN | 251d483dfbc9 |
| M3 | 落盘 `linkSync`→`renameSync`（覆盖） | 探针 C6 | 1 RED | 0 GREEN | d828b881a257 |
| M4 | 移动不拒旧布局 | 探针 B5 | 1 RED | 0 GREEN | d828b881a257 |
| M5 | 会话不可知 fail-open | 用例 D5 | 1 RED | 0 GREEN | 5a324681eb17 |
| M6 | **F1 回退**：三路冲突短路 | 探针 R1 | 1 RED | 0 GREEN | d828b881a257 |
| M7 | **F2 回退**：混合态不再拒 | 探针 R5 | 1 RED | 0 GREEN | d828b881a257 |
| M8 | **F4 回退**：`get` 抛错冒泡 | 探针 R10 | 1 RED | 0 GREEN | 251d483dfbc9 |
| M9 | **F3 回退**：`dirRemoved` 恒 true | 探针 R9 | 1 RED | 0 GREEN | 251d483dfbc9 |
| M10 | **F3 回退**：丢弃 `otherEntries` | 探针 R9 | 1 RED | 0 GREEN | 251d483dfbc9 |

实现方 LM01–LM25 复核（沙箱内，不采信其日志）：**24/25**，唯一失败是 `LM04` 锚点命中 0 次（R-F1，见 §0）。把锚点按建议改成新行后，`--only LM04` = 注入=1 / 还原=0 / diff=clean（沙箱实证；现场已还原）。

## 5. Findings

| id | severity | 位置 | 问题 | requiredFix |
| --- | --- | --- | --- | --- |
| R-F1 | medium | `test/mutation-probe.mjs:330-333`（`from`/`to` 在 `:331-332`） | t6 为修 F4 把 `const svc = …` 改成 try 块内的 `svc = …`，但没同步 `LM04-no-service-continues` 的两个锚点 ⇒ `node test/mutation-probe.mjs --only LM04` **exit 1（锚点命中 0 次）**，`--only LM` 全量 24/25。该靶子对应「无审批服务时伪造一个总是允许的服务」（B5 的 fail-open 防线）——靶子死了，这条 fail-open 就失去变异守护。t6 只跑了 `--only LM2` 子集（LM20–LM25），因此未发现。 | 把 `from` 改成 `    svc = typeof get === 'function' ? (get.call(ctx, 'approval') as ApprovalAsk | undefined) : undefined`；`to` 改成同一行外层加 `?? ({ request: async () => 'allowed-once' } as ApprovalAsk)`。跑 `node test/mutation-probe.mjs --only LM` 应回到 25/25（我在沙箱副本按此改后 LM04 = 注入红/还原绿/diff clean）。 |
| R-F2 | low | `docs/library-manage-tools-repair.md:22`、`:74` | 修复记录的数字自相矛盾：`:22` 写「G 组新增 7 例，总数 52 → 59」（实际 G 组 10 例、总数 **62**）；`:74` 写「641 tests / 605 pass」（实际 **644 / 608**）。同文件 `:85-86` 又是 62/644。t5 集成按此核对会困惑。 | 统一为 62 例、644 tests / 608 pass / 0 fail / 36 skipped；「新增 7 例」改成「新增 10 例（G1a–G6）」。 |
| R-F3 | low | `src/library-manage.ts:1433-1436` | `createTopic` 的祖先段循环仍用 `existsSync` + `resolveTopicDir`：若**祖先段**是普通文件（如 `F/sub` 而 `F` 是文件）返回 404 `not-found`「专题不存在」；而**精确目标段**是普通文件现在是 409 `target-exists`（t6 修的）。同一类「名字被占用」两个码，agent 难以解释（继承行为，零副作用，不阻塞）。 | 可选：祖先循环也用 `existingEntryKind` 判形态，普通文件/链接按 409 `target-exists` / 400 `escape-rejected` 收口；或明确在文档里登记「只有末段有精确错误码」。 |

## 6. 残留风险与未覆盖面

1. **混合态的收口路径依赖迁移**：同内容残留迁移可 `alreadyDone` 清源；**异内容残留是迁移冲突**（文件夹赢、不覆盖、不删源），需要用户自己决定保留哪份——工具侧不再提供半篇操作（这是 F2 选 (a) 的代价，符合「迁移执行只留界面」红线）。
2. **`clearTopic`（UI 批量清空）仍只清论文夹那一半**（`src/library-manage.ts` 的 `planClearUnit` 未改，t6 已在 repair §4.3 登记）。混合态库若走「清空专题」会留下平铺残留并变回 legacy 身份；随后可再删那篇 legacy（两步收口），但不在本轮工具契约内。
3. **UI 文案**：`lib/client.js` 的 `errText` 没有 `layout-conflict` 分支，走 `err.message` 兜底（可读，但不如专门文案）；`lib/` 不在本轮 inScope。
4. **UI 的 `POST /api/library/topic` 仍 404**（同名普通文件）：只有 tool 侧统一成 409（repair §4.5 已登记）。
5. **上轮 §10 的残留未变**：paper preset 会话里审批 UI 的真机可达性（静态证据成立、未真机验证；不可达时是 fail-closed 不可用而非绕过）、`displayReason` 在 0.2.x 的展示行为、跨进程并发（进程内锁）、`hasPdfMagic` 前 1KB 容忍、Windows/macOS 的 EBUSY/大小写分支未实跑。
6. **本轮未覆盖**：`clearTopic` 的混合态半清（见 2）、迁移执行本身（红线，不在工具契约）、`presets/` persona 文案与工具的语义一致性（只做了静态阅读）。

## 7. 证据文件

| 文件 | 内容 |
| --- | --- |
| [docs/review/probes.mjs](review/probes.mjs) | 38 条自造攻击（A–E + R1–R13），`node docs/review/probes.mjs [--only ID]` |
| [docs/review/mutations.mjs](review/mutations.mjs) | 10 条自造变异（沙箱 `.probe/t4/sandbox`，不碰被评审检出） |
| `.probe/t4/r2-probe-matrix.txt` | 38 条探针逐条退出码（全 0） |
| `.probe/t4/r2-mutations.log` | 10 条自造变异结果（10/10） |
| `.probe/t4/lm-probe-r2.log` | 沙箱内 LM01–LM25 复跑（24/25，LM04 锚点失效） |
| `.probe/t4/r2-lib-level.mjs` | 库层（UI 路由共用）三路/混合态拒绝实证 |
| `.probe/t4/r2-migration-hint.mjs` | 「先在界面完成迁移」提示的真实性（alreadyDone vs conflict） |
| `.probe/t4/r2-typecheck.log` / `r2-npm-test.log` | typecheck exit 0 / npm test 644-608-0-36 |
