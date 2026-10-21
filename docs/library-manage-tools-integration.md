# 集成收尾报告：agent 文献整理工具 `library_manage`（t5）

- 分支：`feat/library-manage-tools`（基线 `feat/migrate-prompt@57309b2`）
- 当前 tip：`2f5e14f`（文档提交见 §7；**未 push、未合并主分支、未部署到 `~/.dsh`**）
- 工作树：`.worktrees/library-manage-tools`（`git status` 干净）
- 契约：[library-manage-tools-plan.md](library-manage-tools-plan.md)（冻结于 `d37fe49`；偏差登记见
  [library-manage-tools-repair.md](library-manage-tools-repair.md) §3）
- 结论：**实现 + 修复 + 独立验证 + 三轮对抗评审全部完成，最终 verdict=pass**（见 §4 证据链）。

---

## 1. 交付概述

给对话侧 agent 增加**一个**新工具 `library_manage`（7 个 action），让 agent 能真正整理文献库：
建专题、把本地 PDF 收进库、给论文/专题改名、跨专题移动论文、删除论文/空专题（进回收站可恢复）。

- **破坏性动作必须经 DSH 用户审批**（`ctx.approval.request`）：`delete_paper` / `delete_topic` /
  `rename_paper` / `rename_topic` / `move_paper` 只有拿到 `'allowed-once'` 才动手；
  rejected / cancelled / unavailable 一律**零副作用**并返回带机器码的错误。
- **不存在「模型自填确认」**：工具参数里没有 `confirm` / `token` / `approve` 之类字段
  （动态 import 实测参数键集合 = `action,name,new_name,source_path,to_topic,topic`）；
  审批通道不可用（无服务 / 无 agent / `request()` 抛错 / 闭集外返回值 / `ctx.get` 自身抛错）
  一律 **fail closed**，绝不降级为直接执行。
- **迁移执行仍只在界面**（红线）：工具的 action 枚举没有 `migrate*`，工具层只 import
  `planMigration` / `formatMigrationReport`；`src/migrate.ts` 与基线零 diff。旧布局文献拒绝被
  `move_paper` 移动；「论文夹 + 同 stem 平铺残留」的混合态被 `layout-conflict` 拒绝并提示先在界面迁移。

改动面（`git diff --stat 57309b2..2f5e14f`，**不含本报告与 review-round3**）：18 个文件、+5935/−126；
其中实现 5 个 `src/` 文件（新增 `src/library-guards.ts`）、测试 3 个（新增
`test/library-manage-tools.test.mjs` 62 例 + 变异靶子 LM01–LM25）、文档 7 个
（plan/verification/review/review-round2/repair/probes/mutations）、
`presets/paper-reader/agent.cordis.yml` 与两份 README。
之后的 `review-round3` 与本报告都是 docs-only 追加（各 1 个文件）。

## 2. 工具清单（对模型可见的契约）

```
library_manage(action, topic, name?, new_name?, to_topic?, source_path?)
```

| action | 必填 | 审批 | 作用 |
| --- | --- | --- | --- |
| `create_topic` | `topic` | 否 | 建专题（多级、幂等：已存在返回 `created:false`；同名普通文件 409 `target-exists`） |
| `add_paper` | `topic`,`source_path`（`name` 可省） | 否 | 把本地 PDF 收进库：源 realpath / 必须常规文件 / 非空 / `%PDF-` 头；目标冲突 409；`linkSync` 原子落盘不覆盖，失败清理到零改动 |
| `move_paper` | `topic`,`name`,`to_topic` | **是** | 跨专题移动：整目录 rename（全部产物随行）、旧布局拒绝、目标冲突/自子树拒绝、后置校验失败回滚 |
| `rename_paper` | `topic`,`name`,`new_name` | **是** | 改论文名：目录 + 目录内文件两段式，失败逆序回滚；目标三路冲突（论文夹/平铺/孤儿产物）在**审批前**拒绝 |
| `rename_topic` | `topic`,`new_name` | **是** | 改专题名/移动专题（`new_name` 可多级）；父目录必须存在、不能移进自己子树 |
| `delete_paper` | `topic`,`name` | **是** | 删除论文 → 回收站（含隐藏条目与全部产物），manifest 可手工恢复 |
| `delete_topic` | `topic` | **是** | 只删**空**专题（非空 409；隐藏条目进回收站）。批量清空只留在界面 |

