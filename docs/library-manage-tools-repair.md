# t6 修复记录：`library_manage` 第二轮（t4 评审 findings F1–F4）

- 修复对象：`feat/library-manage-tools` @ `0f09dde`（其上是 `af8d87d` 的实现）
- 依据：t4 对抗评审 [docs/library-manage-tools-review.md](library-manage-tools-review.md) §9 的 findings，
  以及队长对 t6 的修复口径（F2 选 (a)：`layout-conflict` 拒绝）。
- 冻结契约仍是 [docs/library-manage-tools-plan.md](library-manage-tools-plan.md)；**本文件只登记偏差**，
  不修改冻结契约（契约与代码现状冲突时以证据为准，偏差逐条列在 §3）。

## 1. 逐条修复

| finding | 修复 | 位置 | 语义变化 |
| --- | --- | --- | --- |
| **F1**（high）rename 只查目标论文夹，会把被平铺同名产物占用的既有旧布局文献**静默遮蔽**并返回 `ok:true` | 新增 `planRenamePaper`：把目标冲突统一成与 `add_paper`/`planMovePaper` 相同的**三路**判定（`<newName>/` 目录、`<newName>.pdf` 平铺、`listArtifacts(topicDir,newName)` 孤儿产物/变体），任一命中 → 409 `target-exists`；`renamePaper` 内部也改成先 `planRenamePaper` 再动手（执行前重新算一遍 ⇒ 无 TOCTOU）。工具层在**审批之前**调用它 ⇒ 顺带消除「点完允许才发现冲突」的 UX 代价。 | `src/library-manage.ts`（`RenamePaperPlan`/`planRenamePaper`/`assertRenameTargetFree`；`renamePaper` 重构为消费它）；`src/tools.ts`（`rename_paper` 分支的预检从 `planPaperDelete` 换成 `planRenamePaper`） | 改名到「被平铺/孤儿占用的名字」以前会**成功并遮蔽**，现在 409 拒绝且零副作用；大小写-only 改名的既有放行语义（realpath 同一实体）逐字保留。UI 的 rename 路由共用 `renamePaper`，因此**同时获得同一加严**（不是只修工具层）。 |
| **F2**（medium）「论文夹 + 同 stem 平铺残留」混合态下 delete/rename/move 各只处理一半却报成功（删完变 legacy 幽灵、改名留旧名、移动后同一篇出现在两个专题） | 选 **(a)**：新增 `assertNoLayoutConflict`，在 `planPaperDelete` 里显式识别混合态 → 409 **`layout-conflict`**（新机器码），文案提示「先在界面完成迁移」，`extra.files` 列出残留文件、`extra.hint` 指向界面入口。`planMovePaper`/`planRenamePaper` 都经由 `planPaperDelete`，因此 delete/rename/move 三条路径统一拒绝；工具层在审批前就拿到该错误。 | `src/library-manage.ts`（`ManageCode` 新增 `'layout-conflict'`；`assertNoLayoutConflict`；`planPaperDelete` 调用点） | 混合态库（迁移冲突后的真实形态）上的 delete/rename/move 从「半篇操作 + ok:true」改为 **409 拒绝 + 零副作用**，取向与 `move_paper` 拒绝旧布局一致（迁移执行只留在界面）。**未**改动 `clearTopic`（UI 批量清空）与 `planTopicDelete`：混合态的论文夹+平铺会让专题「非空」，本就被拒。 |
| **F3**（low）`move_paper` 丢弃 `otherEntries`、`delete_paper` 丢弃 `dirRemoved`，用户自放条目被一起搬走/目录没删净都不说 | 输出 schema 增补两个**可选**字段 `otherEntries`（字符串数组）与 `dirRemoved`（布尔），并让 `summary`/`render` 如实追加：move 有非产物条目时点名「另有 N 个非产物条目随目录一起搬走：…」；delete 在 `dirRemoved=false` 时提示「论文目录未删净（非产物条目已原样保留），可能以同名子专题继续显示」。 | `src/tools.ts`（`ManageSummaryInput` + `formatSummary` 的 move/delete 分支、输出 schema、两处 return 填充） | 只加字段/文案，不改变写语义；`dirRemoved` 语义直接复用库层既有返回值（非递归 rmdir 失败即 false）。 |
| **F4**（low）`ctx.get('approval')` 自身抛错时冒泡裸 `Error`（无 code/前缀），与「所有拒绝都有机器码」有缺口 | 把 `get.call(ctx,'approval')` 包进 `try/catch` → `approvalError(lang,'unavailable',action)`（503 `approval-unavailable`，前缀 `[library_manage:…]`，零副作用）。 | `src/tools.ts`（`requestManageApproval`） | 只影响「服务解析器抛错」这一种异常：以前是裸 Error（仍 fail-closed），现在是带机器码的 `approval-unavailable`。 |
| **t3-low-1** `create_topic` 目标为同名**普通文件**时返回 404 `not-found`（零副作用），与 `add_paper`/`planMovePaper` 的「名字被占用 ⇒ 409」不一致 | `createTopic` 先按 `lstat` 判形态：真目录 ⇒ 幂等 `created:false`；普通文件/其它 ⇒ **409 `target-exists`**；符号链接 ⇒ 仍 `escape-rejected`。并发 `EEXIST` 分支走同一收口。 | `src/library-manage.ts`（`existingEntryKind`/`finishExistingTopic` + `createTopic`） | tool 侧 `create_topic` 的同名文件从 404 变 409（错误码更准，仍零副作用）。**UI 路由未改**（仍走 inline 逻辑给 404，见 §4 残留 6）。 |
| **t3-low-2** `addPaper` 成功路径的 `unlink(tmp)` 失败被空 `catch` 吞掉 | best-effort 两段清理（`unlinkSync` → `rmSync(force)`），两段都失败时 `console.warn` 留痕并注明「收录本身已成功」。**不扩 schema、不改 summary 契约**（不伪装成完全干净，也不把成功谎报成失败）。 | `src/library-manage.ts`（`addPaper` 落盘后的清理） | 失败路径从「静默」变成「尽力清理 + 运行日志留痕」；成功语义与输出字段不变。 |

