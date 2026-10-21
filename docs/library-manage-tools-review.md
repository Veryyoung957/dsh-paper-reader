# t4 对抗评审：agent 文献整理工具 `library_manage`

- 评审对象：`feat/library-manage-tools` @ `af8d87d`（父 `d37fe49`，基线 `57309b2`）

> **状态更新（t5 集成收尾，当前 tip `2f5e14f`）**：本报告的 verdict=needs_revision 针对 `af8d87d`；
> F1–F4 已由 `89a1186` 修复并经第二轮复核（[review-round2](library-manage-tools-review-round2.md)），
> 其 R-F1/R-F2 由 `2f5e14f` 修复后第三轮给出 **verdict=pass**（[review-round3](library-manage-tools-review-round3.md)）。
- 冻结契约：[docs/library-manage-tools-plan.md](library-manage-tools-plan.md)
- 评审方式：**不复用实现方 `test/` 的断言做结论**；自造 25 条对抗探针 + 5 条自造变异 + 在沙箱副本里复跑实现方 LM01–LM20
- 环境：Node v22.22.1；`@deepseek-ai/dsh-tools` 0.1.5-rc.2（devDep）；`@deepseek-ai/dsh-user-approval` 0.1.5-rc.3（传递安装，审批 API 以此为准）
- 日期：2026-10-20

## 0. 结论

**verdict: needs_revision** —— 五条红线（审批 fail-closed、无「模型自填确认」、工具层无迁移执行路径、路径穿越拒绝、非 allowed-once 零副作用）**全部通过且证据独立**；但**破坏性动作在「论文夹与旧平铺产物并存」的库上会静默给出错误的成功报告，并能让一篇既有文献从库里消失（被遮蔽）**（F1/F2）。这是本产品线正在迁移的那批库的真实形态（迁移冲突 = 平铺残留），因此不算边角。

- F1（high）：`rename_paper` 只查论文夹目录冲突，不查同专题平铺同名产物 ⇒ 改成的名字若已被一篇旧布局文献占用，会把这**既有文献从列表里静默遮蔽**（内容仍在盘上），工具返回 `ok:true`。
- F2（medium）：`delete_paper` / `rename_paper` / `move_paper` 在「论文夹 + 同 stem 平铺残留」并存时各自只处理一半，且报告成功：删除后该篇仍以 legacy 形式列在库里；改名后旧名仍以 legacy 形式出现；移动后同一篇同时出现在源专题（legacy）与目标专题（重复身份）。
- F3（low）：`move_paper` 丢弃库层已算出的 `otherEntries`、`delete_paper` 丢弃 `dirRemoved`，摘要不提「用户自放条目也被一起搬走 / 目录未删净的残留会变成幽灵子专题」。
- F4（low）：`ctx.get('approval')` 自身抛错时未被统一成 `approval-unavailable`（抛裸 `Error`，无 `[library_manage:*]` 前缀），与 §4.1「所有拒绝都有机器码」有极小缺口（仍 fail-closed）。

核心红线的结论**不受**上述 finding 影响：审批绕过、fail-open、路径逃逸、回收站/并发/原子性，我这 25 条攻击没有打穿任何一条（含实现方未覆盖的两条：审批挂起期间 abort、`ctx.get` 抛错）。

## 1. 方法独立性

1. 所有结论来自我自己的探针（`.probe/t4/probes.mjs`，已复制到 [docs/review/probes.mjs](review/probes.mjs)）与自己的变异表（[docs/review/mutations.mjs](review/mutations.mjs)），**没有**引用 t2 的用例断言作为证据；t2 的 `test/` 只在「变异判定器」这一角色上被我复核（见 §7，在**沙箱副本**里跑）。
2. 「零副作用」一律用**递归 sha256 快照**（含 `.trash`）判定，不看返回值自述。
3. 变异在 `.probe/t4/sandbox`（检出的完整副本 + `node_modules` 软链）中做，**从不改被评审的检出**；还原后要求 `git hash-object` 与 `HEAD` 的 blob 逐字节一致。
4. 审批 API 的合法性不看文档自述：直接读 `node_modules/@deepseek-ai/dsh-user-approval/lib/types/index.d.ts` 与 `lib/index.js`，并与 `@deepseek-ai/dsh-tools` 自己的 `serviceAsk()`（`lib/index.js:3305` 起，同样 `ctx.get("approval")`）对照。