输出（`output.schema` 闭集，`additionalProperties:false`）：`ok` / `action` / `topic` / `name` /
`new_name` / `to_topic` / `created` / `bytes` / `files` / `trashDir`（nullable）/ `trashRel`（nullable）/
`approval`（`not-required` | `allowed-once`）/ `detachedSessions` / `summary` /
`otherEntries`（move 的非产物条目）/ `dirRemoved`（delete 的目录是否删净）。
`render` 与 `summary` 同源（zh 默认，`DPR_LIBRARY_MANAGE_LANG=en` 切 en）。

工具描述（模型可见）与 preset persona 都写明：删除/改名/移动要等用户在审批 UI 点允许、正文「确认」
不算、拒绝后如实说「未做任何改动」、不确定先问、不要批量动用户没要求的条目、迁移只能在界面。

## 3. 审批门语义（冻结）

顺序（每一步都在写盘之前）：参数 → 词法 → 只读预检（存在性/冲突/混合态）→ 在途锁 →
会话/翻译前置 → **审批** → 执行。

| 审批结果 | 工具返回 | 库内副作用 |
| --- | --- | --- |
| `allowed-once` | 继续执行 | 按 action 契约 |
| `rejected` | 403 `approval-rejected`：`用户拒绝了本次<动作>；未做任何改动` | **零** |
| `cancelled` | 409 `approval-cancelled`：`审批被取消；未做任何改动` | **零** |
| `unavailable` | 503 `approval-unavailable`：`审批通道不可用…；未做任何改动` | **零** |

fail-closed 边界（均在调用 `request()` 之前判定，或统一映射成 `unavailable`）：`ctx.get('approval')`
缺失（headless/未装配）、`ctx.get` 自身抛错、`exec.agent` 缺失、`request()` reject（无 open turn /
审计失败）、返回值不在闭集、`signal.aborted`（批准后再复查一次）。审批请求参数：
`{ agent: exec.agent, toolName: 'library_manage', callId: exec.callId, reason, displayReason, signal }`；
`reason` 是**双语单串**，点名目标与「将移入回收站的文件数/路径线索」以及「仅本次有效 / one-shot」。
`approval` 服务**不进** `inject`（headless profile 没有它，加进去会让插件加载失败）——运行时
`ctx.get('approval')` 可选读取，与官方 `dsh-tool-fs` / `dsh-sandbox` 同取向。

「零副作用」的判据是**递归 sha256 快照（含 `.trash`）**：非 allowed-once 时逐字节不变（测试 B1–B3
覆盖 5 action × 3 态；G5 覆盖 `ctx.get` 抛错；另有 A5 式「审批挂起期间 abort」由评审探针覆盖）。

## 4. 证据链（实现 → 验证 → 评审 → 修复 → 复审）

| 阶段 | 产物 | 结论 |
| --- | --- | --- |
| 契约冻结 | [plan](library-manage-tools-plan.md)（`d37fe49`） | 工具面 / 审批门 / 拒绝码 / 测试计划 |
| 实现 | `af8d87d` | 7 action、审批门、guards 下沉、52 例初版测试 |
| 独立验证 | [verification](library-manage-tools-verification.md)（t3，3 个 docs 提交） | 6/6 acceptance 通过；独立复现混合布局缺陷（§9 F3） |
| 对抗评审 r1 | [review](library-manage-tools-review.md)（t4，`0f09dde`） | **needs_revision**：F1（rename 遮蔽，high）/F2（混合态半成功）/F3/F4 |
| 修复 r2 | `89a1186` + [repair](library-manage-tools-repair.md) | F1–F4 与 t3 两条 low 全修；新增 G 组 10 例、LM21–LM25 |
| 评审 r2 | [review-round2](library-manage-tools-review-round2.md)（t7，`9adf411`） | F1–F4 复核通过；**needs_revision** 仅因 R-F1（LM04 锚点漂移）/R-F2（文档数字）/R-F3（登记残留） |
| 修复 r3 | `2f5e14f` | LM04 锚点逐字节对齐（`--only LM` 25/25）、repair 文档数字校正 |
| 评审 r3 | [review-round3](library-manage-tools-review-round3.md)（t9，`07da33b`） | **verdict=pass**（R-F3 按契约不修、登记正确） |

最终自测（**t10 后复跑**，见 §5/§9；t5 首次集成时为 644/608/0/36）：

