# t9 聚焦复审（第三轮）：t8 的 LM04 锚点修复与 repair 文档数字

- 评审对象：`feat/library-manage-tools` @ `2f5e14f`（t8；父 `9adf411` = t7 评审提交）
- 上一轮：t7 [docs/library-manage-tools-review-round2.md](library-manage-tools-review-round2.md)（verdict=needs_revision；R-F1 LM04 锚点漂移 / R-F2 文档数字 / R-F3 继承的 404 不一致）
- 本轮范围：`test/mutation-probe.mjs` 的 LM04 锚点 + `docs/library-manage-tools-repair.md` 的数字与残留登记；**不重开** src 功能评审（src 与 t7 评审时逐字节相同，见 §3）
- 环境：Node v22.22.1；本工作树为 LF 检出（`test/mutation-probe.mjs`、`src/tools.ts` 均无 CR）

## 0. 结论

**verdict: pass** —— R-F1（LM04 锚点）与 R-F2（文档数字）都已按 t7 的 requiredFix 修好，且我用与源码**逐字节对照**+ 实跑验证；R-F3 按契约如实登记为残留（不修是正确的范围控制）；t8 改动面只有 2 个文件，src 零改动、既有断言零放宽。

- LM04：`test/mutation-probe.mjs:333` 的 `from` 与 `src/tools.ts:536` **逐字节相等**（见 §1），锚点在源码命中恰好 1 次；`--only LM04` = 注入=1 / 还原=0 / diff=clean。
- 全组：`node test/mutation-probe.mjs --only LM` **25/25 通过**（exit 0），输出里 `锚点命中 0 次` 出现 **0** 次。
- 文档数字与实测一致（62 例套件、644/608/0/36、既有 582 例）；陈旧数字（641/605/634/52→59/「7 例」）已 grep 确认清零。
- `git diff 9adf411..2f5e14f --name-only` 只有 `test/mutation-probe.mjs` 与 `docs/library-manage-tools-repair.md`；`src/ lib/ presets/` 空；`src/tools.ts`/`src/library-manage.ts`/`src/library-guards.ts` 的 blob 与 `89a1186`（t7 评审的 HEAD）**完全相同**。

## 1. LM04 锚点与源码逐字节对照

| 侧 | 位置 | 内容 |
| --- | --- | --- |
| 变异表 `from` | `test/mutation-probe.mjs:333` | `    svc = typeof get === 'function' ? (get.call(ctx, 'approval') as ApprovalAsk \| undefined) : undefined` |
| 源码 | `src/tools.ts:536` | 同一行（4 空格缩进，无 `const`） |
| 变异表 `to` | `test/mutation-probe.mjs:334` | `    svc = (typeof get === 'function' ? … : undefined) ?? ({ request: async () => 'allowed-once' } as ApprovalAsk)` |

机器核对（我写的对照脚本，用 JS 语义求值 `from` 字面量后与源码该行做 `Buffer.equals`）：

```
source line      : 536
source content   : "    svc = typeof get === 'function' ? (get.call(ctx, 'approval') as ApprovalAsk | undefined) : undefined"
anchor content   : "    svc = typeof get === 'function' ? (get.call(ctx, 'approval') as ApprovalAsk | undefined) : undefined"
byte-equal       : true
anchor hits in src: 1
CRLF in mutation-probe: false | CRLF in src/tools.ts: false
```

`to` 的语义与 t7 建议一致：`svc` 恒为「总是允许」的伪造服务 ⇒ 无审批服务时 fail open ⇒ B5 必红（判定器有效）。

## 2. 实跑证据（命令 / 退出码 / 结果）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `cd .worktrees/library-manage-tools && npm run typecheck` | 0 | tsc 无输出 |
| `cd .worktrees/library-manage-tools && node test/mutation-probe.mjs --only LM04` | 0 | `OK LM04-no-service-continues 注入=1 还原=0 diff=clean`；`# 变异验证：1/1 通过` |
| `cd .worktrees/library-manage-tools && node test/mutation-probe.mjs --only LM` | 0 | **25/25**：`OK` 行 25、`FAIL` 行 0、`锚点命中 0 次` 0 次（LM01–LM25） |
| `cd .worktrees/library-manage-tools && npm test` | 0 | `# tests 644` / `# pass 608` / `# fail 0` / `# skipped 36` |
| `node --test test/library-manage-tools.test.mjs` | 0 | `# tests 62` / `# pass 62` / `# skipped 0` |
| `node .probe/t4/probes.mjs`（回归复核，src 未变） | 0 | 38/38 PASS（t7 的 A–E + R1–R13 在新 tip 上仍全绿） |