## 2. 基线数字（自跑，如实记录）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `cd .worktrees/library-manage-tools && npm run typecheck` | 0 | tsc 无输出 |
| `cd .worktrees/library-manage-tools && npm test` | 0 | `# tests 634` / `# pass 598` / `# fail 0` / `# skipped 36` / `# cancelled 0` / 37.2s（`pretest` 自动 build） |
| `node .probe/t4/probes.mjs` | 0 | 25/25 PASS |
| `node .probe/t4/mutations.mjs` | 0 | 5/5「注入必红 / 还原必绿 / diff clean」 |
| 沙箱内 `node test/mutation-probe.mjs --only LM` | 0 | 20/20（注入=1，还原=0，diff=clean） |
| `git diff 57309b2..HEAD -- src/migrate.ts` | 0 | 空（见 §8 ⑦） |
| `git status --porcelain` | 0 | 评审开始/结束均为空（评审产物只落 docs/ 与本轮之后的提交） |

`node --test` 的 36 条 skipped 全部是平台/环境条件跳过（Windows 专用夹具、需外部二进制的组），不是本轮新增的「跳过即绿」。

## 3. 自造攻击清单（25 条，每条可单独复跑）

命令模板：`node .probe/t4/probes.mjs --only <id>`（每条单独跑，退出码已逐条采集于 `.probe/t4/probe-matrix.txt`，25/25 为 0）。

| # | 攻击 | 期望 | 退出码 | 结果 |
| --- | --- | --- | --- | --- |
| A1 | 审批返回值不在闭集：对象 `{outcome:'allowed-once'}`、`'allow'`/`'allowed'`/`'ALLOWED-ONCE'`/`'allowed-once '`/`''`/`null`/`1`/`true`/数组 | 全部 `approval-unavailable` + 零副作用 | 0 | PASS（10 种坏值全拒） |
| A2 | 控制组：真 `'allowed-once'` | 必须真的执行（证明 A1 非空转） | 0 | PASS（论文消失、回收站有 bundle） |
| A3 | 参数面「自填确认」冒充：`confirm/approval/approved/token/force/user_said_yes`，配 rejected/cancelled/unavailable 三态；并快照参数键集合 | 三态仍拒、零副作用；参数里无 confirm 族 | 0 | PASS |
| A4 | 审批通道：无服务 / `request` 抛错 / `ctx.get` 抛错 / 无 `exec.agent` | fail closed、零副作用 | 0 | PASS（`ctx.get` 抛错时错误形状为非 ManageError → F4） |
| A5 | **审批挂起期间 abort**：request 未决 → abort → 再返回 `allowed-once` | `approval-cancelled`、零副作用 | 0 | PASS（这条能打红 M2） |
| A6 | 审批载荷：`toolName/agent/callId/signal/reason`；reason 指名 `T/P` 且含 one-shot；`displayReason===reason` | 全部成立 | 0 | PASS |
| A7 | 锁语义：审批挂起时同目标第二次调用 | `busy`；失败后锁必须释放（下一次可成功） | 0 | PASS |
| B1 | 库内符号链接专题（`L→T`）：delete_topic / rename_topic / delete_paper / move_paper | `escape-rejected`/`not-found`、零副作用、**不弹审批** | 0 | PASS（4 个动作） |
| B2 | 论文目录本身是指向库外的符号链接 | `escape-rejected`；库外逐字节不变 | 0 | PASS |
| B3 | 词法变形 × 4 条写路径：`T/`、`T//S`、`T/.`、`T/..`、`T/../S`、`.trash`、`.trash/x`、`T\0`、`..`、`../T`、`/etc`、`T\S` | 拒绝 + 零副作用 | 0 | PASS（12×4 组合） |
| B4 | **TOCTOU**：`planMovePaper` 之后把源论文夹换成指向库外的符号链接，再执行 `movePaper` | 执行期重新解析 ⇒ 拒绝；库外不被搬动 | 0 | PASS（无 `S/P` 出现） |
| B5 | 旧布局平铺文献 `movePaper` | `legacy-layout` 409、快照不变 | 0 | PASS（这条能打红 M4） |
| B6 | 源文件边界：FIFO / 字符设备 / 目录 / 符号链接 / 不存在 / 空 / 非 PDF | 各自拒绝码；不挂起（FIFO 不读） | 0 | PASS |
| C1 | 回收站一致性：9 个产物 + `-zh` 变体 + 隐藏 `.DS_Store` + 未知 `notes.md` | 逐文件 sha256 一致；manifest 带 `relativeDir/trashSubdir/files`；未知条目留在原处；按 manifest 移回后快照回到原状 | 0 | PASS |
| C2 | 并发 5 次 `delete_paper` 同一篇 | 恰好 1 成功、4 个 `busy`、只 1 个 bundle、审批只 1 次 | 0 | PASS |
| C3 | 并发「移动 vs 删除」（3 轮） | 论文恰好存在于一处（源/目标/回收站），绝无两处或零处 | 0 | PASS |
| C4 | 整目录移动：全部产物 + 隐藏目录 + 论文夹内符号链接 + `detachedSessions` 口径 | 内容 sha256 全同、链接仍是链接、链接目标不变、`detachedSessions=2` | 0 | PASS |
| C5 | 收录原子性：内容一致、无 `.tmp-*`、源只读 | 成立 | 0 | PASS |
| C6 | **收录目标竞态**：预览之后、落盘之前别人写出同名文件 | `target-exists` 且不覆盖既有内容 | 0 | PASS（这条能打红 M3） |
| C7 | 收录中途 ENOSPC（专题已存在但目标不存在） | 零残留（含不留空目录） | 0 | PASS |
| C8 | 仅有隐藏条目的空专题删除 | 隐藏条目进回收站、目录消失、manifest `topic-hidden` | 0 | PASS |
| D1 | rename 目标冲突发生在**授权之后** | `target-exists`、零副作用（用户被多打扰一次，如实记录） | 0 | PASS |
| D2 | rename 到同名 | 授权**之前** 400，不弹审批 | 0 | PASS |
| D3 | 大小写/变体口径：`Upper.PDF` 源、名字 `.PDF`、`Paper-ZH`、`Paper-zh` | 大写源可收录成 `Upper`；名字带 `.PDF` 拒；`-ZH` 允许且仍在库；`-zh` 拒 | 0 | PASS |
| E1 | 迁移红线（静态）：真实 import 名集合、动态 `import()/require()`、dist 内 `runMigration(`/`rollbackMigration(`、action 闭集、无 `migration-logs` | 全部成立 | 0 | PASS |

