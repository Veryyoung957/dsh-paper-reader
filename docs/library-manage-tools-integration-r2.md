# 集成收尾 r2：R-F3（祖先段 409）+ UI `layout-conflict` 文案（t12）

- 分支：`feat/library-manage-tools`（基线 `feat/migrate-prompt@57309b2`）
- 本轮修复提交：`ff16490`（父 `3cd17be`，8 文件 +223/−53）
- 独立复审：`0e03d05`（[library-manage-tools-review-round4.md](library-manage-tools-review-round4.md)，**verdict=pass**）
- 本轮集成收尾：本文件所在 commit（**docs-only**）
- 结论：t10 的两项修复经 t11 对抗复审通过（含旧版本沙箱逐条对照 + 2 条变异），文档与本轮实现一致；
  **t10 的改动尚未部署到当前 GUI**，部署需用户显式确认（见 §4；本任务未执行）。

---

## 1. 本轮改了什么

| 项 | 内容 | 位置 |
| --- | --- | --- |
| R-F3（修复） | 新增**共用只读预检** `preflightCreateTopic(dataDir, raw) → { topic, dir, exists }`：已存在**祖先段**是真目录→既有 realpath/包含复核；符号链接→`escape-rejected`（不放宽）；普通文件/其它非目录→**409 `target-exists`**（点名被占用的路径段）。目标自身同样分类（目录→幂等 `exists:true`；文件→409；链接→escape；不存在→交 `mkdir`）。`createTopic` 与 `POST /api/library/topic` 共用它（删掉两份内联祖先循环）。 | `src/library-manage.ts`、`src/host.ts` |
| UI 文案（修复） | `errText` 新增 `case 'layout-conflict': return t('delLayoutConflict')`；zh/en 字典各加文案：「论文文件夹与旧平铺文件并存，请先在『设置 → 论文伴读 → 查看论文状态』完成迁移」/ 对应英文。其余映射与文案未动（`git diff lib/client.js` = +5/0）。 | `lib/client.js` |
| 测试 | G7（工具：祖先段文件/深层 → 409 + 递归 sha256 零改动 + 真目录祖先仍可建多级）；P1b（既有路由 harness：祖先段文件/深层 → 409、零副作用；符号链接祖先 → 400 `escape-rejected`）；U4（client：分支 + zh/en 文案 + 既有映射仍在）。 | `test/library-manage-tools.test.mjs`、`test/integration-upstream-merge.test.mjs`、`test/reader-ux-t8.test.mjs` |

**既有语义未动**（详见 [repair §6](library-manage-tools-repair.md)）：符号链接祖先/目标的 realpath 三层防护与
`escape-rejected`、真目录幂等 200/`created:false`、词法层（`validateTopicPath` 深度/段长/`.trash`/编码变形）、
`assertInside`/realDataDir、上传路由；**审批门、迁移红线、工具输出 schema、`src/tools.ts` 零改动**。

**有意变更（已在 repair §6 / 本文件 §5 登记）**：

1. 路由「目标自身是普通文件」由 404 `not-found` 统一为 **409 `target-exists`**（与工具一致）；
2. 悬空符号链接祖先由「当成不存在 → mkdir 失败 500」变为 **400 `escape-rejected`**（收紧）；
3. 错误 body 的 `extra` 新增 `conflicts` 字段（点名被占用的路径段）。

## 2. 最终验证（提交后的 tip 上实测）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm test` | **647 tests / 611 pass / 0 fail / 36 skipped**（`pretest` 自动 build） |
| `node --test test/library-manage-tools.test.mjs` | **63/63**（0 skip） |
| `node test/mutation-probe.mjs --only LM` | 25/25（注入红 / 还原绿 / diff clean；t9 已复核，t11 复跑 38 条攻击 38/38） |
| `node --input-type=module` 动态 import `dist/index.js` + `apply(假 ctx)` | 注册 **8** 个工具，含 `library_manage`（7 action）；启动日志行同样列出 |
| `git status --porcelain` | 空 |
| 未 push / 未合并 | 无 upstream、`refs/remotes` 无本分支；`main`/`master` 不含 HEAD |

红线复核：`src/tools.ts` 仅 import `planMigration`/`formatMigrationReport`；`src/migrate.ts` 与基线零 diff；
工具层无迁移执行路径。

## 3. 文档一致性（本轮核对）

- [repair §6](library-manage-tools-repair.md)：本轮改了什么 / 为什么 / 哪些既有语义未动 / 验证；§4 残留 5 标注已修；
  t11 的 **T11-F1（§4.4/§5 旧数字）已修**：数字统一到当前 tip（647/611/0/36、本套件 63/63），
  并保留「t6 时点为 62/62、644/608」的历史标注，不再同文档两套数字。