## 3. t8 改动面 / 断言零放宽

- `git diff --stat 9adf411..2f5e14f`：`docs/library-manage-tools-repair.md`（+9/−5）、`test/mutation-probe.mjs`（+4/−2，其中 2 行是注释）。
- `git diff 9adf411..2f5e14f -- src/ lib/ presets/`：**空**。
- `git rev-parse`：`src/tools.ts` = `251d483dfbc9…`、`src/library-manage.ts` = `d828b881a257…`、`src/library-guards.ts` = `5a324681eb17…`，与 `89a1186`（t7 评审的 HEAD）逐字节相同 ⇒ 修复没有夹带行为改动。
- `git diff 9adf411..2f5e14f -- test/library-manage-tools.test.mjs`：0 行（契约用例断言零放宽）；mutation-probe 的 diff 只有 LM04 一个 hunk（其余 24 条靶子逐字未动）。
- 工作树 `git status --porcelain` 为空。

## 4. docs 数字与实测对照

| 位置 | 现值 | 实测 | 一致 |
| --- | --- | --- | --- |
| `docs/library-manage-tools-repair.md:22` | 新增 10 例（G 组，52 → 62） | `test/library-manage-tools.test.mjs` 62 例（`grep -c "^test("` = 62，`# tests 62`） | ✅ |
| `:74` | 全量 644 tests / 608 pass / 0 fail / 36 skipped，本套件 62 ⇒ 既有 582 | `npm test` = 644/608/0/36；644−62=582 | ✅ |
| `:89`（§5 验证块） | `npm test # 644 / 608 / 0 / 36`；新增 `--only LM04` 与 `--only LM 25/25` | 同上；两条变异命令均 exit 0 | ✅ |
| 陈旧数字 | `641` / `605` / `634` / `52 → 59` / 「新增 7 例」 | `grep` 在 repair 文档中 **0 命中** | ✅ |

## 5. R-F3 的残留登记（按契约不修）

`docs/library-manage-tools-repair.md:75` 的残留 5 已改写为「`create_topic` 的 404 残留面（t7 R-F3，本轮明确不修）」，并明确两处仍是 404：
- tool 侧：**祖先段**是普通文件（`create_topic('A/B')` 且 `A` 是文件）走既有 `resolveTopicDir` ⇒ 404 `not-found`；
- UI 侧：`POST /api/library/topic` 路由整体未改，目标自身/祖先段是文件都仍 404。

如实登记、范围控制正确（t8 的 inScope 不含 `src/host.ts`），不需要在 t8 修。

## 6. 残留风险与未覆盖面（pass 仍须知道）

1. **R-F3 仍在**：同一类「名字被占用」在祖先段仍是 404（零副作用，登记在 repair §4.5）。
2. **t7 报告 §6 的残留全部未变**（本轮 src 未动）：混合态异内容残留须用户在迁移冲突里定夺；`clearTopic` 仍只清论文夹一半；`lib/client.js` 无 `layout-conflict` 专门文案；UI `POST /api/library/topic` 仍 404；preset 审批 UI 真机可达性 / `displayReason` 0.2.x / 跨进程并发 / Windows-macOS 分支未实跑。
3. **本轮范围之外未重跑**：t7 的 10 条自造变异（`docs/review/mutations.mjs`）未在 t8 tip 上重跑——但 src blob 与 t7 评审时逐字节相同，t7 结论继续成立；本轮另跑了 38 条探针回归（全绿）与实现方 LM 全组（25/25）。
4. **变异脚本的维护性风险**：锚点是「源码字符串逐字节匹配」，任何重构缩进/改名的轮次都可能再次造成漂移；本轮把「`--only LM` 全组」写进了 repair §5，建议后续每轮改动 `src/tools.ts` 后至少跑一次全组（这是 t8 已写明的流程，但仍是人工约定）。

## 7. 证据文件

| 文件 | 内容 |
| --- | --- |
| `.probe/t4/r3-typecheck.log` | typecheck exit 0 |
| `.probe/t4/r3-lm04.log` | `--only LM04` 1/1（注入=1 / 还原=0 / diff=clean） |
| `.probe/t4/r3-lm-all.log` | `--only LM` 25/25，0 个锚点命中 0 次 |
| `.probe/t4/r3-npm-test.log` | 全量 644/608/0/36 |
| `.probe/t4/r3-probes.log` | 38 条自造探针回归（38/38 PASS） |
