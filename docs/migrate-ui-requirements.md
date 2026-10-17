# 迁移提示图形化状态面板：冻结需求与设计

> t1 / requirements round 1。现状指本工作树提交态；新设计是后续实现、验证、评审唯一契约，不代表已经实现。零代码改动、不执行迁移、不部署。

## 0. 范围与基线

工作树 `.worktrees/migrate-ui-report`，分支 `feat/migrate-prompt`。改造横幅、设置卡片与迁移弹层；迁移、删除和清空专题取消逐字输入，改成明确警示后单次确认。不新增翻译/OCR 执行入口，不重写迁移、回滚、回收站算法。

开工 `git status --porcelain` 基线：

```text
?? package-lock.json
```

队长正式改约验收第8条：依赖安装产物为豁免项，不删除、不 add、不改忽略规则；相对基线仅新增本文件，任何已跟踪文件均不得修改。主工作区本地改动不得触碰。

## 1. 现状锚点表

路径均相对本工作树，行号为改造前锚点。

| 表面/职责 | 事实与代码锚点 |
| --- | --- |
| 横幅 | `lib/client.js:1948-1978` MigrationBanner，从共享 useMigration 取 need/choice；`:1501` 宽侧栏树前插入，`:1973` 报告按钮，`:1978` portal。 |
| 设置卡片 | `lib/client.js:1983-2021` MigrationCard；`:2117-2120` 设置首项；状态、以后再说、重新检查、不再提醒。 |
| 弹层 | `lib/client.js:2026-2036` MigrationReportDialog GET migrate-plan；`:2040-2043` POST confirm；`:2064-2090` need 同源介绍、人工注记、不可读提示及 pre 原文；`:2092-2102` migrate 输入门。 |
| 删除确认 | 任务所称 ConfirmDialog 实际符号是 `ConfirmDelete`，`lib/client.js:958-993`；requireText 在 `:963-965` 决定 ok，`:980-985` 输入；`:1575-1597` 调用，`:1595` 非单篇均需专题名。 |
| 纯函数 | `lib/client.js:121` dprMigrateExecEnabled 严格等于 migrate；`:153-165` dprMigrateReportIntro 用 need.papers/files，不用 plan.totals.papers。 |
| 共享偏好 | `lib/client.js:1866-1881` GET/60s复用；`:1890-1911` 实际渲染 ask 才记账，dataDirId+fingerprint 去重；`:1914-1944` choice、镜像与双表面订阅。 |
| 列库 | `src/host.ts:545-551` GET /api/library 返回 dataDir/topics/papers/tree；带实际 pdfPath/legacy，无三轴。 |
| 预检 | `src/host.ts:952-959` GET /api/library/migrate-plan 返回 plan/report。 |
| 执行 | `src/host.ts:962-984` POST /api/library/migrate 必须 confirm:migrate-library，withInflight 后 runMigration，中止/冲突409。 |
| 清空专题 | `src/host.ts:862` clear-plan；`:910-945` POST /api/library/topic/clear，`:917-919` confirmName匹配，`:923-939` 重预检、会话/翻译busy护栏、clearTopic。 |
| 提示路由 | `src/host.ts:1017-1027` GET只读；`:1031-1086` POST/DELETE只写偏好；`:504` 非GET library 请求失效提示缓存。 |
| need | `src/migrate-prompt.ts:29-65` 分类/状态/字段；`:122-200` 扫描hits；`:202-242` papers=hits.length、migratable=flat+residue、不可读unknown；`:268-284` 不抛/缓存入口。 |
| 论文与路径 | `src/library.ts:45-49` 排除译文变体；`:138-145` isPaperDir；`:160-203` listPapers兼容legacy且文件夹赢；`:206-211` paperPdfPath；`:257-268` refFor产物；`:320-326` transcriptCached仅txt.size>1000。文件头`:13-14`“不双读”是陈旧注释，以`:152-158`实际兼容实现为准。 |
| 翻译/转录 | `src/translate.ts:31-52` zhPdfPath/dualPdfPath/zhStatus；`src/transcribe.ts:24-41` source与producer分离；`:192-207` readTranscriptMeta吞缺失/损坏/权限为null；`:219-245` readCached与bytes校验；`:417-422` transcript.json最后写作提交标记。 |

