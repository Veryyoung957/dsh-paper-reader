# t3 独立验证记录

工作树：`.worktrees/migrate-ui-report`，验证只读产品代码；证据目录 `.probe/` 未纳入 git。

## 1. 原始命令与输出

命令 `npm run typecheck`：退出码 0（`tsc -p tsconfig.json --noEmit`）。
命令 `npm run build`：退出码 0（`tsc -p tsconfig.json`）。
命令 `npm test`：退出码 0；原始日志见 `.probe/t3-npm-test.log`。尾部原文：

```
1..578
# tests 578
# suites 0
# pass 542
# fail 0
# cancelled 0
# skipped 36
# todo 0
```

此前基线记录为 569/542/0/27；本次确切统计为 578/542/0/36。逐项跳过原文见 `.probe/t3-skips.log`（36 行）。逐条理由均为环境/样本条件（样本 PDF 缺失、未设置 DPR_SAMPLE_PDF、本地 MinerU 不可达、用户库缺少真实产物/TD-MPC2 等），与本轮改动无关。`git diff test/` 无新增 `skip`/`only` 构造，`test/paper-status.test.mjs` 无 `skip`；node:test 跳过必须显式构造。因此 t2 验收第 9 条“t.skip 零新增”**成立**。27 与 36 的差额是不同时间点真实样本/服务可用性差异，不是本轮新增跳过。

命令 `node test/mutation-probe.mjs`：原始管道退出码为 1（脚本内部报告 `变异验证：58/76 通过`，未通过 18 个锚点命中 0 次，完整原始输出见 `.probe/t3-mutation.log`）。其中 M1–M8、N1–N11 均输出 `OK`。18 条失败全部是“锚点命中 0 次”，没有“变异存活”。根因是共享配置 `.git/config` 的 `core.autocrlf=true`（配置 mtime 早于本会话），工作树为 CRLF，而 blob 为 LF：`git show HEAD:src/migrate.ts | grep -c $'\r'` 为 0，工作树 `src/migrate.ts` 有 810 行 CR（另 `src/library.ts` 534、`src/library-manage.ts` 1251、`src/theme-config.ts` 141、`reader/index.html` 2560）。失败靶子集中在这些文件；其中 `src/migrate.ts`、`reader/index.html`、`src/theme-config.ts` 本轮未改动。脚本自身与 HANDOVER 都要求在 LF 检出运行。因此该退出 1 是环境性 CRLF 锚点不命中，**不是本轮回归**，不作为 blocker。

## 2. 真实 Chromium 尝试

命令：`node .probe/migrate-ui-evidence/browser-probe.mjs`，退出码 0；使用 `/home/vr/.local/lib/node_modules/playwright` 的 Chromium。脚本注入 stub 状态面板并保存：

- `.probe/migrate-ui-evidence/panel-900.png`
- `.probe/migrate-ui-evidence/panel-420.png`
- `.probe/migrate-ui-evidence/browser-probe.log`

两种宽度输出均为 `overflow:false`，文字同时出现“翻译 / MinerU 转录 / 迁移”，状态包含 `✓ / — / ?`；危险“确认迁移”与普通“取消”分别为 `danger`/`normal`；打开后焦点为 `panel`，Escape 后焦点为 `open`。这是 stub DOM 的浏览器证据，不是 dsh 宿主内实际挂载。

## 3. 验收逐条核对（证据/反例/无法证实）

以下按 t2 需求的 P1–P23 记录（需求文档将其拆为 23 个可检查点）：

- P1–P11：**无法证实**。全量测试包含 paper-status 状态分类、同源扫描等用例并通过，但未独立运行 HTTP 临时库探针逐项复现迁移提示端点的全部夹具。
- P12/P13：**证据**：`npm test` 中 `read-only pagination...missing root do not mkdir`、`root/subtree permission faults...` 通过（测试 382/383）。
- P14/P15：**无法证实**，未另造空库/孤儿库端点探针。
- P16/P18/P19/P20：**证据**：测试 382/383 通过；另未修改真实库。完整环境只读性未做权限挂载复现。
- P17：**无法证实**，未在浏览器宿主跑 choice 路由。
- P21：**证据**：测试 469 `F1 i18n` 通过；静态键集合测试通过。
- P22：**证据**：`lib/client.js` 2061–2159 有 `paper-status-panel`、三轴 cell、GET 分页；执行按钮仅在 `certain===true && migratable>0` 时启用，并 POST confirm。Chromium stub 观察了视觉/键盘要求；真实宿主挂载无法证实。
- P23：**无法证实**，未独立执行改名后 localStorage 键迁移探针。
- 删除契约：**证据**：`reader-ux.test.mjs:921–926` 保留并实际通过 F2；`reader-ux-verification.test.mjs:1745–1755` 保留 delete-plan、无原生 confirm/prompt、可恢复警示断言并通过。删除实现沿 `.trash` 的 C5 测试通过。