- [integration §4/§6/§9](library-manage-tools-integration.md)：R-F3 与 UI 文案标为**已修**并指向本节；
  最终数字更新为 647/611/0/36、本套件 63/63；§5 补记「当前 GUI 跑的是 t5 构建」。
- [review-round4](library-manage-tools-review-round4.md)：verdict=pass；两条 low 中 T11-F1 本轮已修，
  **T11-F2（两条有意变更的路由行为缺回归用例）本轮不修**（t12 inScope 只含 docs/），如实登记在本文件 §5。
- 其余未修残留保持如实登记（见 §5），本轮未新增任何「已修」声明。

## 4. 部署方式（**需用户显式确认；本任务未执行**）

当前机器上有**两个**实际安装副本（均为 t5 时点构建：`dist/index.js` 含 `library_manage`，但
`dist/library-manage.js` **无** `preflightCreateTopic`、`lib/client.js` **无** `delLayoutConflict`）：

1. `~/.dsh/local/dsh-paper-reader`
2. `~/.dsh/profiles/web/node_modules/@ggboy123/dsh-paper-reader`

两处各自旁边已有旧备份 `*.bak-20261021095318`（部署前仍建议再备份一份带时间戳的）。
**t10 的改动必须覆盖这两处并重启**才生效；本任务只写文档，未执行任何部署动作。

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/library-manage-tools
npm run build                       # 产出最新 dist/
SRC="$PWD"
STAMP="$(date +%Y%m%d%H%M%S)"
for DST in \
  "$HOME/.dsh/local/dsh-paper-reader" \
  "$HOME/.dsh/profiles/web/node_modules/@ggboy123/dsh-paper-reader"
do
  [ -d "$DST" ] || { echo "skip (missing): $DST"; continue; }
  cp -a "$DST" "$DST.bak-$STAMP"                 # 回滚点
  rm -rf "$DST/dist"; cp -a "$SRC/dist" "$DST/dist"
  cp -a "$SRC/lib" "$SRC/presets" "$SRC/reader" "$DST/"
  cp -a "$SRC/package.json" "$SRC/cordis.patch.yml" "$DST/"
  cp -a "$SRC/README.md" "$SRC/README_EN.md" "$DST/"
done
```

3) 重启 dsh profile（或官方桌面端），浏览器/桌面端强刷一次（Cmd+Shift+R）。
4) 验收（建议逐条看）：
   - 启动日志出现 `[dsh-paper-reader] registered tools: …, library_manage`；
   - 在会话里对「祖先段是普通文件」的路径调 `library_manage(create_topic, topic:"<某文件>/sub")`：
     应返回 `[library_manage:target-exists]`（409），不再是 `not-found`；库内零变化；
   - 对混合布局（论文文件夹 + 同 stem 平铺残留）的一篇做删除/改名：应看到**新文案**
     「…请先在『设置 → 论文伴读 → 查看论文状态』完成迁移后再操作」，而不是原始错误串。
5) 回滚：把 `*.bak-$STAMP` 换回原位并重启。

> ⚠️ 部署属于用户显式确认的动作（会影响正在使用的 GUI）。请确认后由用户/队长执行；执行人可按上面步骤操作，
> 我未在 t12 中执行。

## 5. 残留风险（如实登记；未修项不因本轮而消失）

1. **T11-F2（low，未修）**：两条有意变更的路由行为（目标自身文件 404→409、悬空链接祖先 500→400）
   目前只有 t11 的对抗探针覆盖，**没有**进入 P1b 回归用例（t12 inScope 仅 docs/，不改 test/）。
   建议后续补进 `P1b`，避免未来回归。
2. **route 与 tool 只共用 preflight，`mkdir` 仍两处**：核心判定（词法/祖先/目标/realpath/冲突）已单一份；
   落盘动作各自执行属预期（工具与 HTTP 的响应/锁语义不同）。
3. **错误 body 新增 `conflicts` 字段**：前端未消费该字段（只按 `code` 分支），无兼容性影响；脚本调用方需知悉。
4. **悬空符号链接祖先的错误码变化**：500 `internal`（mkdir 失败）→ 400 `escape-rejected`；只影响病态输入。
5. **t10 改动未部署**：当前 GUI 仍跑 t5 构建（见 §4 首段），live 验收需按 §4 部署后执行。
6. 前几轮残留不变：混合态「异内容」判定、`clearTopic` 只清论文夹一半、preset 会话审批 UI 真机可达性、
   `displayReason` 在 0.2.x 的展示、跨进程并发、Windows/macOS 分支未实跑、`hasPdfMagic` 1KB 容忍。
