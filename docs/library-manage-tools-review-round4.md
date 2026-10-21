# t11 对抗复审：R-F3 祖先段冲突语义 + UI `layout-conflict` 文案（对 t10）

- 评审对象：`feat/library-manage-tools` @ `ff16490`（t10；父 `3cd17be` = t5 集成收尾）
- 上轮：t9 [docs/library-manage-tools-review-round3.md](library-manage-tools-review-round3.md)（pass，R-F3 登记为残留）
- 本轮范围：`create_topic` 的祖先段 404→409（tool + `POST /api/library/topic` 共用预检）+ `lib/client.js` 的 `layout-conflict` 文案
- 方法独立性：自造 25 条记录（13 条 tool + 10 条 route + 2 条 client 静态解析），并在**旧版本沙箱**（3cd17be 的两个 src 文件重编译）上跑同一套记录做逐条对照；另做 2 条变异证明探针非空转。没有采信 t10 的 test/ 结论。

## 0. 结论

**verdict: pass** —— 两项修复都成立，且我独立复现：

- **祖先段普通文件**：tool 与路由**都**从「404 `not-found`」变成 **409 `target-exists`**（`conflicts` 点名被占用的路径段，如 `A/B`），递归 sha256 快照**零改动**、普通文件原样保留（T1/T2/R1/R2）。
- **未放宽既有语义**（新旧逐条对照，§2）：符号链接祖先/目标仍 400 `escape-rejected`（库外零变化）；目标自身普通文件 tool 侧仍 409；正常多级创建与幂等 200/`created:false` 行为逐项相同；`.trash`/词法层不变。
- **UI 文案**：`errText` 新增且仅新增 `layout-conflict → delLayoutConflict` 一条映射；zh/en 字典都有可执行文案（迁移 + 「查看论文状态」）；其余既有映射 `removed=[]`、`changed=[]`（§3）。
- 全量 `npm run typecheck` exit 0；`npm test` **647 tests / 611 pass / 0 fail / 36 skipped**；本套件 **63/63**；t10 的测试 diff **只有新增**（`+23/+25/+20`，0 删除行）⇒ 既有断言零放宽。
- t10 改动面确为契约内的 8 个文件；`src/tools.ts`、`src/migrate.ts` 零改动；分支无 upstream（未 push）、HEAD 只被本分支包含。

两条 **low findings**（不阻塞，见 §5）：repair 文档 §5/§4.4 的 t6 数字未随 t10 更新；两处「有意变更但无回归用例」的路由行为（目标自身普通文件 404→409、悬空符号链接祖先 500→400）只有我的探针覆盖。

## 1. 基线数字（自跑）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run typecheck` | 0 | tsc 无输出 |
| `npm test` | 0 | `# tests 647` / `# pass 611` / `# fail 0` / `# skipped 36` |
| `node --test test/library-manage-tools.test.mjs` | 0 | `# tests 63` / `# pass 63` / `# skipped 0` |
| `node .probe/t11/probe-t10.mjs --assert`（新版本） | 0 | 25 条记录全部满足期望，`[assert] 全部通过` |
| `PROBE_REPO=.probe/t11/sandbox-old node .probe/t11/probe-t10.mjs --record` | 0 | 旧版本 25 条记录（用于 §2 对照） |
| `node .probe/t4/probes.mjs`（前几轮 38 条攻击回归） | 0 | 38/38 PASS（create_topic 改动没有打破既有加固） |
| `git diff --numstat 3cd17be..HEAD -- test/` | 0 | `23/0`、`25/0`、`20/0`（**新增行/删除行 = 0 删除**） |

## 2. 新旧逐条对照（旧 = `3cd17be` 的两个 src 文件重编译；新 = `ff16490`）

旧沙箱：`.probe/t11/sandbox-old`（复制工作树后仅覆盖 `src/library-manage.ts`、`src/host.ts` 为 `3cd17be` 版本，`tsc` 重建）。同一探针、同一临时库夹具跑两遍，只列**有差异**的 8 条：