## 2. 新增用例与变异靶子（评审可独立复跑）

新增 7 例（`test/library-manage-tools.test.mjs` G 组，总数 52 → 59）：

| 用例 | 断言要点 |
| --- | --- |
| `G1a[F1]` | 目标被**旧布局**同名文献占用（`T/Q.pdf`）：`target-exists` 409、**`approval.requests===0`**、sha256 快照不变、`listPapers` 仍为 `[T/P, T/Q]`（不被遮蔽）；正向控制：清掉占位后同一改名成功 → `[T/Q]` |
| `G1b[F1]` | 目标是**已存在的论文夹**（`T/Q/`）：`target-exists`、审批前拒绝、快照不变、`listPapers` 不变 |
| `G1c[F1]` | 目标只剩**孤儿 sidecar**（`T/Q.txt`）：`target-exists`、审批前拒绝、快照不变、孤儿原样保留、`listPapers` 不变 |
| `G2a/G2b/G2c[F2]` | 混合态 delete/rename/move 各一：`layout-conflict` 409、`extra.files` 点名残留、**不弹审批**、快照不变、`listPapers` 只出现一次身份（无 legacy 幽灵/旧名残留/两专题重复）；清掉平铺残留（等价用户完成迁移）后同一操作成功且 `listPapers` **不含旧身份** |
| `G3[F3]` | 论文夹里放 `notes.md` + 子目录 `fig/`：`otherEntries` 恰为 `['fig','notes.md']`，摘要逐个点名并说明「另有 2 个非产物条目随目录一起搬走」 |
| `G4[F3]` | 论文夹里放未知文件后删除：`dirRemoved:false`、摘要含「未删净 / 同名子专题」、未知文件原样保留；对照组无未知条目时 `dirRemoved:true` |
| `G5[F4]` | `ctx.get` 抛错：抛 `ManageError{code:'approval-unavailable',status:503}`、消息带 `[library_manage:…]` 前缀与「未做任何改动」、快照不变、无 `.trash` |
| `G6[t3-low-1]` | `create_topic` 目标为同名普通文件：409 `target-exists`、快照不变、文件不被覆盖；对照：已存在**目录**仍幂等 `created:false` |