## 4. 审批门与 fail-open（专节）

- **只认 `allowed-once`**：`outcome !== 'allowed-once'` 之外先做 `typeof === 'string'` + 闭集判定（`src/tools.ts:527-531`）。A1 的 10 种「看起来像允许」的返回值全部 `approval-unavailable`，快照逐字节不变；A2 证明真允许会执行。
- **三态零副作用**：A1/A3/A4 覆盖 rejected/cancelled/unavailable × 5 个破坏性 action 的等价路径（t2 的 B1–B3 也覆盖 5×3，我独立复核，未采信其结论）。
- **「模型自填确认」不存在**：参数键集合 = `action/name/new_name/source_path/to_topic/topic`（A3 快照断言），无 confirm 族；正文「确认」无法进入工具；`approval` 只是**输出**字段，把它塞进参数在三态下都不改变结论（A3）。
- **审批在写盘之前**：`requestManageApproval` 在 `deletePaper/renamePaper/renameTopic/movePaper` 调用之前（`src/tools.ts:1311/1343/1374/1399/1433`）；M18（实现方 LM18）把审批移到执行之后必红。
- **批准后再复查取消**：`src/tools.ts:534`。A5 是唯一能覆盖这条的攻击（abort 发生在 request 未决期间），M2 证明它非空转。
- **失败后不死锁**：A7 证明 approve→reject→approve 三次调用可依次到达审批，锁在 try/finally 释放（`src/library-guards.ts:110-119`）。
- **通道形状与官方一致**：`ctx.get('approval')` + `request({agent, toolName, callId, reason, signal})` 与 `dsh-tools` 的 `serviceAsk()` 同构；`dsh-user-approval` 的 `request()` 在无 open turn / 审计失败时抛错，本工具捕获后按 `unavailable` 拒绝（`src/tools.ts:523-526`）——与官方 fail-closed 取向一致。
- **未发现**任何「先做后问」「无服务时伪造 allow」「把 unknown 当 0 会话」的 fail-open（M1/M3/M5 三条变异分别把这三处改坏，判定器全红）。

## 5. 路径安全（含符号链接、TOCTOU）（专节）