- `npm run typecheck` → exit 0
- `npm test` → **647 tests / 611 pass / 0 fail / 36 skipped**（`pretest` 自动 build；skip 全为既有平台/环境跳过）
- `node --input-type=module -e "import dist/index.js; apply(假 ctx)"` → 注册 **8** 个工具
  （`list_papers, transcribe_pdf, search_paper, study_progress, study_update, migration_report,
  migration_prompt_choice, library_manage`），启动日志行同样列出 `library_manage`
- `node test/mutation-probe.mjs --only LM` → **25/25**（注入红 / 还原绿 / diff clean，无锚点漂移）
- 独立验证复跑：`node --test test/library-manage-tools.test.mjs` → **63/63**（0 skip；t10 新增 G7）
- 红线：`git diff 57309b2..HEAD -- src/migrate.ts` 为空；工具层 import 只含只读迁移能力

## 5. 交付面核对（t5 实测）

- `git branch --show-current` = `feat/library-manage-tools`；`HEAD` 只被该分支包含（未合并主分支）。
- 无 upstream、`refs/remotes` 里没有本分支（**未 push**）。
- t5 时点：`~/.dsh/profiles/web/node_modules/@ggboy123/dsh-paper-reader/dist/index.js` 中 `library_manage`
  命中 0 次、安装目录 mtime 仍为 2026-10-17（**当时未部署**本分支产物）。
  > 注（t10 补记）：t10 之前**用户**已把本分支安装到当前 GUI 做 live 复现（部署动作由用户执行）；
  > t10 的改动（`preflightCreateTopic` / `delLayoutConflict`）尚未部署——安装目录里
  > `dist/library-manage.js` 无 `preflightCreateTopic`、`lib/client.js` 无 `delLayoutConflict`。
- `git status --porcelain` 为空（本报告的文档提交完成后）。
- 基线以来的提交（`git log --oneline 57309b2..HEAD`；截至 `review-round3` 共 **10** 个，
  本报告的 docs-only 提交是第 **11** 个）：
  `d37fe49` 契约 → `af8d87d` 实现 → `0f09dde` 评审 r1 → `c55c4d3`/`59dc417`/`044b7b5` 独立验证 →
  `89a1186` 修复 r2 → `9adf411` 评审 r2 → `2f5e14f` 修复 r3 → `07da33b` 评审 r3（pass）→ 本报告。

## 6. 已知限制与残留风险（不阻塞集成，如实登记）

1. **paper preset 会话里审批 UI 的真机可达性未验证**：静态证据链成立（preset 未改审批策略、伴读会话是
   普通 session、与官方 `serviceAsk` 同通道）；若不可达，行为是全部 `approval-unavailable`（fail-closed，
   不是绕过）——可用性风险，不是安全风险。验证步骤见 plan §2.6 / review §10.1。
2. **`displayReason` 在 0.2.x 的展示未验证**（devDep 0.1.5 无该字段）：实现只把它作为可选字段透传，
   判定完全不依赖它。
3. ~~**R-F3（继承的 404 不一致）**~~ → **已由 t10 修复**：`create_topic` 的祖先段/目标为普通文件时，
   tool 与 `POST /api/library/topic` 路由**共用** `preflightCreateTopic` 并统一返回 409 `target-exists`
   （以前 tool 的祖先段与 UI 路由是 404）；符号链接仍 `escape-rejected`、真目录仍幂等 200。详见
   [repair §6](library-manage-tools-repair.md) 与 §9；测试 G7（工具）/P1b（路由）。
4. **UI 侧同样继承的加严**：`delete-plan`/`delete-paper`/`rename-paper` 路由共用同一实现，
   混合态会 409 `layout-conflict`；t10 起 `lib/client.js` 的 `errText` 有该码的 **zh/en 专门文案**
   （提示去「设置 → 论文伴读 → 查看论文状态」完成迁移），不再回落到 `err.message`。
   UI 的批量清空仍按既有逻辑只清论文夹那一半（既有语义）。
5. **跨进程并发不在支持范围**：在途锁是进程内 `Set`（与插件既有写路由同口径）；两个 dsh 进程指向
   同一 dataDir 时不同步。
6. **平台未实跑**：Windows/macOS 的大小写不敏感与 EBUSY/EPERM 分支只做静态审查；用例在 Linux 实跑。
7. **`hasPdfMagic` 只在前 1KB 找 `%PDF-`**（按方案「允许前置垃圾」实现）：极端伪 PDF 会被收录后转录失败。

## 7. 本轮（t5）改动