变异靶子（`test/mutation-probe.mjs`，LF 检出里 `--only LM2` 可跑）：

| id | 注入 | 判定用例 |
| --- | --- | --- |
| `LM21-rename-target-conflict-open` | `assertRenameTargetFree` 的最终判定短路（`if (true) return`） | G1 必红 |
| `LM22-layout-conflict-open` | `assertNoLayoutConflict` 短路（`if (true) return`） | G2a/G2b/G2c 必红 |
| `LM23-move-other-entries-dropped` | `planMovePaper.otherEntries` 恒为空 | G3 必红 |
| `LM24-delete-dirremoved-forced` | 工具输出 `dirRemoved` 恒为 true | G4 必红 |
| `LM25-approval-get-uncaught` | `ctx.get` 的 try/catch 改成 try/finally（异常照旧冒泡） | G5 必红 |

## 3. 与冻结方案的偏差（本轮的「有据偏离」）

冻结契约（plan）写的是「复用既有 `renamePaper`/`planPaperDelete` 行为」，F1/F2 的修复**必然改变两处既有行为**，
逐条登记如下（都以 t4 评审的可复现缺陷为依据）：

1. **`renamePaper` 的目标冲突从「只看论文夹」升级为三路判定**（plan §3.1 把 `renamePaper` 列为纯复用）。
   - 为什么：只查论文夹会把一篇既有旧布局文献静默遮蔽（t4-F1，可复现）；`add_paper`/`planMovePaper` 早已是三路，属遗漏。
   - 哪些既有语义未动：改名仍是「先整体 rename 论文目录、再改目录内文件名」，失败逆序回滚、`file-busy`/`rename-partial` 文案与 extra 逐字不变；大小写-only 改名（realpath 同一实体）仍放行；旧布局逐个文件改名的分支与冲突文案不变。
2. **`planPaperDelete` 新增混合态拒绝**（`layout-conflict`，plan 未定义该错误码）。
   - 为什么：混合态下的 delete/rename/move 只能处理一半却报成功（t4-F2 三种可复现场景）。
   - 哪些既有语义未动：纯旧布局（只有平铺）与纯新布局（只有论文夹）路径完全不变；回收站 bundle 结构、manifest、非递归 rmdir、`.pdf` 最后移、错误文案与 extra 均不变。
   - 影响面：UI 的 `delete-plan`/`delete-paper`/`rename-paper` 路由也走 `planPaperDelete`/`renamePaper`，因此**同样**获得这两条加严（混合态 409、改名三路冲突）。这是有意的「一处实现、两处受益」，但确实是 UI 侧的行为变化：`lib/client.js` 的 `errText` 对新码没有专门文案，会回落到 `err.message`（中文可读提示），无空白/裸码。
3. **工具输出 schema 增补 `otherEntries`/`dirRemoved` 两个可选字段**（plan §1.3 的字段集合是闭集）。
   - 为什么：库层已算出这两个事实，工具层丢弃会违反「降级/残留必须如实提示」（t4-F3）。
   - 未动：既有字段的类型/必填性/枚举、`additionalProperties:false`、`render` 与 `summary` 同源。