## 2. 新设计：三轴状态数据契约

### 2.1 端点（冻结：新增只读端点）

新增 GET `/api/library/paper-status?offset=0&limit=100`，不扩展常用 GET /api/library：避免每次树刷新读取全库 sidecar；面板打开才惰性加载，分页与失败独立，不阻塞旧布局。offset非负整数、limit为1..100，非法400。`force=1`只绕过缓存，不重置/写提示偏好。原 migrate-plan/agent migration_report/CLI 兼容保留，UI不再调用文字报告。执行仍由原POST内部重新权威预检。

```ts
type Completion = 'complete' | 'incomplete' | 'unknown'
type PaperStatus = {
  topic: string; name: string;
  translation: Completion; mineru: Completion; migration: Completion;
}
type StatusResponse = {
  ok: true; scannedAt: string; snapshotId: string;
  need: MigrationNeed;
  papers: PaperStatus[]; total: number;
  offset: number; nextOffset: number | null;
  complete: boolean; // 整库枚举完整性，不是三轴全完成
  unreadable: { topic: string; cause: string }[];
}
```

排序固定topic/name。分页snapshotId改变时客户端丢旧页重载，禁止混拼。只给相对topic/name，不回传文件内容、engine/baseUrl或凭据。根/子树不可读、超预算为正常200+complete:false；total只代表已发现篇数，不完整时不展示全库总数。根ENOENT为空库，EACCES/EPERM不是空库。无法列举的论文不伪造行，显示不可读专题占位和全局未知。

### 2.2 判定规则

新增只读模块（建议src/library-status.ts），readPaperStatuses负责探测；纯分类函数 classifyTranslationStatus/classifyMineruStatus/classifyMigrationStatus 接收可注入fs结果，无写入。项目既有“纯函数”主要指不依赖Cordis；zhStatus仍读fs（`src/translate.ts:42-52`），不是三态纯分类器。

所有轴：证实缺失ENOENT→incomplete；权限/IO失败、越界/链接、损坏JSON或预算未完成→unknown；**unknown绝不显示成complete**。产物只检查权威PDF所在目录（文件夹优先），不能把平铺残留的旧译文拼到新目录PDF。

| 轴 | complete 已完成 | incomplete 未完成 | unknown 未知 |
| --- | --- | --- | --- |
| translation | zhPdfPath与dualPdfPath均为库内非链接、可读、非空常规文件，两个全齐才完成（`src/translate.ts:1-3,31-35`） | 任一明确缺失/为空；只齐一个仍未完成；-en及.tmp-*不算 | 无法确认权限/类型/权威PDF位置 |
| mineru | 合法.transcript.json，producer为mineru-local/cloud；text.bytes正整数且与.txt stat.size一致且>=1000，text.chars>=1000；.pages.json可解析且pages非空/页号偏移合法；.mineru.md/.mineru.json为可读非空常规文件 | 确认无提交标记或必需产物缺失/为空；pdfjs与缺标记legacy绝非MinerU完成 | JSON损坏、bytes不符、权限/安全边界无法确认 |
| migration | 确认论文目录结构且同stem没有任何平铺产物hit | 同一次need扫描中flat/residue/conflict/quarantine任一hit；有目录但残留也未完成 | 父级/目录不可枚举、size无法判断、超预算；不能以未命中证明完成 |

source='cache'只是本次调用复用缓存，local是pdfjs，必须按producer判断（`src/transcribe.ts:24-41`）；任意txt或配置了MinerU不等于完成。现有readTranscriptMeta吞权限、transcriptCached只检查txt（`src/transcribe.ts:191-207`、`src/library.ts:320-326`），不可单独复用为三态判据。新探测保留errno，**不调用transcribePaper或startTranslation**。

迁移行状态必须从detectMigrationNeed同一次扫描抽取按(topic,name)索引的内部hit集合，保持原MigrationNeed兼容。行集合为论文目录与平铺stem并集，含根平铺、冲突/quarantine、隐藏论文，去重且文件夹赢；不能仅listPapers，否则漏冲突项（`src/migrate-prompt.ts:144-195`对比`src/library.ts:179-195`）。根平铺放“库根目录”虚拟组，不声称正常专题。迁移列仅三态，不返回/展示逐篇原因。