- 三层防护未因复用/下沉而变弱：词法（`validateTopicPath` 逐段 + 保留名 `.trash`）→ `lstat` 拒符号链接 + `realpath===字面路径` → `assertInside` 严格子路径（拒绝 `target===root`）。B1 的 4 个动作与 B2 的库外指针全部 `escape-rejected`，库外快照不变；且只读预检失败时**不弹审批**（`requests=0`）。
- **TOCTOU（队长点名 ③）**：`planMovePaper` 在审批前只读预检，执行时 `movePaper` **内部重新 plan**（`src/library-manage.ts:1590`）。B4 在两次之间把源论文夹换成指向库外的符号链接，执行期重新 `lstat` 即拒，库外内容一字节未动、目标无 `S/P`。⇒ 不存在「用旧计划执行」的窗口。
- 收录侧：源 `lstat` 拒符号链接/FIFO/设备（B6），`realpath` 后读魔数；落盘 `linkSync` 不覆盖（C6：竞态下既有文件内容 `ATTACKER-CONTENT` 完好，错误码 `target-exists`）；中途失败清理到零残留（C7）。M3 把 `linkSync` 换成 `renameSync` 后 C6 立刻变红 ⇒ 该防护是有效防线而不是装饰。
- 旧布局移动拒绝（B5）+ M4 证明这条红线有测试守：把守卫去掉后，`movePaper` 会把整个专题目录 rename 进论文夹（等价于偷偷执行一篇迁移），B5 变红。

## 6. 破坏性正确性（产物完整、回收站一致、并发）（专节）

- **回收站一致（C1）**：9 类产物 + 译文变体 + 隐藏条目逐文件 sha256 与删除前一致；`manifest.json`（bundle 根与论文名子目录各一份）给出 `relativeDir='T/P'`、`trashSubdir='P'`、文件清单；按 manifest 移回后快照与删除前完全一致；未知条目 `notes.md` 不被吞（`dirRemoved:false` 的库层语义）。
- **并发（C2/C3）**：5 路同目标删除 → 1 成功 4 busy、1 个 bundle、审批 1 次；移动与删除并发 3 轮 → 论文恒在且仅在一处（无「两处都有」或「两处都无」）。
- **整目录移动（C4）**：隐藏子目录、论文夹内指向库外的符号链接、`-zh` 变体全部随目录搬迁且内容/链接身份不变；`detachedSessions` 取会话总数（2）。
- **收录原子性（C5/C7）**：内容==源、无 `.tmp-*`、源只读；ENOSPC 注入后零残留。
- **删除空专题（C8）**：仅隐藏条目的专题：隐藏条目进回收站 + 目录消失 + manifest `kind:'topic-hidden'`。

## 7. 变异测试（5 条自造 + 20 条复核）

自造变异在沙箱副本执行，判定器是**我自己的探针**或既有契约用例；还原后要求文件 blob 与 `HEAD` 一致。

| id | 注入的缺陷 | 判定器 | 注入 | 还原 | diff |
| --- | --- | --- | --- | --- | --- |
| M1 | 审批门短路 `outcome !== 'allowed-once'` → `if(false)` | t2 用例 B1 | exit=1 RED | exit=0 GREEN | blob 62e053dc7220 == HEAD |
| M2 | 批准后不再复查 `signal.aborted` | 我的 A5 | exit=1 RED | exit=0 GREEN | blob 62e053dc7220 == HEAD |
| M3 | 落盘 `linkSync` → `renameSync`（覆盖既有文件） | 我的 C6 | exit=1 RED | exit=0 GREEN | blob d28c259a8246 == HEAD |
| M4 | 移动不再拒绝旧布局 | 我的 B5 | exit=1 RED | exit=0 GREEN | blob d28c259a8246 == HEAD |
| M5 | 会话不可知 `unknown:true` → `false`（fail-open） | t2 用例 D5 | exit=1 RED | exit=0 GREEN | blob 5a324681eb17 == HEAD |

复核实现方 LM01–LM20（**在我的沙箱副本里跑，不是采信其日志**）：20/20 均为「注入=1 / 还原=0 / diff=clean」。另做静态锚点核对：20 条 LM 变异的 `from` 字符串在 HEAD 源码里**各命中恰好 1 次** ⇒ 最终提交里**没有**残留变异（与全量 598 pass 互相印证）。

## 8. 队长点名项逐条判定（不照抄 t2 结论）

