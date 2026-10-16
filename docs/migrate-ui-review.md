

# t12 round 4 收尾复评

## 当前最终 Verdict：PASS，可进入集成（不是部署授权）

F3闭合；F1/F2/R1/R2未回退。无新的阻断finding。本轮产品零修改，仅追加评审记录及忽略的独立探针。前轮结论保留下文作历史，**最终以本节为准**。

### Chromium客观测量与目视补证

`node .probe/review-r4-browser.mjs > .probe/review-r4-browser.log 2>&1` exit0；原样抽取当前生产组件/样式/词典，临时库夹具及DOM hook适配器，不采信实现方自述。

- 截图：`.probe/review-r4-420.png`、`.probe/review-r4-900.png`。
- 420：三篇的每篇innerText明确含“翻译: — 未完成 / MinerU 转录: — 未完成 / 迁移: — 未迁移”；9个axis-label计算display均inline，行display=block，document.scrollWidth不大于viewport，overflow=false。F3客观闭合。
- 900：可见四表头“论文/翻译/MinerU转录/迁移”；每一行四cell getBoundingClientRect().x均`[53,351.5625,519.375,687.1875]`，三行完全一致，与r3一致。label span桌面display=none。F1无回退。
- 两宽度折叠实点击均0论文行，展开均3论文行；组头“A · 折叠专题”/“A · 展开专题”，名与动作清晰分隔。
- 因本成员模型不支持图像输入，按队长正式改约由队长亲自读取两张截图做目视：队长明确签核PASS，确认420三轴逐行具名无溢出、900四列左缘对齐且无重复轴名；N/M人工注记、范围、时间、警示和按钮均在位。

### 独立行为重攻击与统计

| 命令 | 原始结果 |
| --- | --- |
| `npm run build` | exit0 |
| `node .probe/review-r4-authority.mjs` | tests2/pass2/fail0/skip0，权威migrate-prompt从旧ask切migrated/unknown，均不再ask、无新增偏好POST |
| `node .probe/review-r3-pagination.mjs`（本轮重放，日志review-r4-pagination.log） | tests1/pass1；可达分页snapshot变化后挂起offset0时intro=null/rows0，旧N与列表清除，释放后恢复 |
| `node .probe/review-mutations.mjs`（日志review-r4-mutations.log） | exit0；新代码LF独立副本三变异被杀：axis fail2、count P29 fail1、gate P25b fail1；不是锚点未命中 |
| `node --test test/paper-status.test.mjs test/migrate-prompt.test.mjs` | tests49/pass49/fail0/skip0 |
| `npm test`（review-r4-full.log） | tests582/pass546/fail0/cancelled0/skipped36/todo0；exit0 |

P25c权威状态矩阵/P25b/P25d/P25e本轮实际执行：R1 migrated不ask、unknown不记asked；R2正常零项migNothingToExecute与unknown migNotExecutable分离；busy/未知/零迁移一键门保留。没有沿用旧轮测试代替重跑。

### 死键、断言与文案审计

全源剔除zh/en字典后扫描引号键（包含动态t三元分支），现存无引用键仍为既有旁支10项：`newName, delTopicClearPlanFail, eqTitle, eqNeedMineru, eqTranscribe, eqCopy, eqChip, eqTranslatedView, eqNoPosition, moveTopicHint`。本轮冻结六键全部实际引用、无新增死键；建议这些旁支键后续独立清理，不阻塞本轮。P21b验证两语言键集合和占位符完全一致。

本轮改动为axis-label响应式显示与组头措辞，没有放宽原有安全断言；P25e增加窄屏标签断言。`git diff -- test/`新增skip/only扫描`[]`；36个全量条件skip为环境样本/服务条件，非新增t.skip。README/features当前状态面板+警示单击口径不变，历史键入migrate段落明确superseded，未发现新的现行矛盾。

### 非阻断残留风险

截图是等效stub harness，**不是宿主实际挂载**。宿主主题变量、真实配色/对比度无法据此最终判断；不能把stub标题偏暗定产品缺陷。真实宿主视觉确认应在用户显式确认部署后进行。本次PASS仅批准进入集成，不授权部署或操作真实文献库。