只改文档（`docs/`），零实现/测试改动：

- 新增本文件 `docs/library-manage-tools-integration.md`
- 给 `verification` / `review` / `review-round2` / `plan` 各加一段**状态更新/偏差登记**横幅
  （不改原文结论，只指向最终 verdict 与偏差登记位置）
- `README.md` / `README_EN.md` / preset persona 本轮复核后**无需修改**：其中的 7 个 action、
  审批语义（删除/改名/移动需审批、正文确认不算、迁移只在界面）、非空专题逐篇删除、
  旧布局不可移动等说法与实现一致（校验见 §4/§5）。

## 8. 如何装到当前 GUI（手动；需用户显式确认，本任务**未执行**）

> ⚠️ **这一步是部署动作**：本分支尚未发布 npm，把工作树产物覆盖到当前 GUI 的插件目录会影响你正在用的
> 环境。按团队规则，部署必须由**用户显式确认**后执行；本报告只给步骤，不代做。建议先备份，出问题可回滚。

安装目录（实测存在）：`~/.dsh/profiles/web/node_modules/@ggboy123/dsh-paper-reader/`
（若是 pnpm 软链，先 `readlink -f` 找到真实目录再操作。）

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/library-manage-tools
npm run build                      # 产出最新 dist/
SRC="$PWD"
DST="$(readlink -f "$HOME/.dsh/profiles/web/node_modules/@ggboy123/dsh-paper-reader")"
# 0) 备份（可回滚）
cp -a "$DST" "$DST.bak-$(date +%Y%m%d%H%M%S)"
# 1) 复制产物（保留目录结构；不要复制 node_modules/ 与 .git/）
rm -rf "$DST/dist"; cp -a "$SRC/dist" "$DST/dist"
cp -a "$SRC/lib" "$SRC/presets" "$SRC/reader" "$DST/"
cp -a "$SRC/package.json" "$SRC/cordis.patch.yml" "$DST/"
cp -a "$SRC/README.md" "$SRC/README_EN.md" "$DST/"
```

2) 重启 dsh profile（或重启官方桌面端）；浏览器/桌面端强刷一次（Cmd+Shift+R）。
3) 验收：
   - 启动日志应出现：`[dsh-paper-reader] registered tools: …, library_manage`
   - 打开一篇论文的伴读会话，让模型调用「删除这篇论文」：应弹出**审批卡**（含目标名与 one-shot 提示）；
     点「拒绝」→ 工具返回 `approval-rejected` 且库内文件逐字节不变；再点「允许」→ 文献进回收站。
   - 反例（无审批 answerer 的会话）：同一动作应得 `approval-unavailable`，库零变化。
4) 回滚：`rm -rf "$DST" && mv "$DST.bak-<时间戳>" "$DST"`，重启。


## 9. t10 后续修复：R-F3（404 → 409）+ UI `layout-conflict` 文案

本文件 §6 曾把 R-F3 记为「不在本批修」；后续任务 t10 已修复（实现细节与「哪些既有语义未动」见
[library-manage-tools-repair.md](library-manage-tools-repair.md) §6）：

- **共用预检**：`src/library-manage.ts` 新增 `preflightCreateTopic(dataDir, raw)`；`createTopic` 与
  `src/host.ts` 的 `POST /api/library/topic` 都改用它 ⇒ 祖先段/目标是普通文件时统一 **409
  `target-exists`**（以前是 404 `not-found`），符号链接仍 `escape-rejected`，真目录仍幂等 200，
  失败零副作用。
- **UI 文案**：`lib/client.js` 的 `errText` 新增 `case 'layout-conflict'`，zh/en 字典各加
  `delLayoutConflict`（说明「论文文件夹与旧平铺文件并存，请先在 设置 → 论文伴读 → 查看论文状态
  完成迁移」）；其余映射与文案未动。
- **测试**：`test/library-manage-tools.test.mjs` G7（工具）、`test/integration-upstream-merge.test.mjs`
  P1b（路由）、`test/reader-ux-t8.test.mjs` U4（client 文案）⇒ 全量 **647 tests / 611 pass / 0 fail /
  36 skipped**，本套件 **63/63**。
- **红线不变**：未引入迁移执行工具、未改审批门语义（`src/tools.ts` 零改动）、未放宽既有断言、
  未 push/部署（t10 的改动只在本工作树；当前 GUI 里跑的是 t5 时点的构建，见 §5 注）。
