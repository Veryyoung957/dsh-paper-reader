// test/migrate-prompt.test.mjs — 「未迁移提示」（对话侧 + 界面侧）的**新行为**用例集。
//
// 为什么单独一个文件：t1 冻结方案（docs/migrate-prompt-plan.md §5）列了 P1–P23 的验收点与 M1–M8 的
// 变异靶子；本文件逐条给靶子，`test/mutation-probe.mjs` 里对应的变异必须让它们变红。
//
// 覆盖：
//   P0  判据与**权威报告**（planMigration + listPapers）在 12 个夹具上零差异 + 夹具指纹与 t1 探针逐字一致
//   P1–P15  判据/发问门的每一条行为（未迁移/已迁移/无标记新布局/拒绝/重新检查/只问一次/情况变了/
//           标记不符/残留/冲突/quarantine/不可读/库不存在/空库+孤儿）
//   P16–P19 四条红线（只提示不迁移 / 不许每次都问 / 不阻塞 / 只读不误报）
//   P20 缓存与失效   P21 i18n   P22 界面元素   P23 键不会被改名搬家搬走
//   P24 工具侧 en 文案（逐字冻结）  P25 真跑界面组件（横幅/卡片/报告弹层的行为）
//
// 只 import dist/*.js（跑前 `npm run build`）；破坏性实验一律 mkdtemp 临时库，绝不碰真实文献库。
// 偏好文件走 DPR_MIGRATE_PROMPT_STATE（夹具内的临时文件）；DSH_HOME 也指到临时目录。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')
const dist = (m) => join(REPO, 'dist', m)

/** 偏好文件绝不落到真实 ~/.dsh（每个夹具再单独覆盖 DPR_MIGRATE_PROMPT_STATE）。 */
const HOME = mkdtempSync(join(tmpdir(), 'dpr-mig-home-'))
process.env.DSH_HOME = HOME
process.env.DPR_MIGRATE_PROMPT_TTL_MS = '0'      // 默认不吃缓存：用例关心的是判据本身
delete process.env.DPR_MIGRATE_PROMPT
delete process.env.DPR_MIGRATE_PROMPT_LANG

const MP = await import(pathToFileURL(dist('migrate-prompt.js')).href)
const MG = await import(pathToFileURL(dist('migrate.js')).href)
const L = await import(pathToFileURL(dist('library.js')).href)
const { registerTools } = await import(pathToFileURL(dist('tools.js')).href)
const { registerRoutes } = await import(pathToFileURL(dist('host.js')).href)

const DONE = MG.DONE_MARKER
const PARTIAL = MG.PARTIAL_MARKER
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')

/* ═══════════════════════════════════════════════════════════════════════════
   夹具（与 t1 探针 .probe/migrate-prompt/probe-criterion.mjs 的 12 个逐字同构）
   ═══════════════════════════════════════════════════════════════════════════ */

function newLib() {
  const root = mkdtempSync(join(tmpdir(), 'dpr-mig-'))
  const data = join(root, 'data')
  const home = join(root, 'home')
  mkdirSync(data, { recursive: true })
  mkdirSync(home, { recursive: true })
  // 偏好文件按夹具隔离（同一个进程里跑 20+ 个夹具，绝不能互相污染）
  process.env.DPR_MIGRATE_PROMPT_STATE = join(home, 'migration-prompt.json')
  MP.invalidateMigrationPromptCache()
  return { root, data, home }
}
function writeAt(root, rel, body = PDF) {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, body)
}
/** 旧布局的一篇论文（pdf + txt + pages.json 三个平铺产物）。 */
function flatPaper(root, topic, stem, body = PDF) {
  writeAt(root, `${topic}/${stem}.pdf`, body)
  writeAt(root, `${topic}/${stem}.txt`, 'x'.repeat(2000))
  writeAt(root, `${topic}/${stem}.pages.json`, '[]')
}
/** 新布局的一篇论文（论文文件夹里同样的三个产物）。 */
function folderPaper(root, topic, stem) {
  writeAt(root, `${topic}/${stem}/${stem}.pdf`)
  writeAt(root, `${topic}/${stem}/${stem}.txt`, 'x'.repeat(2000))
  writeAt(root, `${topic}/${stem}/${stem}.pages.json`, '[]')
}
const LONG_STEM = 'L'.repeat(120)   // > MAX_PAPER_DIR_NAME(100) ⇒ 迁移判 quarantine

/**
 * 12 个夹具 —— `expect` 全部来自 t1 探针的**实测输出**（.probe/migrate-prompt/probe-criterion-output.txt），
 * 含 `fp`（指纹）：判据重写后必须与冻结原型**逐字一致**，否则「同一情况不重复问」的门会漂移。
 */
const FIXTURES = {
  'F1-flat-only': {
    build: (d) => { flatPaper(d, 'A', 'P1'); flatPaper(d, 'A', 'P2'); flatPaper(d, 'A/子专题B', 'P3') },
    expect: { state: 'unmigrated', papers: 3, files: 9, byClass: { flat: 3, residue: 0, conflict: 0, quarantine: 0 }, migratable: 3, certain: true, markerSync: 'none', level: 'ask', fp: '7b738cd0180b' },
  },
  'F2-migrated': {
    build: (d) => { folderPaper(d, 'A', 'P1'); folderPaper(d, 'A', 'P2'); folderPaper(d, 'A/子专题B', 'P3'); writeAt(d, DONE, '{}') },
    expect: { state: 'migrated', papers: 0, files: 0, byClass: { flat: 0, residue: 0, conflict: 0, quarantine: 0 }, migratable: 0, certain: true, markerSync: 'none', level: 'silent', fp: '3b2ef28aff8f' },
  },
  'F3-marker-mismatch': {
    build: (d) => { folderPaper(d, 'A', 'P1'); folderPaper(d, 'A', 'P2'); flatPaper(d, 'A', 'P9'); writeAt(d, DONE, '{}') },
    expect: { state: 'marker-mismatch', papers: 1, files: 3, byClass: { flat: 1, residue: 0, conflict: 0, quarantine: 0 }, migratable: 1, certain: true, markerSync: 'conflict', level: 'ask', fp: 'f2082021cf61' },
  },
  'F4-no-marker-new-layout': {
    build: (d) => { folderPaper(d, 'A', 'P1'); folderPaper(d, 'A', 'P2') },
    expect: { state: 'migrated', papers: 0, files: 0, byClass: { flat: 0, residue: 0, conflict: 0, quarantine: 0 }, migratable: 0, certain: true, markerSync: 'none', level: 'silent', fp: '3b2ef28aff8f' },
  },
  'F5-residue': {
    build: (d) => { folderPaper(d, 'A', 'P1'); flatPaper(d, 'A', 'P1'); folderPaper(d, 'A', 'P2') },
    expect: { state: 'residue', papers: 1, files: 3, byClass: { flat: 0, residue: 1, conflict: 0, quarantine: 0 }, migratable: 1, certain: true, markerSync: 'none', level: 'ask', fp: '53a7351699b4' },
  },
  'F6-conflict': {
    build: (d) => { folderPaper(d, 'A', 'P1'); writeAt(d, 'A/P1.pdf', Buffer.concat([PDF, Buffer.from('DIFFERENT')])); folderPaper(d, 'A', 'P2') },
    expect: { state: 'needs-manual', papers: 1, files: 1, byClass: { flat: 0, residue: 0, conflict: 1, quarantine: 0 }, migratable: 0, certain: true, markerSync: 'none', level: 'info', fp: 'a707799a5ef1' },
  },
  'F7-unreadable': {
    build: (d) => { flatPaper(d, 'A', 'P1'); flatPaper(d, 'B私有', 'P2'); chmodSync(join(d, 'B私有'), 0o000) },
    cleanup: (d) => chmodSync(join(d, 'B私有'), 0o755),
    // 子树读不进去 ⇒ 判据不完整：**不给篇数**（papers=1 只是「看得见的那部分」，不用于文案）
    expect: { state: 'unknown', papers: 1, files: 3, byClass: { flat: 1, residue: 0, conflict: 0, quarantine: 0 }, migratable: 1, certain: false, markerSync: 'none', level: 'info', fp: 'dbb6884ec11d' },
  },
  'F8-partial-quarantine': {
    build: (d) => { flatPaper(d, 'A', LONG_STEM); folderPaper(d, 'A', 'P1'); writeAt(d, PARTIAL, JSON.stringify({ partial: true, skipped: [`A/${LONG_STEM}`] })) },
    expect: { state: 'needs-manual', papers: 1, files: 3, byClass: { flat: 0, residue: 0, conflict: 0, quarantine: 1 }, migratable: 0, certain: true, markerSync: 'conflict', level: 'info', fp: 'a452f085cad5' },
  },
  'F9-orphan-only': {
    build: (d) => { folderPaper(d, 'A', 'P1'); writeAt(d, 'A/随手笔记.md', 'x'); writeAt(d, DONE, '{}') },
    expect: { state: 'migrated', papers: 0, files: 0, byClass: { flat: 0, residue: 0, conflict: 0, quarantine: 0 }, migratable: 0, certain: true, markerSync: 'none', level: 'silent', fp: '3b2ef28aff8f' },
  },
  'F10-empty': {
    build: () => {},
    expect: { state: 'empty', papers: 0, files: 0, byClass: { flat: 0, residue: 0, conflict: 0, quarantine: 0 }, migratable: 0, certain: true, markerSync: 'none', level: 'silent', fp: '3b2ef28aff8f' },
  },
  'F11-partial-flat': {
    build: (d) => { flatPaper(d, 'A', 'P1'); folderPaper(d, 'A', 'P2'); writeAt(d, PARTIAL, JSON.stringify({ partial: true, skipped: ['A/旧名'] })) },
    expect: { state: 'partial', papers: 1, files: 3, byClass: { flat: 1, residue: 0, conflict: 0, quarantine: 0 }, migratable: 1, certain: true, markerSync: 'conflict', level: 'ask', fp: '1108a5c095a0' },
  },
  'F12-stale-marker': {
    build: (d) => { folderPaper(d, 'A', 'P1'); folderPaper(d, 'A', 'P2'); writeAt(d, PARTIAL, JSON.stringify({ partial: true, skipped: ['A/旧名'] })) },
    expect: { state: 'migrated', papers: 0, files: 0, byClass: { flat: 0, residue: 0, conflict: 0, quarantine: 0 }, migratable: 0, certain: true, markerSync: 'stale', level: 'silent', fp: '3b2ef28aff8f' },
  },
}