**① `validatePaperName` 变体后缀保持大小写敏感（方案 §3.2.2 写 /i）——判定：合理，且不导致大写 `.PDF` 无法 add/改名。**
代码事实：`.pdf` 后缀判据是 `name.toLowerCase().endsWith('.pdf')`（`src/library-manage.ts:150`，**大小写不敏感**），变体后缀判据 `/-en$|-zh$|-dual$/`（`:158`，大小写敏感）；`isPaperPDF`（`src/library.ts:45-49`）对变体后缀同样大小写敏感。D3 实测：`Upper.PDF` 源可被收录为 `Upper`（去后缀走 `toLowerCase`）；名字 `X.PDF` 被拒（这是对的：名字不该带扩展名）；`Paper-ZH` 允许且 `listPapers` 仍列出；`Paper-zh` 被拒（否则会被当译文变体隐藏）。若按方案改 `/i`，既有 VB9/S12 契约（大写 `-ZH` 可改名且仍在库）会 400，属回归。**结论：保持现状。**

**② 透传 `displayReason`（方案 §0.4 冻结「不用」）——判定：对 0.1.5 无影响；不构成 fail-open。**
`dsh-user-approval@0.1.5-rc.3` 的 `ApprovalRequest` 类型没有 `displayReason`，其 `request(req)` 只读 `agent/toolName/callId/reason/signal`（`lib/index.js:131-147`），多余键被忽略；工具用**本地结构化类型**且该字段可选（`src/tools.ts:452-459`），不参与任何判断（A6 断言 `displayReason===reason`，A1 证明判定只看 outcome）。残余：0.2.x 的展示行为在本仓库不可验证（见 §10）。

**③ 新增 `planMovePaper`——判定：无 TOCTOU、无绕过，是正确抽象。**
`movePaper` 内部重新 plan（`src/library-manage.ts:1590`），B4 的链接替换攻击被拒；`move_paper` 的审批仍在 plan 之后、执行之前，且执行用的是**重新算出**的 plan；`planMovePaper` 只读（B4/B5 的快照断言）。未发现用旧计划执行或「预检通过但执行落到别处」的路径。

**④ 枚举由框架 schema 先校验 + rename 目标冲突在授权后兜底——判定：安全上可接受（零副作用已验证），但有 UX 代价。**
D1 实测：审批后才发现 `target-exists`，快照 100% 不变（铁律「非 allowed-once/失败 ⇒ 零副作用」成立）；代价是用户被多打扰一次（`requests=1`）。E10 已按此钉住错误码与零副作用。**建议**（非阻塞）：把 rename 的目标三态冲突检查（论文夹/平铺/孤儿产物）提到授权前，与 `add_paper`/`planMovePaper` 同口径——顺带修掉 F1。

**⑤ F1「无迁移执行路径」用例强度——判定：够用但不完整；我已补一层。**
该用例断言 `tools.ts` 里**具名 import 集合恰为** `['formatMigrationReport','planMigration']`（命名空间 import 会让 `importLine` 不匹配而红）、dist 内无 `runMigration(`/`rollbackMigration(`、action 闭集、无 `migration-logs`。它对「新增具名 import」「把执行函数搬进 tools.ts 直接调用」是有效的。**可绕过点**：它不检查动态 `import('./migrate.ts')`、require、也不检查**传递依赖**里是否出现执行能力（`tools.ts → migrate-prompt/library-manage → …`）。我的 E1 额外禁掉动态 import/require 并检查 dist 调用名；仍属源码正则级证据，不是真正的模块图分析（见 §10）。

**⑥ 改 `test/reader-ux-verification.test.mjs` 白名单加 `presets/`——判定：必要、不算放宽安全守卫。**
该用例检查的是「工作区**未提交**改动是否越界」；本轮 inScope 明确包含 `presets/paper-reader/agent.cordis.yml`（persona 必须列出新工具与安全用法，方案 §1.7 指定改该文件）。不登记就会在 persona 编辑未提交时误报越界。它放宽的是**scope 白名单**（与 `src/`、`test/`、`docs/` 同级粒度），**没有**放宽同一用例里更强的「上游 6 个 library 用例差异必须等于登记清单」断言。残余：整目录粒度意味着今后任何 `presets/` 改动不再被这条守卫盘问——与既有 `src/` 同款，属已接受的设计。