### 2.3 只读、安全与规模

- 禁用resolveDataDir（`src/library.ts:58-62`会mkdir）、转录/翻译/迁移执行、内容hash；不写marker、偏好或状态镜像。仅进程内缓存可变。
- lstat/realpath防链接逃逸，不跟随链接。现状isPaperDir注释说不算链接，但实现statSync会跟随（`src/library.ts:135-143`），不能直接当安全证明。状态模块独立防御，不改全局列表行为。
- 根/子树不可读继续其它分支，不抛整页500、不误报空库/完成；不能用existsSync(false)混淆权限。need.certain=false时不显示准确N。
- 复用need的60s TTL与20000目录条目预算（`src/migrate-prompt.ts:68-71`）；按dataDirId缓存，每库仅一个快照。打开面板才扫描；页内最多100篇、探测并发8、客户端默认折叠专题并显式加载更多，无轮询。
- 目录/stat只读，不读PDF/全文txt/md/mineru.json；仅小型标记/pages JSON允许读，单文件1MiB上限，超限unknown。O(目录条目)+O(当前页×常数产物)，禁止逐篇resolvePaper重扫全库（`src/library.ts:306-317`）。避免新增stem×文件二重匹配。
- 上传/删除/改名/迁移/转录/翻译完成失效状态缓存；显式刷新force扫描；执行后重取need与三轴。不能仅沿用host非GET失效（`src/host.ts:504`），后台翻译完成也要失效。

## 3. 界面与参考证据

### 3.1 llm-for-zotero参考