function makeFixture(name) {
  const spec = FIXTURES[name]
  const lib = newLib()
  spec.build(lib.data)
  return lib
}
function cleanupFixture(lib) {
  // F7 会把子树 chmod 000：先恢复权限，否则连 rmSync 都删不掉
  try { chmodSync(join(lib.data, 'B私有'), 0o755) } catch { /* 不是那个夹具 */ }
  rmSync(lib.root, { recursive: true, force: true })
}

/** 判据（跳过缓存）+ 纯发问门（不写偏好）。 */
function decide(data) {
  const need = MP.detectMigrationNeed(data, { force: true })
  const idle = MP.idlePromptState()
  return { need, ...MP.decideMigrationPrompt(need, idle) }
}
function readState() { return MP.readPromptState() }
function writeState(patch) { return MP.writePromptState(patch) }
function resetState() { return MP.resetPromptState() }

/** 注册工具（registerTools 内部会 resolveDataDir；夹具的 data 目录都已存在）。 */
function makeTools(dataDir) {
  const tools = {}
  registerTools({ tools: { register: (x) => { tools[x.name] = x } } }, { dataDir })
  return tools
}

/* ═══════════════════════════════════════════════════════════════════════════
   P0 判据 vs 权威报告（12 个夹具）：分类、数字、指纹全部对齐
   ═══════════════════════════════════════════════════════════════════════════ */

test('P0 判据与权威报告（planMigration + listPapers）在 12 个夹具上零差异，且指纹与 t1 探针逐字一致', () => {
  const rows = []
  for (const [name, spec] of Object.entries(FIXTURES)) {
    const lib = newLib()
    try {
      spec.build(lib.data)
      const need = MP.detectMigrationNeed(lib.data, { force: true })
      const plan = MG.planMigration(lib.data, join(lib.root, 'fake-home'))
      const e = spec.expect
      assert.equal(need.state, e.state, `${name}: state`)
      assert.equal(need.papers, e.papers, `${name}: papers（还要收口的篇数，来自**实际扫描**）`)
      assert.equal(need.files, e.files, `${name}: files`)
      assert.deepEqual(need.byClass, e.byClass, `${name}: byClass`)
      assert.equal(need.migratable, e.migratable, `${name}: migratable`)
      assert.equal(need.certain, e.certain, `${name}: certain`)
      assert.equal(need.markerSync, e.markerSync, `${name}: markerSync`)
      assert.equal(need.fingerprint, e.fp, `${name}: fingerprint 必须与 t1 探针逐字一致（否则「同一情况不重复问」会漂移）`)
      assert.equal(MP.decideMigrationPrompt(need, MP.idlePromptState()).level, e.level, `${name}: level`)

      // 交叉核对（与 t1 探针同款）：算出来的篇数/分类必须与权威报告
      // （listPapers 的 legacy / plan 的 alreadyDone / conflicts / quarantine）逐类一致。
      // 优先级 = 探针里的回填顺序：quarantine（只有它知道「名建不出目录」）> conflict > residue > flat。
      const legacy = new Set(L.listPapers(lib.data).filter((p) => p.legacy).map((p) => (p.topic ? `${p.topic}/${p.name}` : p.name)))
      const residue = new Set(plan.alreadyDone.map((x) => dirname(x.to)))
      const conflict = new Set(plan.conflicts.map((c) => c.paper))
      const quarantine = new Set(plan.quarantine.map((q) => q.paper))
      const planClass = new Map()
      for (const p of legacy) planClass.set(p, 'flat')
      for (const p of residue) planClass.set(p, 'residue')
      for (const p of conflict) planClass.set(p, 'conflict')
      for (const p of quarantine) planClass.set(p, 'quarantine')
      const counts = { flat: 0, residue: 0, conflict: 0, quarantine: 0 }
      for (const v of planClass.values()) counts[v]++
      assert.equal(need.papers, planClass.size, `${name}: 篇数必须与 plan/listPapers 的并集一致（onlyPlan/onlyScan 都为空）`)
      assert.deepEqual(need.byClass, counts, `${name}: 分类必须与权威报告一致（classMismatch 为空）`)
      assert.equal(need.unreadable.length, plan.unreadable.length, `${name}: unreadable 数与 plan 一致`)
      rows.push(name)
    } finally {
      if (spec.cleanup) spec.cleanup(lib.data)
      rmSync(lib.root, { recursive: true, force: true })
    }
  }
  assert.equal(rows.length, 12, '12 个夹具都要跑到（少一个就是空转）')
})

/* ═══════════════════════════════════════════════════════════════════════════
   P1–P15 判据与发问门
   ═══════════════════════════════════════════════════════════════════════════ */

test('P1 未迁移库：list_papers 返回 level=ask、papers=3、文案含「还有 3 篇」，render 也带出提示', async () => {
  const lib = makeFixture('F1-flat-only')
  try {
    const tools = makeTools(lib.data)
    const out = await tools.list_papers.execute({}, {})
    assert.equal(out.migration.level, 'ask')
    assert.equal(out.migration.papers, 3)
    assert.equal(out.migration.files, 9)
    assert.equal(out.migration.askOnce, true)
    assert.equal(out.migration.reportTool, 'migration_report')
    assert.match(out.migration.text, /还有 3 篇论文的产物散落在专题目录里（共 9 个文件）/)
    assert.match(out.migration.text, /绝不会自动迁移/, '必须写明绝不自动迁移')
    assert.match(out.migration.text, /旧布局照常可用/, '必须写明不阻塞旧布局使用')
    assert.match(out.migration.ask_hint, /3 篇/, 'ask_hint 必须带正确的数字')
    // 列表内容不受提示影响（红线③）
    assert.deepEqual(out.papers, ['A/P1', 'A/P2', 'A/子专题B/P3'])
    assert.deepEqual(out.topics, ['A'])
    const rendered = tools.list_papers.output.render({}, out)[0].text
    assert.match(rendered, /文献库（/)
    assert.match(rendered, /还有 3 篇/)
    assert.equal(readState().choice, 'asked', 'ask 一旦给出，服务端必须立刻记为 asked')
  } finally { cleanupFixture(lib) }
})