| 记录 | 旧 | 新 | 判定 |
| --- | --- | --- | --- |
| `tool:T1-ancestor-file`（`ParentFile` 是普通文件，建 `ParentFile/Sub`） | 404 `not-found`；`[library_manage:not-found] 专题不存在：ParentFile` | **409 `target-exists`**；`conflicts:["ParentFile"]`；文案点名「ParentFile … 已存在同名文件（不是目录）」 | ✅ R-F3 修复目标 |
| `tool:T2-deep-ancestor-file`（`A/B` 是文件，建 `A/B/C`） | 404 `not-found`：`专题不存在：A/B` | **409 `target-exists`**；`conflicts:["A/B"]` | ✅ 深层同样 |
| `route:R1/R2`（同上两条走 HTTP 路由） | 404 `not-found`；body `["code","error"]` | **409 `target-exists`**；body 增 `conflicts` | ✅ 路由与 tool 同语义 |
| `route:R3-target-self-file`（目标自身是普通文件，路由） | 404 `not-found`（t6 只修了工具侧） | **409 `target-exists`**；`conflicts:["F"]` | ✅ 有意的统一（integration §9「祖先段/目标…统一 409」），但**无回归用例**（§5 T11-F2） |
| `tool:T5-ancestor-dangling-symlink`（祖先是指向不存在目标的链接） | 500 `add-partial`（被当成「不存在」→ mkdir 失败） | **400 `escape-rejected`** | ✅ 有意的收紧（repair §6.3 已登记），但**无回归用例**（§5 T11-F2） |
| `route:R5-ancestor-dangling-symlink` | 500 `internal` | **400 `escape-rejected`** | 同上 |
| `tool:T13-preflight-direct` | 预检 API 不存在（记录为 null） | `preflightCreateTopic` 只读、`{topic,exists:false}`、零写盘；冲突路径 `target-exists` | ✅ 新 API |
| `client:C*`（旧版本 client 无 `layout-conflict`） | 映射 7 条、无 `delLayoutConflict` | 映射 8 条；zh/en 文案齐全 | ✅ §3 |

**无差异（= 未放宽，逐条对照旧行为）**：`tool:T3`（目标自身普通文件 409）、`T4/T9`（符号链接祖先 400 escape，库外零变化）、`T6`（真目录祖先多级创建成功）、`T7`（已存在目录幂等、零改盘）、`T8`（目标自身符号链接 400）、`T10`（`.trash` 400 bad-name）、`T11`（真目录祖先 + 目标文件 409）、`T12`（create_topic 不请求审批，requests=0）；`route:R4/R6/R7/R8/R9/R10`（符号链接 400、成功 200 `{ok,topic}`、幂等 200 且零改盘、目标链接 400、词法 4xx、`.trash` 400）。全部记录的 `snapChanged=[]`（拒绝对话零副作用）与 `outsideChanged=[]`（库外零变化）。

## 3. `layout-conflict` 文案（代码 + 独立静态解析）

我的解析脚本（不依赖实现方 U4）从 `lib/client.js` 提取 `errText` 的 `case → t('key')` 映射和 zh/en 两个字典块：

```
layoutConflict: ["layout-conflict", "delLayoutConflict"]      # errText 有专门分支
missingZh: []   missingEn: []                                 # errText 用到的每个 key 在 zh/en 都存在
zhMsg: 该文献同时存在论文文件夹与旧平铺文件，请先在「设置 → 论文伴读 → 查看论文状态」完成迁移后再操作
enMsg: This paper has both a paper folder and legacy flat files — finish the migration in Settings → Paper Reading → View paper status first
与旧版本（git show 3cd17be:lib/client.js）对照：added = [["layout-conflict","delLayoutConflict"]]，removed = []，changed = []
```

⇒ 只新增一条映射，既有 `session-running / translation-busy / busy / file-busy / session-unknown / target-exists / topic-not-empty` 七条逐字未动（`git diff 3cd17be..HEAD -- lib/client.js` 也只有 +5 行）。

## 4. 变异（证明探针非空转）

在 `.probe/t11/sandbox-mut`（工作树副本）里注入、跑我的探针、再还原：

| 变异 | 注入 | 探针 | 还原 |
| --- | --- | --- | --- |
| MUT1 | `preflightCreateTopic` 的祖先冲突分支 `if (kind === 'conflict')` → `if (false)` | **exit 1 红**：T1 实际 `not-found`（探针期望 `target-exists`） | 还原 + 重建 → **exit 0 绿**；`git hash-object` 与 `HEAD:src/library-manage.ts` 一致（`a033106a…`） |
| MUT2 | client `case 'layout-conflict'` → `case 'x-layout-conflict'` | **exit 1 红**：`layoutConflict` 为 null | 还原 → **exit 0 绿**；与 `HEAD:lib/client.js` 一致（`e03f0aeccd…`） |