**⑦ t2 过程误跑 mutation-probe 污染 `src/migrate.ts`——判定：最终提交干净。**
`git diff 57309b2..HEAD -- src/migrate.ts` 为空；工作区 `git status --porcelain` 为空；`src/migrate.ts` 的 `git hash-object` == `HEAD:src/migrate.ts`（79332bca…）；20 条 LM 锚点在 HEAD 源码各命中 1 次；沙箱里 20/20 LM 复核「注入红/还原绿/diff clean」。⇒ 无残留变异。

## 9. Findings

| id | severity | 位置 | 问题 | requiredFix |
| --- | --- | --- | --- | --- |
| F1 | high | `src/library-manage.ts:1133-1139`（`if (existsSync(targetDir))`，具体 `:1134`）；工具入口 `src/tools.ts:1330-1336` | 新布局 `renamePaper` 只检查目标**论文夹目录**是否已存在，不检查同专题的平铺同名产物（`<newName>.pdf` / `<newName>.txt` / 孤儿 sidecar）。若该名字已被一篇旧布局文献占用，改名会**成功**并把那篇既有文献从 `listPapers` 里静默遮蔽（论文夹优先，平铺被跳过）——内容没丢但身份消失，工具返回 `ok:true`，审批 reason 也不提冲突。复现：`T/P/P.pdf` + `T/Q.pdf`（legacy）→ `rename_paper P→Q` ⇒ `listPapers(T)` 从 `[P, Q(legacy)]` 变成 `[Q]`，`T/Q/Q.pdf` 内容是 P 的，原 `T/Q.pdf` 仍在盘上但不可见。注：`move_paper` 对同样的目标状态是拒绝的（`target-exists`，我的对照实验），说明这是遗漏而非设计。 | 把目标冲突检查统一成与 `add_paper`/`planMovePaper` 相同的**三路**判定：`existsSync(<topicDir>/<newName>/)`、`existsSync(<topicDir>/<newName>.pdf)`、`listArtifacts(topicDir, newName).length > 0`，任一命中 → `target-exists` 且零副作用；最好在**授权前**完成（顺带解决 ④ 的 UX 代价）。补用例：legacy 同名 + 论文夹 + 孤儿 sidecar 三种目标各一条。 |
| F2 | medium | `src/library-manage.ts:566-575`（布局二选一：`isLegacyPaper(...) ? 'legacy' : 'folder'`）与 `:606-667`（deletePaper）、工具入口 `src/tools.ts:1390-1415` / `1301-1318` | 「论文夹 + 同 stem 平铺残留」并存（迁移冲突后的真实形态）时，破坏性动作只处理一半且报告成功：① `delete_paper` 删掉论文夹、返回 `ok:true files:['P.pdf']`，但 `T/P.pdf`+`T/P.txt` 仍在 ⇒ 该篇立刻以 `legacy` 身份重新出现在 `listPapers`；② `rename_paper P→R` 后 `listPapers` = `[P(legacy), R]`（旧名仍是一个可被再次删除/移动的条目）；③ `move_paper T→S` 后 = `[S/P, T/P(legacy)]`（**同一篇重复出现在两个专题**）。三者都返回 `ok:true`，摘要不提残留。 | 在 `planPaperDelete`/`planMovePaper` 里显式识别「论文夹存在且同 stem 平铺产物存在」的混合状态，二选一并写进契约：(a) 新增 `layout-conflict`(409) 拒绝并提示「请先在界面完成迁移」（与 move 拒 legacy 同取向，最小改动）；或 (b) 把平铺产物一并纳入回收站单元/移动单元，并在 `files`/摘要里如实列出。无论哪种，工具输出必须让 agent 能说真话；补三条用例（delete/rename/move 各一，断言操作后 `listPapers` 不含该篇旧身份）。 |
| F3 | low | `src/tools.ts:1324-1328`（move 输出）、`:1411-1415`（delete 输出） | 库层已算出 `MoveResult.otherEntries`（论文夹里不属于产物族的条目，随目录一起搬走）与 `PaperDeleteResult.dirRemoved`，工具层丢弃：`move_paper` 的 `files` 只含产物、摘要说「N 个产物随论文文件夹整体移动」，不告诉用户**自放文件/子目录也被一起搬走**；`delete_paper` 不告诉用户目录未删净（残留会在 `listTopics` 里变成同名子专题）。与项目「降级必须如实提示」原则不一致。 | 输出 schema 增补 `otherEntries`/`dirRemoved`（或在 `summary` 里如实追加一句）；补用例：论文夹里放一个未知文件后 move/delete，断言摘要与字段都提到它。 |
| F4 | low | `src/tools.ts:509-511` | `ctx.get('approval')` 本身抛错时异常未被统一：A4 实测错误形状为 `<non-ManageError:Error:resolver exploded>`（无 `[library_manage:<code>]` 前缀、无机器码），与 §4.1「所有拒绝都有 code」有极小缺口。当前 Cordis 的 `get(name)` 对缺失服务返回 `undefined`（`reflect.d.ts:14`），所以只有服务解析器抛错才会触发。 | 把 `get.call(ctx,'approval')` 包进 try/catch → `approvalError(lang,'unavailable',action)`；补一条 A4 变体断言错误码。 |