4. **`approval-unavailable` 的触发面扩大一条**（plan §2.3 的 fail-closed 表未列「`ctx.get` 自身抛错」）。
   - 为什么：Cordis 对缺失服务返回 `undefined`，只有解析器坏掉才会抛；以前冒泡裸 Error，现在统一成带机器码的拒绝（t4-F4）。仍 fail-closed，不降级。
5. **`create_topic` 的同名普通文件从 404 改成 409 `target-exists`**（plan §3.2.3 写的是「与路由同构」，路由此时给 404）。
   - 为什么：同一类「名字被占用」在 `add_paper`/`planMovePaper` 都是 409 `target-exists`，工具内部错误码不一致会让 agent 难以解释（t3-low-1）。
   - 未动：真目录仍是幂等 `created:false`；符号链接仍是 `escape-rejected`；UI 的 `POST /api/library/topic` 路由**未改**（仍是 404，见 §4 残留 6）。
6. **`addPaper` 的临时名清理从空 catch 改为 best-effort 两段 + `console.warn`**（plan 只写「失败清理到零改动」，未规定清理自身失败的输出）。
   - 为什么：t3-low-2 指出空 catch 会把「收录成功但临时文件残留」完全吞掉；但此时 final 已就位、内容已校验，把它谎报成失败更糟。
   - 未动：成功语义、输出字段、summary 文案与 schema 全不变（没有擅自扩 schema，也没有在 summary 里加条件句）。

## 4. 未修 / 残留风险（如实登记）

1. **UI 文案未专门映射 `layout-conflict`**：`lib/client.js` 的 `errText` 无该分支，走 `err.message` 兜底（中文、可读）。本批 out of scope 不改 `lib/`；若要专门文案，需后续 UI 轮补一行 `case 'layout-conflict'`。
2. **混合态的解决路径只提示「在界面完成迁移」**：工具不提供任何「合并/清理平铺残留」的能力（那等于替用户执行迁移，红线）。用户若不想迁移，只能在文件系统里自行处理。
3. **`planTopicDelete`/`clearTopic` 未改动**：混合态论文会让专题「非空」而被拒；UI 的批量清空仍按既有逻辑只清论文夹那一半（既有语义，本轮不扩大改动面）。
4. **UI 路由继承的加严未单独加用例**：本轮用例走工具层（`planRenamePaper`/`planPaperDelete` 同一实现）；UI 路由的行为由 `npm test` 的既有 634 例回归网兜底（数字：641 tests / 605 pass / 0 fail / 36 skipped）。
5. **UI 的 `POST /api/library/topic` 仍返回 404**（同名普通文件）：本轮 inScope 不含 `src/host.ts`，只统一了 tool 侧 `create_topic` 的错误码；如要让界面也 409，需后续轮同步路由（1 行）。
6. **临时文件清理失败的可见性只到运行日志**：`console.warn` 不进入工具输出（不擅自扩 schema/summary 契约）；若将来要进 `summary`，需先更新 plan §1.5。
7. **`test/reader-ux-verification.test.mjs` 的 VC1 白名单已按 t3 建议收窄**：`presets/` → `presets/paper-reader/agent\.cordis\.yml$`（只允许本轮 persona 文件）。实测非空转：临时造 `presets/paper-reader/evil-probe.yml` 时 VC1 变红并点名该文件；`agent.cordis.yml` 仍放行。
8. t4 评审 §10 的其余残留（paper preset 审批 UI 真机可达性、`displayReason` 在 0.2.x 的展示、跨进程并发、`hasPdfMagic` 1KB 容忍、Windows/macOS 分支未实跑）本轮**未处理**，与 F1–F4 无关。

## 5. 验证

```bash
cd .worktrees/library-manage-tools
npm run typecheck                                  # exit 0
node --test test/library-manage-tools.test.mjs     # 62/62（A–G，0 skip）
npm test                                           # 644 tests / 608 pass / 0 fail / 36 skipped
node test/mutation-probe.mjs --only LM2            # LM20–LM25（LF 检出）：6/6 注入红 / 还原绿 / diff clean
```