## 5. Findings

| id | severity | 位置 | 问题 | requiredFix |
| --- | --- | --- | --- | --- |
| T11-F1 | low | `docs/library-manage-tools-repair.md:87-88`（§5 验证块）、`:74`（§4.4） | t10 新增 3 例后，文档里 t6 时点的数字没有更新：§5 仍写 `62/62`、`644 tests / 608 pass`；§4.4 仍写「全量 644 / 608，其中本套件 62 例」。同文件 §6.4 与 integration §4 已写 **63/63、647/611/0/36** ⇒ 同一文档内两套数字，读者按 §5 复跑会看到不一致（这正是 t9 R-F2 那类文档漂移的复发）。 | 给 §5/§4.4 加「（t6 时点；t10 后为 63/63、647 tests / 611 pass）」一句，或直接把这两处更新为现值。非阻塞。 |
| T11-F2 | low | `test/integration-upstream-merge.test.mjs` P1b（t10 新增的路由用例） | t10 有两条**有意的路由行为变更**没有被回归用例覆盖，只有我的探针覆盖：① 目标自身普通文件 `POST /api/library/topic` 404→409（工具侧 G6 早就有，路由侧没有）；② 祖先段**悬空**符号链接 500 `internal`→400 `escape-rejected`（P1b 只测了指向库外真实目录的链接）。实现本身正确（我的 R3/R5 记录），但将来改动容易回退。 | 在 P1b 里补两条断言：目标自身同名普通文件 → 409 `target-exists` 且 `lstat.isFile()` 不变；祖先为悬空链接 → 400 `escape-rejected` 且零副作用。非阻塞。 |

## 6. 残留风险与未覆盖面

1. **route 与 tool 只共用预检，不共用 mkdir**：路由 `preflight` + `mkdir`，工具 `createTopic` = `preflight` + `assertInside` + `mkdir`；核心判定只有一份（这正是本次修复的关键），但两条写路径仍有少量重复，将来改 mkdir 语义时需同时改两处（建议后续把路由也改成 `createTopic`，但会改变 `withInflight` 与响应整形，属行为调整，本轮不宜扩）。
2. **部署未做**：当前 GUI 跑的是 t5 时点构建；t10 的 `preflightCreateTopic` / `delLayoutConflict` 尚未进入安装目录（repair §5 注已写明）。live 验收需要用户显式确认部署，不属评审动作。
3. **`conflicts` 额外字段**：路由错误 body 从 `{error,code}` 变成 `{error,code,conflicts}`；前端 `errText` 只读 `code/message/papers/entries`，不受影响；若有外部脚本按「body 键集合」断言则需注意（仓库内无此断言，`npm test` 全绿）。
4. **悬空链接收紧**：500→400 是**更准确**的拒绝（零副作用），但错误码从 `internal` 变成 `escape-rejected`，若有调用方按 500 重试逻辑处理会变；文档已登记（repair §6.3）。
5. **前几轮残留不变**：混合态异内容须用户在迁移冲突里定夺；`clearTopic` 半清；preset 审批 UI 真机可达性；`displayReason` 0.2.x；跨进程并发；Windows/macOS 分支。
6. **未覆盖**：`POST /api/library/topic` 的并发/锁行为（`withInflight(topicKey(name))` 只锁同一路径，不同路径共享祖先不互斥——与改前一致）；`preflightCreateTopic` 的 EACCES/IO 子树（lstat 抛非 ENOENT 会当「不存在」，随后 mkdir 报 500——与改前一致）。

## 7. 证据文件（可复跑）

| 文件 | 内容 |
| --- | --- |
| `.probe/t11/probe-t10.mjs` | 25 条独立探针（tool 13 / route 10 / client 2），`--assert` 断言、`--record` 记录 |
| `.probe/t11/record-new.log` / `record-old.log` | 新旧版本逐条记录（§2 对照的来源） |
| `.probe/t11/sandbox-old/` | 旧版本重编译沙箱（仅覆盖 3cd17be 的两个 src 文件） |
| `.probe/t11/mut1.log` / `mut1-restored.log` / `mut2.log` / `mut2-restored.log` | 两条变异的红/绿证据 |
| `.probe/t11/baseline.log` | typecheck + npm test 全量输出（647/611/0/36） |