## 4. 对抗检查

(a) **无法证实**：未在实际 dsh 宿主打开面板并计数网络；源码显示打开 `load()` 只 GET `/library/paper-status`，但这不是网络运行证据。

(b) **无法证实**：未独立构造 conflicts/quarantine 临时库并对比真实横幅；源码面板使用 `need.papers`，但缺乏本轮 endpoint 夹具输出。

(c) **证据（静态/测试）**：`client.js:2126–2130` 只把 `complete`/`incomplete` 接受为完成/未完成，其余归 `unknown`，并渲染 `?` 与“未知”；测试 379/380/384 通过，覆盖无译文、未转录、损坏/不可读未知不冒充完成。

(d) **证据**：测试 469 F1 通过 zh/en 键集合及 t(key) 定义；测试 470 F2 通过删除/重命名文案使用。未发现迁移逐字输入 UI；未独立写脚本输出死键集合，故“逐字输入死键全检出”无法证实。

(e) **证据**：测试 427 VB12 明确无原生 confirm/prompt；测试 453 C5 明确产物进入 `.trash`；删除 UI 由页内 portal + 服务端 delete-plan 驱动。

(f) **证据**：两处断言仍存在且全量测试通过，未被注释或删除；`delTopicTypeName` 的新契约断言在既有文件中可检索并通过。

## 5. 只读性与变异

测试 382 的原始标题为 `read-only pagination, TTL, invalidation and missing root do not mkdir or mutate files`，测试 383 为权限/预算不完整枚举，均通过；这是临时夹具测试，不触碰 `~/.dsh-paper-reader/data`。真实浏览器 stub 打开面板不发迁移请求，但未接 dsh API，故 (a) 仍列无法证实。

变异脚本原始输出见 `.probe/t3-mutation.log`；58/76 的 18 条失败均为 CRLF 环境造成的锚点不命中，不是变异存活或本轮回归。M1–M8、N1–N11 等迁移提示相关变异均为 `OK`。专用三项变异（状态轴、同源篇数、一键门槛）未另行注入，故仅该额外验收项仍列未执行；不将 CRLF 失败视为 blocker。

## 6. 未通过/未验证

未发现 `npm test` 失败；但真实宿主网络探针、conflict/quarantine 横幅同源复现、完整 i18n 死键脚本输出、P1–P11/P14/P15/P17/P23 独立夹具、专用三变异红灯均未完成，诚实列为无法证实。Chromium 仅完成 stub DOM 尺寸与键盘观察，不声称真实 dsh 宿主渲染。

未修改产品代码。

## 7. t6 重开验证补充（attempt 1）

已复核前文两条裁定：skip-zero=成立；mutation-probe 58/76 的 CRLF 锚点未命中为环境性、非本轮回归。原始证据与数字均保留。

复跑：`npm test 2>&1 | tee .probe/t6-npm-test.log`，退出码 0，尾部仍为 578 tests / 542 pass / 0 fail / 36 skipped；`node --test test/paper-status.test.mjs 2>&1 | tee .probe/t6-paper-status.log`，退出码 0，6 tests / 6 pass / 0 skipped。追加聚焦：`node --test --test-name-pattern='P29' test/migrate-prompt.test.mjs` 退出 0（1/1），`.probe/t6-same-source.log`；该用例构造 `plan.totals.papers=0`、need.papers=3、conflict=1、quarantine=1，断言面板与横幅均 `pending 3`、人工处理 `manual 2`。

未知态：`node --test --test-name-pattern='status unknown|read-only pagination|root/subtree permission' test/paper-status.test.mjs` 退出 0，3/3；原始 `.probe/t6-unknown.log`。覆盖损坏/超大 JSON、字节不匹配、符号链接、不可访问产物的 unknown≠complete，以及权限/预算不完整枚举不误报空成功；测试 382/383 同时确认不 mkdir/不变异临时库。真实运行用户为 root，chmod 不可作为权限实验，故采用测试注入/损坏夹具，不修改真实库。

零 POST：等效 Chromium harness `node .probe/migrate-ui-evidence/request-count-probe.mjs` 退出 0，`.probe/t6-zero-post.log`。打开/翻页/刷新阶段 calls 仅两次 `GET /api/library/paper-status`，`migrationPostsBefore=0`；显式确认后新增恰好一次 `POST /api/library/migrate`，`migrationPostsAfter=1`。请求计数为：`before=[GET,GET]`，`after=[GET,GET,POST /api/library/migrate]`。

以上三项均有原始输出；harness 为等效 stub，不声称实际 dsh 宿主挂载。