test('P2 已迁移（有 .done）：level=silent、text 为空，render 不追加空行', async () => {
  const lib = makeFixture('F2-migrated')
  try {
    const tools = makeTools(lib.data)
    const out = await tools.list_papers.execute({}, {})
    assert.equal(out.migration.level, 'silent')
    assert.equal(out.migration.state, 'migrated')
    assert.equal(out.migration.text, '')
    assert.equal(out.migration.askOnce, false)
    const rendered = tools.list_papers.output.render({}, out)[0].text
    assert.ok(!rendered.endsWith('\n\n'), 'silent 不得追加空行')
    assert.equal(readState().choice, 'idle', 'silent 绝不许写偏好')
  } finally { cleanupFixture(lib) }
})

test('P3 无标记但已是新布局：不得误报（只看标记会在这里出错）', async () => {
  const lib = makeFixture('F4-no-marker-new-layout')
  try {
    const out = await makeTools(lib.data).list_papers.execute({}, {})
    assert.equal(out.migration.level, 'silent')
    assert.equal(out.migration.text, '')
    assert.equal(readState().choice, 'idle')
  } finally { cleanupFixture(lib) }
})

test('P4 拒绝后不再出现：对话侧降级为 info（text 为空），路由/卡片状态为 declined', async () => {
  const lib = makeFixture('F1-flat-only')
  try {
    const tools = makeTools(lib.data)
    const first = await tools.list_papers.execute({}, {})
    assert.equal(first.migration.level, 'ask')
    // 用户答「不用」
    const choice = await tools.migration_prompt_choice.execute({ choice: 'declined' }, {})
    assert.equal(choice.ok, true)
    assert.equal(choice.choice, 'declined')
    assert.equal(choice.willAsk, false)
    const second = await tools.list_papers.execute({}, {})
    assert.equal(second.migration.level, 'info')
    assert.equal(second.migration.reason, 'declined')
    assert.equal(second.migration.text, '', '拒绝后不得再往结果里塞提示')
    const rendered = tools.list_papers.output.render({}, second)[0].text
    assert.ok(!/布局提示/.test(rendered), '拒绝后工具文本里不得再出现布局提示')
  } finally { cleanupFixture(lib) }
})

test('P5 「重新检查」后再次出现（工具 recheck + 路由 DELETE 两条入口）', async () => {
  const lib = makeFixture('F1-flat-only')
  try {
    const tools = makeTools(lib.data)
    await tools.list_papers.execute({}, {})
    await tools.migration_prompt_choice.execute({ choice: 'declined' }, {})
    assert.equal((await tools.list_papers.execute({}, {})).migration.level, 'info')
    const re = await tools.migration_prompt_choice.execute({ choice: 'recheck' }, {})
    assert.equal(re.choice, 'idle')
    assert.equal(re.willAsk, true)
    const again = await tools.list_papers.execute({}, {})
    assert.equal(again.migration.level, 'ask', '重新检查之后必须能再问一次')
    assert.equal(again.migration.papers, 3)
    // 路由 DELETE 也是同一条路
    const boot = await bootRoutes(lib.data)
    try {
      await boot.postJson('/api/library/migrate-prompt', { choice: 'declined' })
      assert.equal((await boot.get('/api/library/migrate-prompt')).body.state.choice, 'declined')
      assert.equal((await boot.del('/api/library/migrate-prompt')).body.state.choice, 'idle')
      const after = await boot.get('/api/library/migrate-prompt')
      assert.equal(after.body.prompt.level, 'ask')
    } finally { boot.srv.close() }
  } finally { cleanupFixture(lib) }
})

test('P6 不许每次都问：同一 fingerprint 第二次调用不得为 ask', async () => {
  const lib = makeFixture('F1-flat-only')
  try {
    const tools = makeTools(lib.data)
    const a = await tools.list_papers.execute({}, {})
    const b = await tools.list_papers.execute({}, {})
    const c = await tools.transcribe_pdf // 不调用（transcribe 需要真 PDF）；这里只断言 list_papers 的第二次
    assert.equal(a.migration.level, 'ask')
    assert.equal(b.migration.level, 'info', '同一情况第二次绝不能再问（红线②）')
    assert.equal(b.migration.reason, 'already-asked')
    assert.equal(b.migration.text, '')
    assert.equal(c.name, 'transcribe_pdf')
    // 界面那份 GET 也必须看到同一个记忆（两边共用一个服务端状态）
    const boot = await bootRoutes(lib.data)
    try {
      const seen = await boot.get('/api/library/migrate-prompt')
      assert.equal(seen.body.state.choice, 'asked')
      assert.equal(seen.body.prompt.level, 'info')
    } finally { boot.srv.close() }
  } finally { cleanupFixture(lib) }
})

test('P7 情况变了可再问一次：新增一篇平铺论文 ⇒ ask 且 papers +1', async () => {
  const lib = makeFixture('F1-flat-only')
  try {
    const tools = makeTools(lib.data)
    const a = await tools.list_papers.execute({}, {})
    assert.equal(a.migration.papers, 3)
    flatPaper(lib.data, 'A', 'P4')            // 用户又放了一篇平铺论文
    const b = await tools.list_papers.execute({}, {})
    assert.equal(b.migration.level, 'ask', '库里情况变了必须能再问一次（指纹变了）')
    assert.equal(b.migration.papers, 4)
    assert.match(b.migration.text, /还有 4 篇/)
  } finally { cleanupFixture(lib) }
})

test('P8 标记与实际不符（.done 在、仍有平铺）：markerSync=conflict、ask、文案点明不一致', async () => {
  const lib = makeFixture('F3-marker-mismatch')
  try {
    const out = await makeTools(lib.data).list_papers.execute({}, {})
    assert.equal(out.migration.level, 'ask')
    assert.equal(out.migration.state, 'marker-mismatch')
    assert.equal(out.migration.markerSync, 'conflict')
    assert.equal(out.migration.papers, 1)
    assert.match(out.migration.text, /标记与磁盘不一致/)
    assert.match(out.migration.text, /以实际扫描为准/)
  } finally { cleanupFixture(lib) }
})

test('P9 残留（文件夹赢 + 平铺副本）：papers=1，且证明不是靠 listPapers().legacy', async () => {
  const lib = makeFixture('F5-residue')
  try {
    const legacy = L.listPapers(lib.data).filter((p) => p.legacy)
    assert.equal(legacy.length, 0, '夹具前提：listPapers 的 legacy 为 0（只看它就会漏报）')
    const out = await makeTools(lib.data).list_papers.execute({}, {})
    assert.equal(out.migration.level, 'ask')
    assert.equal(out.migration.papers, 1)
    assert.equal(out.migration.byClass.residue, 1)
  } finally { cleanupFixture(lib) }
})

test('P10 冲突（两边不同内容）：info 不发问、报告里列冲突、库未被改动', async () => {
  const lib = makeFixture('F6-conflict')
  try {
    const before = snapshotTree(lib.data)
    const tools = makeTools(lib.data)
    const out = await tools.list_papers.execute({}, {})
    assert.equal(out.migration.level, 'info')
    assert.equal(out.migration.reason, 'needs-manual')
    assert.equal(out.migration.papers, 1)
    assert.match(out.migration.text, /需要人工确认/)
    assert.equal(readState().choice, 'idle', '不发问的情形绝不许写偏好')
    const report = await tools.migration_report.execute({}, {})
    assert.equal(report.ok, true)
    assert.equal(report.plan.conflicts.length, 1)
    assert.match(report.plan.conflicts[0].reason, /不同/)
    assert.deepEqual(snapshotTree(lib.data), before, '干跑报告绝不许改动库')
  } finally { cleanupFixture(lib) }
})

test('P11 quarantine（名 >100 字符）：papers 取自扫描而不是 plan.totals.papers=0', async () => {
  const lib = makeFixture('F8-partial-quarantine')
  try {
    const plan = MG.planMigration(lib.data, join(lib.root, 'fake-home'))
    assert.equal(plan.totals.papers, 0, '夹具前提：权威报告的 totals.papers 会**少算成 0**（不能用它报数）')
    const out = await makeTools(lib.data).list_papers.execute({}, {})
    assert.equal(out.migration.level, 'info')
    assert.equal(out.migration.papers, 1)
    assert.equal(out.migration.byClass.quarantine, 1)
    assert.equal(out.migration.markerSync, 'conflict')
    assert.match(out.migration.text, /需要人工确认/)
    assert.match(out.migration.text, /上次的跳过项/)
  } finally { cleanupFixture(lib) }
})