复现命令（F1/F2 三条合在一起）：见 [docs/review/probes.mjs](review/probes.mjs) 的 `D3`/`C1` 同款夹具，我在评审中另跑的脚本输出为：

```
[rename] before: [ 'P', 'Q(legacy)' ] entries: [ 'P', 'Q.pdf' ]
[rename] ok: true files: [ 'Q.pdf' ]
[rename] after : [ 'Q' ] entries: [ 'Q', 'Q.pdf' ]        ← 原 legacy Q 被遮蔽
[delete-mixed] ok: true files: [ 'P.pdf' ] → after: [ 'P(legacy)' ]
[move  -mixed] ok: true files: [ 'P.pdf' ] → after: [ 'S/P', 'T/P(legacy)' ]
```

（这三段用的夹具与探针 D3 相同：临时库里造 `T/P/P.pdf` 与新布局/旧布局混合，再走 `library_manage` 的审批替身 allowed-once。）

## 10. 残留风险与未覆盖面（即使修完 F1/F2 也应知道）

1. **paper preset 会话里审批 UI 是否可达**：静态证据链成立（`presets/paper-reader/agent.cordis.yml` 没有移除/改写审批策略；伴读会话是宿主普通 session；`ctx.get('approval')` 与官方 `serviceAsk` 同通道）；但**运行时未验证**（本机没有带 UI answerer 的 paper-reader 会话）。若不可达，行为是 `approval-unavailable` 全部拒绝（fail-closed），不是绕过——可用性风险，不是安全风险。
2. **`displayReason` 在 0.2.x 的展示行为**未验证（本仓库 devDep 0.1.5 无此字段）；本实现不依赖它做判断，故风险仅限「新版审批卡多/少一行说明」。
3. **跨进程并发**：在途锁是进程内 `Set`（`src/library-guards.ts:68`），与插件既有写路由同口径；两个 dsh 进程指向同一 dataDir 时不同步（计划已声明不在支持范围）。C2/C3 只覆盖进程内并发。
4. **F1/E1 类「无迁移执行路径」证据是源码/产物正则级**，不是模块图分析：传递依赖若新增迁移执行能力不会被发现。本轮我人工核对了 `tools.ts` 的直接 import 集与 dist 调用名。
5. **`hasPdfMagic` 只在前 1KB 找 `%PDF-` 子串**（`src/library-manage.ts:1363-1372`，按方案「允许前置垃圾」实现）：一个以 `%PDF-` 出现在前 1KB 的非 PDF 文件会被收录，随后转录失败。已按方案口径实现，本次只记录，不判缺陷。
6. **未知条目的「幽灵子专题」**：删除后残留目录在 `listTopics` 里表现为同名子专题（库内既有语义，README/docs 未描述对话侧表现）——F3 修好后至少 agent 能如实提示。
7. **未覆盖平台**：Windows/macOS 的大小写不敏感与 EBUSY/EPERM 分支只做静态审查；C8/D3 等用例只在 Linux（大小写敏感、无 EBUSY 注入）实跑。

## 11. 证据文件

| 文件 | 内容 |
| --- | --- |
| [docs/review/probes.mjs](review/probes.mjs) | 25 条自造攻击（本报告 §3），`node docs/review/probes.mjs [--only ID]` |
| [docs/review/mutations.mjs](review/mutations.mjs) | 5 条自造变异（本报告 §7），沙箱 `.probe/t4/sandbox`，不碰被评审检出 |
| `.probe/t4/probe-matrix.txt` | 25 条探针逐条的退出码（本地证据，gitignored） |
| `.probe/t4/lm-probe.log` | 沙箱内复跑实现方 LM01–LM20 的 20/20 结果（本地证据） |
| `.probe/t4/npm-test.log` | `npm test` 全量输出（634/598/0/36，exit 0） |