---

# t10 round 3 复评

## Verdict：needs_revision；F1/F2 主修复生效，但新增 F3 阻塞窄屏验收

本轮只读产品，自造 Chromium/分页探针，未部署、未触碰真实库。intern 在前轮被运行时 depth 2 > maxDepth 1 拒绝，本轮沿既定运行限制自行验收。

### F1 客观浏览器证据

命令：`npm run build` exit0；`node .probe/review-r3-browser.mjs > .probe/review-r3-browser.log 2>&1` exit0。脚本原样抽取当前 PaperStatusDialog/SET/zh，用真实 DOM + hook适配器（支持函数setState），注入临时真实库状态。不是手写仿制界面。

- 截图：`.probe/review-r3-900.png`、`.probe/review-r3-420.png`。
- 900px四个可见表头为 `[论文, 翻译, MinerU 转录, 迁移]`；对每一篇`[data-dpr-paper]`的四个`[role=cell]`调用`getBoundingClientRect().x`，三行结果完全相同：`[53,351.5625,519.375,687.1875]`。行display=grid，无横向溢出。
- 420px三行均display=block，四cell x均29，无横向溢出；但visibleHeaders为空，行文本为 `P / — 未完成 / — 未完成 / — 未迁移`，**没有翻译/MinerU/迁移轴名**，见F3。
- 折叠按钮实点击：900与420均折叠后0论文行、文案“展开专题: A”；再点展开3论文行。范围说明/检查时间/人工处理注记在DOM与截图上存在。
- 本成员read_image尝试被后端拒绝：`model gpt-6.1-sol does not declare image input`。队长已正式改约：由我负责截图与客观测量，队长负责像素目视补证。队长消息确认900表头/列左缘对齐、N3/M2/范围/时间/警示/按钮在位；420无溢出但确实丢失轴名，F3成立。未把stub未注入主题导致的颜色差异定缺陷。

### F3 / high / 阻塞：420px堆叠丢失三轴标签

- `lib/client.js:2155,2159-2160`。
- media query隐藏所有columnheader；cell新实现只输出符号+状态，不再携带axis名。窄屏每篇看到两个相同“未完成”，无法区分翻译与MinerU，migration也无显式轴名。违背冻结“篇名+三标签”与直观三轴状态目标。
- 复现：运行上述Chromium脚本，日志420 `visibleHeaders:[]`、`rowTexts`无任何轴名；截图路径如上，队长已目视确认。
- requiredFix：窄屏每个状态cell带可见轴名（例如响应式label或data-label+CSS），桌面保持四列对齐；新增420断言每篇的三个轴名可见，不能只断言页面无溢出。

### F2 可达路径重放：闭合

命令 `node .probe/review-r3-pagination.mjs > .probe/review-r3-pagination.log 2>&1` exit0，1/1通过。临时副本的VM harness修正为dialog mount effect仅首次运行，避免旧fake harness每render重新load造成不真实请求；产品不修改。

序列：offset0取得N3和next100 → 用户点击可见statusMore → offset100返回不同snapshotId → offset0重载Promise挂起。此时断言`intro=null`且论文行0，输出 `PENDING intro=null rows=0 requestCount=3`；释放重载后intro和新列表恢复。旧N/列表不再可见，F2关闭。

前轮“背板recheck横幅7/面板3”仍仅程序化动作，modal遮挡用户不可点击，不作为阻断；前轮分页攻击的旧日志亦包含fake effect重复load，不能沿用其断言直接判本轮。当前针对真实mount语义的新可达探针通过。

### 三LF变异与R1/R2回归

`node .probe/review-mutations.mjs` exit0：逐次mkdtemp副本、CRLF→LF且检查无CR/唯一锚点。axis unknown→complete使2用例红；N need.papers→migratable使P29红；安全门→true使P25b红。没有以锚点失败充数。

`node --test test/paper-status.test.mjs test/migrate-prompt.test.mjs`：49 tests/49 pass/0 fail/0 skip。含P25c权威migrated不ask/unknown不写偏好矩阵、P25d乱序、P25b门槛、空/正常0与unknown文案分离。新F1/F2测试保留原有安全断言，diff扫描新增skip/only为[]。