test('P12 子树不可读：info、文本不含篇数、偏好文件未写', async () => {
  const lib = makeFixture('F7-unreadable')
  try {
    const out = await makeTools(lib.data).list_papers.execute({}, {})
    assert.equal(out.migration.level, 'info')
    assert.equal(out.migration.reason, 'unreadable')
    assert.equal(out.migration.certain, false)
    assert.equal(out.migration.papers, null, 'certain=false 时不得报篇数（避免误导）')
    assert.ok(!/还有 \d+ 篇/.test(out.migration.text), '不可读时不得声称「还有 N 篇」')
    assert.match(out.migration.text, /1 棵子树读不进去/)
    assert.equal(existsSync(process.env.DPR_MIGRATE_PROMPT_STATE), false, '不发问的情形绝不许写偏好文件')
  } finally { cleanupFixture(lib) }
})

test('P13 dataDir 不存在：silent，且**目录未被创建**（判据不许 mkdir）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dpr-mig-nodir-'))
  process.env.DPR_MIGRATE_PROMPT_STATE = join(root, 'state.json')
  const missing = join(root, 'data')
  try {
    const need = MP.detectMigrationNeed(missing, { force: true })
    const taken = MP.takeMigrationPrompt(need)
    assert.equal(need.state, 'empty')
    assert.equal(taken.level, 'silent')
    assert.equal(existsSync(missing), false, '判据绝不许创建 dataDir（红线④：只读时不得写盘）')
    assert.equal(existsSync(process.env.DPR_MIGRATE_PROMPT_STATE), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('P14/P15 空库 / 只有孤儿文件：silent', async () => {
  for (const name of ['F10-empty', 'F9-orphan-only']) {
    const lib = makeFixture(name)
    try {
      const out = await makeTools(lib.data).list_papers.execute({}, {})
      assert.equal(out.migration.level, 'silent', `${name} 不该有任何提示`)
      assert.equal(out.migration.text, '')
      assert.equal(readState().choice, 'idle')
    } finally { cleanupFixture(lib) }
  }
})

test('P26 次入口 transcribe_pdf（打开/读某篇论文）同样带提示，且与 list_papers 共用同一份「只问一次」', async () => {
  const lib = makeFixture('F1-flat-only')
  try {
    // 给 A/P1 造一份**命中缓存**的转录（走 cache 分支，不需要真解析 PDF）
    const text = 'Alpha locality matters. '.repeat(120)
    writeFileSync(join(lib.data, 'A', 'P1.txt'), text, 'utf8')
    writeFileSync(join(lib.data, 'A', 'P1.pages.json'), JSON.stringify({ pageCount: 1, pages: [{ page: 1, start: 0, end: text.length }] }), 'utf8')
    writeFileSync(join(lib.data, 'A', 'P1.transcript.json'), JSON.stringify({ v: 1, producer: 'pdfjs', createdAt: 'x', text: { chars: text.length, pageCount: 1 } }), 'utf8')
    const tools = makeTools(lib.data)
    const out = await tools.transcribe_pdf.execute({ topic: 'A', name: 'P1' }, {})
    assert.equal(out.source, 'cache')
    assert.equal(out.migration.level, 'ask', '打开/读论文这条路径也要提示（次入口）')
    assert.equal(out.migration.papers, 3)
    assert.match(tools.transcribe_pdf.output.render({}, out)[0].text, /还有 3 篇/)
    // 第二条路径（list_papers）立刻看到同一次发问 ⇒ 不会两边同时问
    const list = await tools.list_papers.execute({}, {})
    assert.equal(list.migration.level, 'info', '两个入口必须共用同一份「问过一次」的记忆')
    assert.equal(list.migration.reason, 'already-asked')
  } finally { cleanupFixture(lib) }
})

/* ═══════════════════════════════════════════════════════════════════════════
   四条红线
   ═══════════════════════════════════════════════════════════════════════════ */

test('P7b 指纹含分类：残留恶化为冲突必须能再问一次（只 hash 路径会让恶化被吞掉）', async () => {
  const lib = makeFixture('F5-residue')
  try {
    const tools = makeTools(lib.data)
    const a = await tools.list_papers.execute({}, {})
    assert.equal(a.migration.level, 'ask')
    assert.equal(a.migration.byClass.residue, 1)
    // 用户把平铺那份换成**不同内容**（同一篇、同一路径，但从 residue 恶化为 conflict）
    rmSync(join(lib.data, 'A', 'P1.txt'))
    rmSync(join(lib.data, 'A', 'P1.pages.json'))
    writeFileSync(join(lib.data, 'A', 'P1.pdf'), Buffer.concat([PDF, Buffer.from('DIFFERENT')]))
    const b = await tools.list_papers.execute({}, {})
    const need = MP.detectMigrationNeed(lib.data, { force: true })
    assert.equal(need.byClass.conflict, 1, '夹具前提：已经变成 conflict')
    assert.notEqual(need.fingerprint, a.migration.fingerprint, '分类必须进指纹（否则恶化不会被提示）')
    assert.equal(b.migration.papers, 1)
    assert.equal(b.migration.state, 'needs-manual')
  } finally { cleanupFixture(lib) }
})

test('P16 红线①：调三个新工具前后夹具库逐字节不变，且没有 migration-logs/ 新文件', async () => {
  const lib = makeFixture('F1-flat-only')
  try {
    const tools = makeTools(lib.data)
    const before = snapshotTree(lib.data)
    const logsBefore = countFiles(join(HOME, '.dsh-paper-reader', 'migration-logs'))
    await tools.list_papers.execute({}, {})
    const report = await tools.migration_report.execute({}, {})
    assert.equal(report.ok, true)
    await tools.migration_prompt_choice.execute({ choice: 'later' }, {})
    await tools.migration_prompt_choice.execute({ choice: 'declined' }, {})
    await tools.migration_prompt_choice.execute({ choice: 'recheck' }, {})
    assert.deepEqual(snapshotTree(lib.data), before, '提示路径**绝不**改动文献库（连 mtime 都不许变）')
    assert.equal(countFiles(join(HOME, '.dsh-paper-reader', 'migration-logs')), logsBefore, '不许产生迁移日志')
    // 红线①的结构性证据：工具层与判据模块**都不 import/调用**任何执行入口
    const importClause = (file) => (readFileSync(join(REPO, 'src', file), 'utf8').match(/import \{[\s\S]*?\} from '\.\/migrate\.ts'/) ?? [''])[0]
    assert.ok(importClause('tools.ts').includes('planMigration'), '工具层只能拿到只读预检')
    assert.ok(!/runMigration/.test(importClause('tools.ts')), '工具层不许 import 执行入口（变异 M5 的靶子）')
    assert.ok(!/runMigration/.test(importClause('migrate-prompt.ts')), '判据模块不许 import 执行入口')
  } finally { cleanupFixture(lib) }
})

test('P17 红线②：declined 是吸态（新论文出现也不问）；只有重新检查能回 idle', async () => {
  const lib = makeFixture('F1-flat-only')
  try {
    const tools = makeTools(lib.data)
    await tools.list_papers.execute({}, {})
    await tools.migration_prompt_choice.execute({ choice: 'declined' }, {})
    flatPaper(lib.data, 'A', 'P4')
    flatPaper(lib.data, 'A', 'P5')
    const out = await tools.list_papers.execute({}, {})
    assert.equal(out.migration.level, 'info', '拒绝后即使库变了也不许再问')
    assert.equal(out.migration.text, '')
    // later 则相反：库变了可以再问一次
    await tools.migration_prompt_choice.execute({ choice: 'recheck' }, {})
    await tools.list_papers.execute({}, {})
    await tools.migration_prompt_choice.execute({ choice: 'later' }, {})
    flatPaper(lib.data, 'A', 'P6')
    const later = await tools.list_papers.execute({}, {})
    assert.equal(later.migration.level, 'ask', 'later = 以后再说：库有变化时可再问一次')
  } finally { cleanupFixture(lib) }
})

test('P18 红线③：提示不阻塞旧布局——列表/打开论文照常；库不可读时也不抛', async () => {
  const lib = makeFixture('F1-flat-only')
  try {
    const tools = makeTools(lib.data)
    const list = await tools.list_papers.execute({}, {})
    assert.deepEqual(list.papers, ['A/P1', 'A/P2', 'A/子专题B/P3'], '旧布局论文必须照常列出')
    const out = await tools.list_papers.execute({ topic: 'A' }, {})
    assert.equal(out.migration.level, 'info')   // 已问过 ⇒ 安静
    const ref = L.resolvePaper(lib.data, { topic: 'A', name: 'P1' })
    assert.equal(ref.pdfPath, join(lib.data, 'A', 'P1.pdf'), '旧布局打开论文照常（平铺路径回落）')
    // 判据本身绝不抛：把**整个库**换成不可读目录
    if (canDenyRead) {
      const stateFile = process.env.DPR_MIGRATE_PROMPT_STATE
      const stateBefore = readFileSync(stateFile, 'utf8')
      chmodSync(lib.data, 0o000)
      try {
        const need = MP.detectMigrationNeed(lib.data, { force: true })
        assert.equal(need.certain, false)
        assert.equal(need.state, 'unknown')
        assert.deepEqual(need.unreadable, [{ dir: '.', cause: 'EACCES' }], '根读不进去要单列（漏掉根 = 静默当成空库）')
        const taken = MP.takeMigrationPrompt(need)
        assert.equal(taken.level, 'silent', '根都读不进去 ⇒ 完全不出声（方案 §2.5 第 1 行）')
        assert.equal(taken.text, '')
        // 界面侧那条路（GET 路由）同样不抛、同样不出声：横幅不渲染、卡片也不许说「已是新布局」
        const boot = await bootRoutes(lib.data)
        try {
          const r = await boot.get('/api/library/migrate-prompt')
          assert.equal(r.status, 200, r.txt)
          assert.equal(r.body.prompt.level, 'silent')
          assert.equal(r.body.prompt.reason, 'scan-failed')
          assert.equal(r.body.need.state, 'unknown')
        } finally { boot.srv.close() }
        // ⚠️ 方案 §2.5 与现实的一处偏差（已回报队长）：**列表**那条路在根不可读时本来就抛 EACCES
        //（listTopics 既有实现没有 try/catch，本批不改它——把它降级成「库为空」才是真误报）。
        // 这里固定住这个既有行为，并证明**提示**没有引入新的失败面。
        const tools = makeTools(lib.data)
        await assert.rejects(() => tools.list_papers.execute({}, {}), /EACCES/, '既有行为：根不可读时列表本来就报错（与提示无关）')
        assert.equal(readFileSync(stateFile, 'utf8'), stateBefore, '不出声的情形绝不许写偏好')
      } finally { chmodSync(lib.data, 0o755) }
    } else {
      // 平台不支持（Windows/root）：至少证明判据对「不存在的库」不抛
      const need = MP.detectMigrationNeed(join(lib.root, 'nope'), { force: true })
      assert.equal(need.state, 'empty')
    }
  } finally { cleanupFixture(lib) }
})

test('P19 红线④：偏好文件写不了（只读 HOME）⇒ 仍能问、且同一指纹仍只问一次、不报错', async () => {
  const lib = makeFixture('F1-flat-only')
  const roDir = mkdtempSync(join(tmpdir(), 'dpr-mig-ro-'))
  try {
    if (!canDenyWrite) {
      // 平台不支持只读目录（Windows/root）：退化为断言「写失败一律不抛 + 返回值如实」
      const w = MP.writePromptState({ choice: 'asked' })
      assert.equal(typeof w.ok, 'boolean')
      assert.equal(w.state.choice, 'asked')
      return
    }
    chmodSync(roDir, 0o500)                     // 可读可进、不可写
    process.env.DPR_MIGRATE_PROMPT_STATE = join(roDir, 'migration-prompt.json')
    MP.invalidateMigrationPromptCache()
    const tools = makeTools(lib.data)
    const a = await tools.list_papers.execute({}, {})
    assert.equal(a.migration.level, 'ask', '写不了偏好也必须照常提示（这是服务端的降级，不是用户的错）')
    const b = await tools.list_papers.execute({}, {})
    assert.equal(b.migration.level, 'info', '写盘失败要退回进程内记忆，同一指纹仍不许再问')
    assert.equal(b.migration.reason, 'already-asked')
    const choice = await tools.migration_prompt_choice.execute({ choice: 'declined' }, {})
    assert.equal(choice.choice, 'declined')
  } finally {
    try { chmodSync(roDir, 0o700) } catch { /* 已恢复 */ }
    rmSync(roDir, { recursive: true, force: true })
    cleanupFixture(lib)
  }
})

/* ═══════════════════════════════════════════════════════════════════════════
   P20 缓存与失效
   ═══════════════════════════════════════════════════════════════════════════ */

test('P20 缓存：TTL 内不重复扫；面向库的写操作让缓存失效（下一次重新扫）', async () => {
  const lib = makeFixture('F1-flat-only')
  process.env.DPR_MIGRATE_PROMPT_TTL_MS = '60000'
  try {
    MP.invalidateMigrationPromptCache()
    const s0 = MP.migrationScanStats.scans
    MP.detectMigrationNeed(lib.data)
    MP.detectMigrationNeed(lib.data)
    MP.detectMigrationNeed(lib.data)
    assert.equal(MP.migrationScanStats.scans, s0 + 1, 'TTL 内三次调用只扫一次（提示不许拖慢列表）')
    MP.invalidateMigrationPromptCache()
    MP.detectMigrationNeed(lib.data)
    assert.equal(MP.migrationScanStats.scans, s0 + 2, '显式失效后必须重扫')

    // 路由层：任何 /api/library 的写操作都会让判据缓存失效（上传/删除/改名/新建/清空/迁移/回滚）
    const boot = await bootRoutes(lib.data)
    try {
      MP.detectMigrationNeed(lib.data)
      const before = MP.migrationScanStats.scans
      const created = await boot.postJson('/api/library/topic', { name: 'B' })
      assert.equal(created.status, 200, created.txt)
      MP.detectMigrationNeed(lib.data)
      assert.equal(MP.migrationScanStats.scans, before + 1, '写操作后必须失效（否则提示数字会停在旧值）')
      const asked = await boot.get('/api/library/migrate-prompt')
      assert.equal(asked.body.ok, true)
      assert.equal(asked.body.need.dataDir, lib.data)
      // 逃生开关：运维/排障时判据直接 silent（不写偏好、不影响任何行为）
      process.env.DPR_MIGRATE_PROMPT = 'off'
      assert.equal(MP.takeMigrationPrompt(MP.detectMigrationNeed(lib.data)).level, 'silent')
      delete process.env.DPR_MIGRATE_PROMPT
    } finally { boot.srv.close() }
  } finally {
    process.env.DPR_MIGRATE_PROMPT_TTL_MS = '0'
    cleanupFixture(lib)
  }
})

/* ═══════════════════════════════════════════════════════════════════════════
   P21–P23 i18n / 界面元素 / 全局键
   ═══════════════════════════════════════════════════════════════════════════ */

const CLIENT_SRC = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
function dictOf(name) {
  const m = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n    \\}`).exec(CLIENT_SRC)
  assert.ok(m, `未找到 ${name} 字典`)
  return m[1]
}
/** 新增键必须 zh/en 双份（方案 §3.2 的 18 个 + migDone，逐字冻结）。 */
const MIG_KEYS = ['migBannerAsk', 'migBannerQuiet', 'migBannerDesc', 'migMarkerMismatch', 'migNeedsManual',
  'migUnknown', 'migMigrated', 'migDeclinedRow', 'migViewReport', 'migLater', 'migNever', 'migRecheck',
  'migReportTitle', 'migReportIntro', 'migConfirmHint', 'migExecute', 'migExecuting', 'migExecPartial',
  'migReportFail', 'migDone']

test('P21 i18n：新增键 zh/en 齐全、文案逐字冻结、中文里没有英文残留', () => {
  const zh = dictOf('zh')
  const en = dictOf('en')
  for (const k of MIG_KEYS) {
    assert.match(zh, new RegExp(`${k}: '[^']+'`), `zh 缺文案：${k}`)
    assert.match(en, new RegExp(`${k}: '[^']+'`), `en 缺文案：${k}`)
  }
  for (const [k, v] of [
    ['migViewReport', '查看迁移报告'], ['migLater', '以后再说'], ['migNever', '不再提醒'], ['migRecheck', '重新检查'],
    ['migExecute', '确认执行迁移'], ['migMigrated', '文献库已是新布局（按论文分文件夹）。'],
    ['migDeclinedRow', '已选择暂不迁移（不会再主动询问）'],
  ]) assert.ok(zh.includes(`${k}: '${v}'`), `zh 文案与冻结值不一致：${k}`)
  for (const [k, v] of [
    ['migViewReport', 'View migration report'], ['migLater', 'Not now'], ['migNever', 'Don\\\'t ask again'],
    ['migRecheck', 'Re-check'], ['migExecute', 'Execute migration'],
  ]) assert.ok(en.includes(`${k}: '${v}'`), `en 文案与冻结值不一致：${k}`)
  for (const k of ['migBannerAsk', 'migBannerQuiet', 'migMarkerMismatch', 'migNeedsManual', 'migUnknown', 'migExecPartial']) {
    assert.match(zh, new RegExp(`${k}: '[^']*\\{n\\}`), `zh 的 ${k} 必须带 {n}`)
    assert.match(en, new RegExp(`${k}: '[^']*\\{n\\}`), `en 的 ${k} 必须带 {n}`)
  }
  assert.match(zh, /migUnknown: '[^']*棵子树/, 'migUnknown 的 {n} 是**子树棵数**，不得与「还有 N 篇」混用')
})