已核实仓库具体文件 [README.md / Managing MinerU caches](https://github.com/yilewang/llm-for-zotero/blob/main/README.md#managing-mineru-caches)，取证源[raw README](https://raw.githubusercontent.com/yilewang/llm-for-zotero/main/README.md)：Preferences的MinerU tab中有Manage Files面板，可按collection/tag/title/author/year/added date浏览cached/uncached PDFs，可对all visible/filtered/selected启动解析、repair，及all/filtered/selected/single cache删除。这是公开文档级证据，不是亲测。

借鉴“设置内集中管理、按集合浏览、逐项cached/uncached状态”，不复制自动解析/批量OCR/缓存删除等能力。README引用[assets/minerU.png](https://github.com/yilewang/llm-for-zotero/blob/main/assets/minerU.png)，本轮未读取图片，不主张截图细节。GitHub树API返回403 rate limit；设置源码路径、实际像素/配色/表格勾选框**未核实**，不伪称复刻视觉。

### 3.2 三表面与面板

横幅保留ask/quiet/hidden门，仅把入口改“查看论文状态”；设置首卡常驻保留偏好按钮，可查看已完成/空库。弹层改PaperStatusDialog，data-part改paper-status-panel。**删除pre原文报告、migrate输入框与逐篇skipped/失败原因**；后端/CLI/agent只读报告不删。

```text
论文状态                                      关闭
待迁移 N 篇                              刷新状态
其中 M 篇需人工处理（迁移不会自动收口它们）。
文件级检查；未知不代表完成。检查时间…
专题 A                                        折叠
论文                  翻译       MinerU转录       迁移
P1                    ✓ 已完成   — 未完成         ✓ 已完成
P2                    ? 未知     ✓ 已完成         — 未完成
专题 A/B …
加载更多（已发现…）
警示：先复制…验证成功后删除旧位置源文件…请备份…
取消                                      确认迁移
```

图标+文字双编码，不只靠颜色；已完成成功色、未完成中性色、未知警告色。沿用宿主字体/DSW主题变量，无品牌字体/装饰渐变；兜底surface #ffffff、text #24292f、muted #656d76、border #d0d7de、success #1a7f37、warning #9a6700，深色随宿主。表头/篇名左对齐，状态等宽；最大900px、90vw/86vh；窄屏转篇名+三标签，长名换行。真实button可键盘操作，dialog/aria-modal/标题关联、焦点圈、Escape、关闭还焦点；默认焦点取消，不用Enter快捷触发破坏性操作；busy禁止重复提交/关闭误导，无自动动效。

### 3.3 警示+一次点击

底部警示后**点一次“确认迁移”直接POST**，不再第二确认、不键入、不双击arm。加载/失败/unknown/need.migratable=0禁用并说明；need.certain且migratable>0才可执行。busy同步锁防连点。打开/刷新/分页/关闭/保存偏好绝不执行。保留服务端confirm:'migrate-library'误调用栅栏，但不称其密码或人类身份证明，仅确认click发送，不新增agent执行工具。

警示写清先复制、验证后删除旧源、不会覆盖冲突、需备份、可中断/复跑/日志回滚。结果仅聚合成功/部分完成/失败和日志位置，不列逐篇失败原因；随后强制刷新，部分完成仍保留M注记。

删除单篇/空专题/清空专题仍先取服务端计划/逐篇文件清单；明确回收站可恢复、保留会话、隐藏项、busy护栏。移除ConfirmDelete的requireText/typed/输入与传参；一次“移入回收站”或“清空并删除”。服务端confirmName匹配保留，click自动携带name（当前已如此，`lib/client.js:1371-1374,1392-1394`）。计划失败不能执行，防重复点击。非空竞态必须重新展示clear-plan的新范围，不能沿旧确认扩大范围（现状转流程`:1402-1404`）。恢复提示不删（`:1379-1382,1583-1591`）。

### 3.4 zh/en文案清单（新键，除标明改写外）

| 键 | zh | en |
| --- | --- | --- |
| migViewStatus | 查看论文状态 | View paper status |
| migStatusTitle | 论文状态（只读检查） | Paper status (read-only check) |
| migStatusDesc | 查看每篇论文的翻译、MinerU转录与迁移状态；不迁移也照常使用。 | Check translation, MinerU transcription and migration for each paper. The old layout keeps working. |
| migPending | 待迁移 {n} 篇 | {n} paper(s) pending migration |
| migManualNote | 其中 {n} 篇需人工处理（迁移不会自动收口它们）。 | {n} paper(s) among them need manual handling; migration will not settle them automatically. |
| statusPaper / statusTranslation / statusMineru / statusMigration | 论文 / 翻译 / MinerU转录 / 迁移 | Paper / Translation / MinerU transcription / Migration |
| statusComplete / statusIncomplete / statusUnknown | 已完成 / 未完成 / 未知（不可读或无法确认） | Complete / Incomplete / Unknown (unreadable or unverified) |
| statusScope | 状态为文件级检查，不代表内容质量；翻译完成需中文版与对照版都就绪。 | Status checks files, not content quality. Translation requires both Chinese and bilingual PDFs. |
| statusLoading / statusEmpty / statusFail | 正在检查… / 文献库为空 / 无法读取论文状态，请重试 | Checking… / Library is empty / Could not read paper status. Try again. |
| statusUnreadable | 部分目录不可读或未扫完，无法确认全库状态。未知不代表已完成。 | Some folders are unreadable or not fully scanned. Library status is unknown, not complete. |
| statusRefresh / statusMore / statusRoot | 刷新状态 / 加载更多 / 库根目录 | Refresh status / Load more / Library root |
| statusCheckedAt / statusDiscovered | 检查时间：{time} / 已发现 {n} 篇 | Checked at {time} / {n} paper(s) discovered |
| statusExpand / statusCollapse | 展开专题 / 折叠专题 | Expand topic / Collapse topic |
| migWarning | 警示：迁移先复制到论文文件夹，验证成功后删除旧位置源文件。冲突项不会覆盖，需人工处理。请先备份；可中断、复跑并凭日志回滚。仅点击“确认迁移”才执行。 | Warning: migration copies files into paper folders, then removes old sources after verification. Conflicts are not overwritten and need manual handling. Back up first; migration is interruptible, repeatable and reversible using its log. Only Confirm migration executes it. |
| migExecute / migExecuting（改写） | 确认迁移 / 正在迁移… | Confirm migration / Migrating… |
| migNotExecutable | 当前无法安全确认可迁移项目，请刷新或处理不可读目录。 | Cannot safely confirm migratable items. Refresh or resolve unreadable folders. |
| migExecPartial（改写） | 部分完成；仍有项目未收口，请查看状态与迁移日志。 | Partially complete. Some items remain; check statuses and the migration log. |
| migDone（改写） | 迁移执行结束，请以刷新后的逐篇状态为准。日志：{log} | Migration finished. See the refreshed per-paper statuses. Log: {log} |
| migExecFail | 迁移未完成：{error} | Migration did not complete: {error} |
| delTopicWarning | 确认将专题“{name}”移入回收站（可恢复）；伴读会话历史不会删除。 | Move topic “{name}” to trash (recoverable)? Chat history is kept. |
| delWarning | 警示：下列文件将移入回收站（可恢复）。确认范围后点击一次执行。 | Warning: these files will move to trash (recoverable). Review the scope, then confirm once. |

复用cancel、delToTrash、delTopicClearTitle/Body/Confirm/Blocked/Hidden、notDeleted、later/never/recheck双语；警示正文可见，不只tooltip。日期/根组名/错误不硬编码中文。

## 4. 必须保留的冻结约束

| 约束 | 理由与落点 |
| --- | --- |
| 只提示绝不自动迁移 | effect/GET无执行；host confirm保留（`src/host.ts:962-970`）；仅确认click发POST，无agent执行工具。取消键入不等于取消服务端确认。 |
| 不每次都问，双轴偏好 | dataDirId+fingerprint，asked/later同库同指纹安静；declined同库吸态，换库或显式recheck才重问（`src/migrate-prompt.ts:516-534`、`src/host.ts:1054-1064`）。保留useMigration记账/镜像调和。刷新状态不重置偏好。 |
| 不阻塞旧布局 | legacy读兼容/实际pdfPath不变（`src/library.ts:152-158,179-185,205-211`），面板失败不影响列表/打开/检索/删除/改名。 |
| 只读/无权限不误报 | 不mkdir/写偏好；根不可读门silent，子树不可读info不报篇数（`src/migrate-prompt.ts:500-508`）。设置主动查看可中性unknown。 |
| N与横幅同源 | N=同快照need.papers，包含conflict/quarantine，不是plan.totals.papers、legacy行数或本页未完成数（`src/migrate-prompt.ts:49-55,202-207`）。面板新need发布到共享快照；certain=false两个表面都不报N。 |
| M人工注记可见 | M=need.byClass.conflict+quarantine，同次size级扫描，M>0汇总下方可见、不藏折叠/tooltip，不把未知加进M。原纸面注记见`lib/client.js:2066-2086`。迁移列只表达三态。 |
| 标记不是事实 | 保留markerSync说明，空库旧done不算已迁移（`src/migrate-prompt.ts:208-225`）。 |
| 删除安全不变 | confirmName由click携带；会话未知/运行、翻译busy、withInflight、边界/回收站/回滚恢复不删（`src/host.ts:910-945`、`lib/client.js:1379-1382,1583-1591`）。 |

## 5. 受影响清单与验证

### 5.1 必改既有测试（不简单删除断言）

| 锚点 | 原断言 → 新断言 |
| --- | --- |
| `test/migrate-prompt.test.mjs:705-718` | migration-report part、键入migrate禁用、execEnabled字符串矩阵 → 三轴panel part、无输入、加载/unknown/busy禁用、可迁移时单击仅一POST且confirm令牌保留。 |
| `test/migrate-prompt.test.mjs:837-856` | GET migrate-plan、键入启用、原文报告 → GET paper-status、专题逐篇三轴、无pre/输入/逐篇原因、警示可见、点击前无POST。 |
| `test/migrate-prompt.test.mjs:998-1010` | migReportManual → migManualNote；构造conflict/quarantine且plan.totals=0仍保留N/M同源。 |
| `test/migrate-prompt.test.mjs:1445` | VM导出execEnabled/reportIntro随新纯函数调整；`:795-798,886,1201,1273` fake migrate-plan路由改状态响应；`:1481-1488` stub保留query用以断言分页/force。 |
| `test/library-clear-and-busy.test.mjs:554-567` | B10第561行requireText断言 → 无输入但有警示/一次点击/confirmName body；第556-560及562-566计划、portal、busy护栏断言保留。 |
| `test/library-clear-and-busy.test.mjs:344-365` | B3缺/错confirmName仍400，不因取消UI键入放宽接口。 |
| `test/mutation-probe.mjs:278-279,291-294` | M8双语、N4介绍同源靶子更新到新键/汇总，防变异不命中；`:248-276,282-319`无自动迁移/双轴/未知护栏继续有效。 |

新增测试：翻译只齐一个；legacy/pdfjs/cache语义；合法local/cloud提交；缺md/json/pages/marker、坏JSON、bytes不符；注入EACCES/EPERM与ENOENT区分（root下chmod不可靠）；根不存在零mkdir；根/子树不可读不误完成；文件夹+残留/冲突/quarantine/隐藏/同名不同专题/根平铺；链接逃逸；空库旧done；20000预算、100分页、并发8、TTL/写后失效；GET前后库与偏好字节不变；开关/刷新/分页零迁移POST；busy连点一个POST；执行三种结果重扫；三态双语/未知非成功图标；窄屏键盘焦点。

### 5.2 i18n影响

zh现状 `lib/client.js:280-305`，en `:398-418`；删除键zh `:228-243`，en delTopicTypeName `:353`。

- 两侧删死键：migViewReport、migReportTitle、migReportIntro、migConfirmHint、migReportFail、migReportManual、delTopicTypeName，以第3.4节替代。
- 两侧改写：migBannerDesc不再“先报告”；migExecute/Executing/ExecPartial/Done；migNeedsManual改中性“需人工处理，迁移会跳过”（还有quarantine，不能只说同名冲突）。
- 两侧保留：migBannerAsk/Quiet、migMarkerMismatch、migUnknown、migMigrated、migDeclinedRow、migLater/Never/Recheck和真实删除/恢复/busy文案。超预算用无篇数中性文案，不报0棵不可读。
- 新键完整清单见3.4；无调用的dprMigrateExecEnabled/dprMigrateReportIntro删除，不留死代码。

### 5.3 文档与用户说明同步

- `README.md:25-26`、`README_EN.md:25-26`：UI先报告/typed-confirmation改为逐篇面板+警示单击；CLI干跑报告仍存在。
- `docs/features.md:83-90`、`docs/features_EN.md:83-90`：当前未描述迁移面板/逐字输入（已核实），同步补三态、未知、双译文标准和确认方式，不冒称有旧句。
- `docs/migrate-prompt-plan.md:311-326,381-391,404,480,537,573,586`：输入migrate/报告弹层/禁止一键的旧冻结陈述需标superseded并修订入口、文案与验收；UI部分以本设计为准，agent/CLI报告能力不删。
- `docs/reader-ux-requirements.md:367,448`、`docs/darkmode-subtopic-plan.md:544,626,652-665,877`：手输专题名约束标取代/更新，避免两个现行契约。
- `src/migrate-prompt.ts:425-439,465-466`、`src/host.ts:949-965`中的“先UI报告”措辞更新为面板；agent可调migration_report仍保留。src/tools.ts/预设是否还有硬编码“输入migrate”的具体行号**未核实**，实现阶段必须检索核实，不盲替换。

实现阶段验证：npm run build；node --test test/migrate-prompt.test.mjs test/library-clear-and-busy.test.mjs；新增状态测试；npm test；迁移mutation probe；真实浏览器刷新既有GUI检查双语/窄屏/焦点。stub不证明真实DOM，部署必须另取用户确认。

## 6. 本设计的已知取舍与风险

1. 文件级检查不证明内容质量，不hash PDF，不重新OCR。60s内外部手改可能滞后；显式刷新、执行重预检兜底。need的size级与权威迁移sha256仍可能不同（`src/migrate-prompt.ts:17-19`），不可把部分完成包装成全成功。
2. zh+dual全齐、MinerU完整提交标准较严格；有一种译文/可搜txt不代表工作流完成。损坏不可读为未知，宁可保守。
3. 不显示逐篇原因降低排障速度，按用户要求保留聚合人工注记与日志/agent报告维护渠道，不承诺面板自动修复。
4. 独立缓存分页要测试防拼接过期need；大库超预算仍未知，不能放宽到阻塞GUI。1MiB侧车上限可能令很长论文pages未知，这是显式规模取舍。
5. 取消键入降低防误触强度，以明确警示、取消默认焦点、显式单击、busy去重、服务端栅栏和恢复算法补偿；令牌不能证明人类身份。
6. 外部只核实README Manage Files具体描述，实际设置源码/像素未核实。三项intern委派均因depth=2>maxDepth=1被拒，队长授权自行读码；没有采信未复核实习生产物。