### i18n死键库存与文档

冻结六键本轮都实际引用，zh/en键集与占位符一一对应测试通过。全client（剔除两字典）扫描未出现任何引号键引用的残留为：`newName, delTopicClearPlanFail, eqTitle, eqNeedMineru, eqTranscribe, eqCopy, eqChip, eqTranslatedView, eqNoPosition, moveTopicHint`。这些是本轮前既有旁支死键，不属本次冻结六键，不单独阻断；建议后续单独删除两侧或接到真正功能，避免冒充已用文案。动态t()三元分支也已纳入扫描，未把migBannerAsk等顶层函数实际使用的键误列死键。

README/features/旧计划的当前面板+警示单击口径未被本次改变；历史逐字输入已明确superseded，未见新文档漂移。唯一正式未闭合是F3，需修复再评审。

---

# t8 round 2 复评（修复后）

## 裁定：needs_revision，禁止集成

R1 的「旧探针误设 paper-status 与 migrate-prompt 不同源」解释成立；但本轮新增的冻结界面契约出现明确偏离，且独立新鲜度攻击发现面板页内 N 会滞留旧快照。R1 核心 migrated/unknown 直连路径通过，三专用 LF 变异均被杀；这些不能抵消界面契约和页内一致性问题。

## R1 独立新设计攻击与旧探针裁定

- 新探针 `.probe/review-round2.mjs`：复制当前 test/lib/dist 到 `/tmp/dpr-r2-*`，权威 `GET /library/migrate-prompt` stub 初始 ask 后切换权威 `need.state=migrated,papers=0` 或 `state=unknown,certain=false,unreadable=[B/EACCES]`，再触发面板刷新。两种均通过“不再 ask、无新增 asked POST”；因此裁定 **A**：旧 `.probe/review-stale.mjs` 只替换 paper-status stub、却刻意让权威 migrate-prompt 永远返回旧 ask/3 篇，违反新设计的原子权威配对，原场景在真实设计下不可达。旧探针仍 1/2 fail 是预期的错误夹具，不作 blocker。
- R1 的未知门也静态/动态通过：`lib/client.js:1936-1937` 明确 `certain=false/state=unknown` 不写 asked；`P25c` 的 migrated/unknown/偏好矩阵通过。

## 新发现 F1：冻结逐篇表格契约缺失（阻塞）

- 文件：`lib/client.js:2145-2167`。
- `statusPaper/statusTranslation/statusMineru/statusMigration/statusExpand/statusCollapse` 在词典定义，但 `t()` 引用分别为 0（`statusTranslation/Mineru/Migration` 只在轴名称处各有引用；其余表头键均0；`statusExpand/Collapse`均0）。实际渲染是 `<details><summary>专题</summary>`，每行用 `论文名` + `翻译: ✓ ...` 行内标签，非冻结的四列表头表格。
- 逐项裁定：
  - 四列表头：**缺失，high/blocking**；用户要求图形化直观面板，冻结设计明确表头。`statusPaper` 未渲染，论文列无标题；三轴表头未单独渲染。
  - 跨行对齐/状态列等宽：**偏离，medium**；`flexWrap` + `minWidth` 仅保证每个标签局部宽度，不构成跨行固定列；长篇名会按 flex 自适应，状态列可能换行/错列。≤420px 不溢出并不能证明表格可读对齐。
  - 专题分组与展开/折叠：**分组通过，折叠的视觉行为通过，但可访问性契约部分缺失，low/medium**；原生 `<details>/<summary>` 可折叠，然而没有使用 `statusExpand/statusCollapse` 文案/aria label，键定义成为死键。若冻结要求这两个可见动作文案，应补引用；不单独阻塞，但与表格整体一起加剧 UI 偏离。
  - 范围与检查时间：**通过**；`:2154` `statusScope`，`:2159` `statusCheckedAt`，且 `statusLoading/statusUnreadable/statusEmpty` 均有实际引用。