test('P22 界面元素：横幅/卡片/报告弹层的构件与执行门（源码级 + 纯函数级）', () => {
  // 插入点：横幅只在 wide 分支（rail 态放不下，由设置卡片兜底）
  const wideAt = CLIENT_SRC.indexOf('const tree = wide === false')
  const railStart = CLIENT_SRC.indexOf("? h('div', { style: S.rail }")
  const railEnd = CLIENT_SRC.indexOf(': h(React.Fragment, null,')
  const bannerAt = CLIENT_SRC.indexOf('h(MigrationBanner, null)')
  const rowsAt = CLIENT_SRC.indexOf('(lib?.tree ?? topics.map')
  assert.ok(wideAt >= 0 && railStart > wideAt && railEnd > railStart && bannerAt > railEnd, '横幅必须在 wide 分支内、rail 分支之后')
  assert.ok(!CLIENT_SRC.slice(railStart, railEnd).includes('MigrationBanner'), 'rail 态不渲染横幅')
  assert.ok(bannerAt < rowsAt, '横幅要插在树行之前')
  assert.match(CLIENT_SRC, /data-dsh-part': 'migration-banner'/)
  assert.match(CLIENT_SRC, /data-dsh-part': 'migration-card'/)
  assert.match(CLIENT_SRC, /data-dsh-part': 'migration-report'/)
  assert.match(CLIENT_SRC, /'data-dpr-mig-exec'/)
  assert.match(CLIENT_SRC, /disabled: busy \|\| !dprMigrateExecEnabled\(confirmInput\)/, '执行按钮必须默认 disabled，输入 migrate 才启用')
  assert.match(CLIENT_SRC, /confirm: 'migrate-library'/, '唯一执行入口必须带既有那道 confirm 门')
  assert.match(CLIENT_SRC, /h\(MigrationCard, null\),\s*\n\s*h\(EndpointCard, \{/, '设置卡片必须放在设置面板最前（它是状态不是配置）')

  // 纯函数：执行门的逐格行为
  const pure = loadClientPure()
  assert.equal(pure.execEnabled(''), false)
  assert.equal(pure.execEnabled('migrate'), true)
  assert.equal(pure.execEnabled('migrate '), false, '必须逐字（不许 trim 放宽）')
  assert.equal(pure.execEnabled('MIGRATE'), false)
  assert.equal(pure.key, 'dpr.migratePrompt')
  // 横幅显隐矩阵（§3.5）
  assert.equal(pure.bannerMode('ask', 'idle'), 'ask')
  assert.equal(pure.bannerMode('info', 'asked'), 'quiet')
  assert.equal(pure.bannerMode('info', 'later'), 'quiet')
  assert.equal(pure.bannerMode('info', 'declined'), 'hidden', '拒绝后横幅必须消失')
  assert.equal(pure.bannerMode('silent', 'idle'), 'hidden')
  assert.equal(pure.bannerMode(null, 'idle'), 'hidden')
  assert.equal(pure.bannerMode('info', 'declined'), 'hidden')
  // 状态文案选择
  assert.equal(pure.statusKey('silent', 'migrated', 'idle'), 'migMigrated')
  assert.equal(pure.statusKey('silent', 'empty', 'idle'), 'empty')
  assert.equal(pure.statusKey('silent', 'unknown', 'idle'), null, '根读不进去 ⇒ 界面也不许说「已是新布局」')
  assert.equal(pure.statusKey('info', 'unknown', 'asked'), 'migUnknown')
  assert.equal(pure.statusKey('info', 'needs-manual', 'asked'), 'migNeedsManual')
  assert.equal(pure.statusKey('info', 'unmigrated', 'asked'), 'migBannerQuiet')
  assert.equal(pure.statusKey('info', 'unmigrated', 'declined'), 'migDeclinedRow')
  assert.equal(pure.statusKey('ask', 'unmigrated', 'idle'), 'migBannerAsk')
})

test('P23 全局键不会被改名搬家搬走：真跑 migrateLsKeys 后 dpr.migratePrompt 仍在', () => {
  const store = new Map()
  store.set('dpr.migratePrompt', JSON.stringify({ choice: 'declined' }))
  store.set('dpr.variant.T1/P1', 'split')
  store.set('dpr.sessionN.T1/P1', '3')
  store.set('dpr.last', JSON.stringify({ topic: 'T1', name: 'P1' }))
  const migrate = loadMigrateLsKeys(store)
  migrate('T1', 'T2', 'P1', 'P2')
  assert.equal(store.get('dpr.migratePrompt'), JSON.stringify({ choice: 'declined' }), '论文改名不得丢「已询问/已拒绝」')
  assert.equal(store.get('dpr.variant.T2/P2'), 'split', '正对照：按篇键照常搬家')
  migrate('T2', 'T3', null, null)
  assert.equal(store.get('dpr.migratePrompt'), JSON.stringify({ choice: 'declined' }), '专题改名/移动不得丢')
  assert.equal(store.get('dpr.variant.T3/P2'), 'split')
  assert.equal(store.get('dpr.sessionN.T3/P2'), '3')
  assert.ok(!/localStorage\.clear\(\)/.test(CLIENT_SRC), '全库不得有 localStorage.clear()')
})

test('P24 工具侧 en 文案（DPR_MIGRATE_PROMPT_LANG=en）逐字冻结，且数字正确', async () => {
  const lib = makeFixture('F1-flat-only')
  process.env.DPR_MIGRATE_PROMPT_LANG = 'en'
  try {
    const out = await makeTools(lib.data).list_papers.execute({}, {})
    assert.equal(out.migration.level, 'ask')
    assert.match(out.migration.text, /\[Layout notice\] Your library still uses the old flat layout: 3 paper\(s\) are not in their own folders yet \(9 files\)\./)
    assert.match(out.migration.text, /never migrate automatically/)
    assert.match(out.migration.text, /blocks nothing/)
    assert.match(out.migration.ask_hint, /3 paper\(s\)/)
  } finally {
    delete process.env.DPR_MIGRATE_PROMPT_LANG
    cleanupFixture(lib)
  }
})

/* ═══════════════════════════════════════════════════════════════════════════
   P25 真跑界面组件（伪 React 渲染生产代码本身）
   ═══════════════════════════════════════════════════════════════════════════ */

const ASK_SNAP = {
  need: {
    state: 'unmigrated', papers: 3, files: 9, migratable: 3, certain: true, markerSync: 'none',
    fingerprint: 'fp-3', unreadable: [], byClass: { flat: 3, residue: 0, conflict: 0, quarantine: 0 },
  },
  prompt: { level: 'ask', reason: 'unmigrated', text: '【布局提示】…还有 3 篇…' },
}

test('P25 真跑界面：横幅按状态渲染、拒绝后消失、重新检查再现；卡片状态行与执行门逐格可查', async () => {
  const store = new Map()
  // 第一帧镜像（不等网络）：服务端状态 + 上次的 need/prompt
  store.set('dpr.migratePrompt', JSON.stringify({ choice: 'idle', snap: ASK_SNAP }))
  store.set('dpr.mode', 'paper')
  const getData = { need: ASK_SNAP.need, prompt: ASK_SNAP.prompt, state: { choice: 'idle', at: null, by: null, declaredPapers: 3, fingerprint: 'fp-3' } }
  const routes = {
    'GET /library/migrate-prompt': () => getData,
    'DELETE /library/migrate-prompt': () => ({ ok: true, state: { choice: 'idle' }, willAsk: true }),
    'POST /library/migrate-prompt': (opts) => ({ ok: true, state: { choice: JSON.parse(opts.body).choice }, willAsk: false }),
    'GET /library/migrate-plan': () => ({
      ok: true,
      plan: {
        moves: 3, alreadyDone: 0, orphans: 0, conflicts: [], quarantine: [], unreadable: [],
        totals: { papers: 3, files: 9, bytes: 6414, needBytes: 7697 },
      },
      report: '待迁移：3 篇 / 9 个文件',
    }),
  }
  const ui = loadClientUi({ store, routes })
  try {
    // ① 横幅：ask 态
    let b = ui.renderBanner()
    assert.equal(b.out.props['data-dpr-mig-mode'], 'ask')
    assert.ok(b.texts.includes('migBannerAsk'), `横幅必须显示询问文案键：${b.texts.join(' | ')}`)
    assert.ok(b.texts.includes('migViewReport') && b.texts.includes('migLater') && b.texts.includes('migNever'))
    assert.ok(b.texts.includes('migBannerDesc'))
    assert.equal(b.byAct('report').props.children, 'migViewReport')
    const askedCalls = ui.calls.filter((c) => c.method === 'POST' && c.path === '/library/migrate-prompt')
    await TICKS()
    assert.ok(askedCalls.some((c) => JSON.parse(c.body).choice === 'asked'), '横幅渲染出问句后必须立刻回写 asked')

    // ② 用户点「不再提醒」→ 写服务端 + 横幅消失
    b.byAct('never').props.onClick()
    await TICKS()
    assert.ok(ui.calls.some((c) => c.method === 'POST' && JSON.parse(c.body).choice === 'declined'))
    const hidden = ui.renderBanner()
    assert.equal(hidden, null, '拒绝后横幅必须消失（红线②）')

    // ③ 设置卡片：状态行 + 重新检查
    const card = ui.renderCard()
    assert.equal(card.out.props['data-dpr-mig-status'], 'migDeclinedRow')
    assert.ok(card.texts.includes('migDeclinedRow'))
    assert.ok(card.byAct('recheck') && card.byAct('report'))
    assert.equal(card.byAct('never'), null, '已拒绝时不再显示「不再提醒」')

    // ④ 「重新检查」→ 服务端回 idle + 重新扫描 → 横幅再现（下面的 GET 换回 ask 态）
    card.byAct('recheck').props.onClick()
    await TICKS()
    assert.ok(ui.calls.some((c) => c.method === 'DELETE' && c.path === '/library/migrate-prompt'))
    assert.equal(ui.renderBanner().out.props['data-dpr-mig-mode'], 'ask', '重新检查后横幅必须再现')

    // ⑤ 报告弹层：只读预检 + 执行门（未输入 migrate 时 disabled）
    ui.renderCard().byAct('report').props.onClick()      // 打开报告
    ui.renderCard()                                       // 重新渲染：弹层元素出现
    const dlgNode = ui.findDialog()
    assert.ok(dlgNode, '「查看迁移报告」必须渲染出弹层')
    ui.renderDialog(dlgNode)                              // 触发只读预检
    await TICKS()
    const d = ui.renderDialog(dlgNode)
    assert.ok(d.texts.includes('migReportTitle'))
    assert.ok(d.texts.includes('migConfirmHint'))
    assert.ok(ui.calls.some((c) => c.path === '/library/migrate-plan'), '弹层必须走既有只读预检路由')
    assert.equal(d.exec.props.disabled, true, '未输入 migrate 时执行按钮必须 disabled')
    d.confirm.props.onChange({ target: { value: 'migrate' } })
    const d2 = ui.renderDialog(dlgNode)
    assert.equal(d2.exec.props.disabled, false, '输入 migrate 后才可以点')
    d2.confirm.props.onChange({ target: { value: 'migrate2' } })
    assert.equal(ui.renderDialog(dlgNode).exec.props.disabled, true, '输错就不许点')
    assert.ok(d2.intro, '报告顶部必须有要点行（migReportIntro）')
    assert.match(d2.texts.join(' | '), /待迁移：3 篇 \/ 9 个文件/, '弹层必须显示只读预检拿到的原文报告')
    assert.match(d2.texts.join(' | '), /migConfirmHint/)
  } finally {
    ui.dispose()
    try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 无所谓 */ }
  }
})

/* ═══════════════════════════════════════════════════════════════════════════
   工具
   ═══════════════════════════════════════════════════════════════════════════ */

/** 平台能力探测：能不能真的「读不进去」/「写不进去」（root 与 Windows 上不能）。 */
const canDenyRead = (() => {
  const d = mkdtempSync(join(tmpdir(), 'dpr-mig-read-'))
  try {
    mkdirSync(join(d, 'x'))
    chmodSync(join(d, 'x'), 0o000)
    try { readdirSync(join(d, 'x')); return false } catch { return true }
  } finally {
    try { chmodSync(join(d, 'x'), 0o700) } catch { /* 已恢复 */ }
    rmSync(d, { recursive: true, force: true })
  }
})()
const canDenyWrite = (() => {
  const d = mkdtempSync(join(tmpdir(), 'dpr-mig-write-'))
  try {
    chmodSync(d, 0o500)
    try { writeFileSync(join(d, 'x'), 'x'); return false } catch { return true }
  } finally {
    try { chmodSync(d, 0o700) } catch { /* 已恢复 */ }
    rmSync(d, { recursive: true, force: true })
  }
})()

/** 库的「逐字节指纹」：相对路径 + size + mtimeMs（改了任何东西都会变）。 */
function snapshotTree(dir) {
  const out = []
  const walk = (rel) => {
    const abs = rel ? join(dir, rel) : dir
    for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(r)
      else { const st = statSync(join(dir, r)); out.push(`${r}|${st.size}|${st.mtimeMs}`) }
    }
  }
  walk('')
  return out
}
function countFiles(dir) {
  if (!existsSync(dir)) return 0
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(join(dir, e.name))
    else n++
  }
  return n
}

async function bootRoutes(dataDir) {
  let spec = null
  registerRoutes({
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: { list: async () => ({ items: [] }) },
    workspaceController: {}, workspaceRegistry: {}, effect: (fn) => fn(),
  }, { dataDir })
  const srv = createServer((req, res) => spec.handler(req, res))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}/paper-reader`
  const call = async (p, method, body) => {
    const r = await fetch(base + p, method === 'GET' ? undefined : {
      method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const txt = await r.text()
    let parsed = null
    try { parsed = JSON.parse(txt) } catch { /* 非 JSON */ }
    return { status: r.status, body: parsed, txt }
  }
  return { srv, get: (p) => call(p, 'GET'), postJson: (p, b) => call(p, 'POST', b), del: (p) => call(p, 'DELETE') }
}

/** 伪 React（只实现本文件渲染要用的那点东西）。state 按「组件名#hook 序号」分岛：
    同一个进程里要渲染横幅/卡片/弹层三个不同组件，不能共用一套游标。 */
function makeFakeReact() {
  const cells = new Map()
  let current = 'root'
  let cursor = 0
  let effects = []
  const React = {
    Fragment: Symbol('dpr-fragment'),
    createElement(type, props, ...kids) {
      const children = kids.length === 0 ? undefined : kids.length === 1 ? kids[0] : kids
      return { type, props: { ...(props || {}), children } }
    },
    useRef(init) { return { current: init } },
    useState(init) {
      const k = `${current}#${cursor++}`
      if (!cells.has(k)) cells.set(k, typeof init === 'function' ? init() : init)
      return [cells.get(k), (v) => { cells.set(k, typeof v === 'function' ? v(cells.get(k)) : v) }]
    },
    useEffect(fn) { effects[cursor++] = fn },
    useCallback(fn) { cursor++; return fn },
    useMemo(fn) { cursor++; return fn() },
  }
  return {
    React,
    /** 开始渲染某个组件（重置游标）；返回本次渲染收集到的 effects 快照。 */
    begin(name) { current = name; cursor = 0; effects = []; return () => effects.slice() },
  }
}
function fakeLocalStorage(store) {
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
    get length() { return store.size },
    key: (i) => [...store.keys()][i] ?? null,
  }
}
function findNode(node, pred) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const n of node) { const hit = findNode(n, pred); if (hit) return hit }
    return null
  }
  if (pred(node)) return node
  return findNode(node.props && node.props.children, pred)
}
function collectStrings(node, out = []) {
  if (typeof node === 'string') { out.push(node); return out }
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) collectStrings(n, out); return out }
  collectStrings(node.props && node.props.children, out)
  return out
}
const TICKS = () => new Promise((r) => setTimeout(r, 5))