- requiredFix：改为真正 `<table>` 或等效 grid：显式渲染 `t('statusPaper')` 与三轴 `t()` 表头，篇名/状态列固定网格轨道（窄屏可转为每篇卡片但保留轴标题）；专题 summary 补 `aria-label`/可见 `statusExpand/statusCollapse`，或删除未用键并更新契约/测试。增加静态测试断言六键引用与420px截图/DOM列对齐。

## 新发现 F2：面板页内快照在可达分页刷新中滞留（medium，当前阻塞同源验收）

- 文件：`lib/client.js:2081-2100`。
- `.probe/review-round2.mjs` 攻击：先让权威面板加载 N=3 且返回 `nextOffset=100`；用户点击真实“加载更多”触发 offset=100，stub 返回 snapshotId 改变并触发实现的 `load(0,false)` 重启，同时权威 `GET /library/migrate-prompt` 已更新 N=7。观察输出 `PAGING authority7 banner [N=3] panel [N=3]`，且请求序列出现 GET status offset100 → GET status offset0；旧 N3 可见，随后延迟刷新也未得到新权威快照。该路径是用户可达的：`statusMore` 是实际按钮，`load` 内部明确 restart。
- 另一个跨表面脚本证明程序化从旧 dialog 调用设置卡片 recheck 可出现横幅 N7 / 面板 N3，但 modal 背景遮挡设置卡片，作为用户操作不可达；不以它单独定 blocker。分页攻击不依赖背板点击，因此有效。
- requiredFix：当 snapshotId 变化重启时，先清空旧 `data/latest` 或将面板置为 loading，不得继续展示旧 N；完成新的 offset0 + authority pair 后才显示 N7。保证 banner/card/dialog 绑定同一个 `migStore.snap` 版本，增加可达分页异步测试。

## 同源/TTL/乱序与变异

- 直连 `migFetch(false, epoch)` 当前采用服务端 60s TTL（请求不带 force），但每次有效面板页加载都先 GET status 再 GET authority；snapshot 改变的分页重启路径如 F2 暴露旧数据显示窗口。P25d 乱序测试通过：`loadSequence` + `migEpoch` 阻止迟到旧响应覆盖新结果；不能替代 F2 的旧数据清除。
- `node .probe/review-mutations.mjs` 在每轮独立 LF 临时副本运行且通过：axis unknown→complete 使2用例失败；count need.papers→need.migratable 使P29失败；gate安全门→true使P25b失败。没有引用旧 CRLF `mutation-probe` 的锚点失败数字。

## R2 文案与死键

- 空库/全迁移/unknown 实测新逻辑矩阵通过：`migNothingToExecute`（正常零项）与 `migNotExecutable`（unknown/不可读）分离；`statusEmpty`/`statusUnreadable` 具备 zh/en 配对。focused 47/47 通过，t7 全量报告580例0失败亦复跑当前聚焦无回归。
- zh/en 键集合检查通过，`statusPaper`、`statusExpand`、`statusCollapse` 等未引用键的处置意见：不能保留为死契约。若按本设计修复表头/折叠动作，应改用；否则删除两侧定义并删除冻结测试/文档要求。当前以 F1 要求“改用”为准。

## 回归与文档

- `node --test test/paper-status.test.mjs test/migrate-prompt.test.mjs`：47/47 pass/0 fail/0 skip；`npm run build` exit0。
- 专用变异均在 LF 副本，实际变红；没有新增 `skip`/`only`。原有删除确认和阅读器聚焦回归在上一轮100 tests/0 fail（12为环境条件 skip）基础上未见相关改动。
- README/docs 当前迁移 UI 已描述状态面板+警示单击；`docs/migrate-prompt-plan.md` 的旧“输入 migrate/迁移报告”条目处于 superseded 历史表，需保持标注避免误读。静态 grep 仍可找到历史字句，但不构成当前实现矛盾；README/features 未发现现行逐字输入指引。

## Verdict

**needs_revision**。必须修 F1（表格表头/死键/对齐，阻塞）和 F2（分页 snapshot 改变时清空旧面板数据，阻塞同源验收）后再评审；R1 主场景和 R2 文案已闭合，不能据此提前集成。