/** 执行 lib/client.js 顶层，取「未迁移提示」的纯函数。 */
let PURE = null
function loadClientPure() {
  if (PURE) return PURE
  let loaded = null
  const ctx = { window: { __ModuleLoader__: { load: (m) => { loaded = m } } }, console }
  vm.createContext(ctx)
  vm.runInContext(readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
    + '\n;globalThis.__dprMigPure = { key: DPR_MIGRATE_PROMPT_KEY, bannerMode: dprMigrateBannerMode, statusKey: dprMigrateStatusKey, execEnabled: dprMigrateExecEnabled };', ctx, { filename: 'client-mig-pure.js' })
  assert.ok(loaded && typeof loaded.factory === 'function', 'client.js 必须通过 __ModuleLoader__.load 注册模块')
  PURE = ctx.__dprMigPure
  return PURE
}
/** 真跑 lib/client.js 里的 migrateLsKeys（改名搬家的唯一实现）。 */
function loadMigrateLsKeys(store) {
  const src = CLIENT_SRC
  const at = src.search(/function\s+migrateLsKeys\s*\(/)
  assert.ok(at >= 0, 'lib/client.js 里必须有 migrateLsKeys')
  const braceAt = src.indexOf('{', at)
  let depth = 0; let i = braceAt; let kind = 'code'
  while (i < src.length) {
    const c = src[i]; const n = src[i + 1]
    if (kind === 'code') {
      if (c === '/' && n === '/') { kind = 'line'; i += 2; continue }
      if (c === '/' && n === '*') { kind = 'block'; i += 2; continue }
      if (c === '"' || c === "'" || c === '`') { kind = c; i += 1; continue }
      if (c === '{') depth += 1
      else if (c === '}') { depth -= 1; if (depth === 0) break }
    } else if (kind === 'line') { if (c === '\n') kind = 'code' } else if (kind === 'block') { if (c === '*' && n === '/') { kind = 'code'; i += 2; continue } } else { if (c === '\\') { i += 2; continue } if (c === kind) kind = 'code' }
    i += 1
  }
  const decl = src.slice(at, braceAt) + src.slice(braceAt, i + 1)
  const ctx = { localStorage: fakeLocalStorage(store), JSON, console }
  vm.createContext(ctx)
  vm.runInContext(`${decl}\n;globalThis.__migrate = migrateLsKeys;`, ctx, { filename: 'migrate-inline.js' })
  assert.equal(typeof ctx.__migrate, 'function')
  return ctx.__migrate
}

/** 真跑 `apply()`，拿到注册进 settings.section / sidebar.workspaces 的真组件，再用伪 React 渲染。 */
function loadClientUi({ store = new Map(), routes = {} } = {}) {
  const { React, begin } = makeFakeReact()
  let loaded = null
  const calls = []
  const fetchStub = async (url, opts) => {
    const path = String(url).replace('/paper-reader/api', '')
    const method = (opts && opts.method) || 'GET'
    calls.push({ path: path.split('?')[0], method, body: opts && opts.body })
    const key = `${method} ${path.split('?')[0]}`
    const h = routes[key]
    assert.ok(h, `未 stub 的路由：${key}`)
    const data = typeof h === 'function' ? h(opts || {}, path) : h
    return { ok: true, status: 200, json: async () => data }
  }
  const win = {
    __ModuleLoader__: { load: (m) => { loaded = m } },
    _handlers: {},
    addEventListener(t, h) { (win._handlers[t] ||= []).push(h) },
    removeEventListener(t, h) { if (win._handlers[t]) win._handlers[t] = win._handlers[t].filter((x) => x !== h) },
  }
  const registered = []
  const ctx = {
    window: win,
    localStorage: fakeLocalStorage(store),
    fetch: fetchStub,
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    document: {
      body: {},
      getElementById: () => null,
      createElement: () => ({ style: {}, textContent: '', setAttribute() {}, appendChild() {} }),
      head: { appendChild() {} },
      addEventListener() {},
    },
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(readFileSync(join(REPO, 'lib', 'client.js'), 'utf8'), ctx, { filename: 'client-mig-ui.js' })
  assert.ok(loaded && typeof loaded.factory === 'function', 'client.js 必须通过 __ModuleLoader__.load 注册模块')
  // createPortal 用**恒等** stub：弹层元素仍留在树里，测试才看得见（生产里挂 document.body）
  const mod = loaded.factory((name) => (name === 'react' ? React : { createPortal: (node) => node }))
  mod.apply({
    effect: (fn) => { fn(); return () => {} },
    locale: { register: () => {}, bind: () => (k) => k },
    layout: {}, uiWorkspace: {}, sidebarRight: {}, sidebarRightTabs: { register: () => {} },
    theme: {},
    slots: { inject: (name, fn) => { fn() }, register: (def, comp) => { registered.push({ def, comp }); return () => {} } },
  })
  const panel = registered.find((r) => r.def && r.def.name === 'settings.section')
  assert.ok(panel, '必须有 settings.section 注册')
  const section = registered.find((r) => r.def && r.def.name === 'sidebar.workspaces')
  assert.ok(section, 'paper 模式下必须有 sidebar.workspaces 注册（横幅挂在文献库树里）')

  const render = (name, node, runEffects) => {
    const eff = begin(name)
    const out = node.type(node.props)
    if (runEffects) for (const fn of eff()) if (typeof fn === 'function') fn()
    const texts = collectStrings(out)
    const byAct = (act) => findNode(out, (n) => n.props && n.props['data-dpr-mig'] === act)
    return { out, texts, byAct }
  }
  const bannerNode = () => {
    const lib = section.comp({ wide: true })
    begin('LibraryTree')                       // 只渲染，不跑它的 effects（避免 30s 轮询与 api 调用）
    const tree = lib.type(lib.props)
    return findNode(tree, (n) => typeof n.type === 'function' && n.type.name === 'MigrationBanner')
  }
  const cardNode = () => findNode(panel.comp(), (n) => typeof n.type === 'function' && n.type.name === 'MigrationCard')
  const last = { banner: undefined, card: undefined }
  return {
    calls, store,
    /** 横幅（返回 null = 组件自己返回 null = 界面上不渲染）。 */
    renderBanner() {
      const node = bannerNode()
      const r = render('MigrationBanner', node, true)
      last.banner = r.out
      return r.out === null ? null : r
    },
    renderCard() {
      const r = render('MigrationCard', cardNode(), true)
      last.card = r.out
      return r
    },
    findDialog() {
      const pred = (n) => typeof n.type === 'function' && n.type.name === 'MigrationReportDialog'
      return findNode(last.card ?? null, pred) ?? findNode(last.banner ?? null, pred) ?? null
    },
    renderDialog(node) {
      const r = render('MigrationReportDialog', node, true)
      return {
        texts: r.texts,
        exec: findNode(r.out, (n) => n.props && 'data-dpr-mig-exec' in n.props),
        confirm: findNode(r.out, (n) => n.props && 'data-dpr-mig-confirm' in n.props),
        intro: findNode(r.out, (n) => n.props && 'data-dpr-mig-intro' in n.props),
      }
    },
    dispose() { /* 没有真实副作用需要收 */ },
  }
}
