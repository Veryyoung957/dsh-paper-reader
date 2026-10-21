// .probe/t4/probes.mjs — t4 评审**自造**对抗探针（不复用实现方 test/ 的任何断言）。
//
// 目的：独立验证「破坏性动作必须经 DSH 用户审批」「非 allowed-once 零副作用」「路径安全（符号链接/TOCTOU）」
//       「破坏性正确性（产物完整 / 回收站一致 / 并发）」。
//
// 用法：node .probe/t4/probes.mjs [--only PREFIX]
// 依赖：先在检出里 `npm run build`（本脚本只 import dist/*.js，与 npm test 同口径）。
// 每条探针独立建临时库；「零副作用」用递归 sha256 快照（含 .trash）判定，不看实现自述。
// 退出码：0 = 全部 PASS；1 = 有 FAIL（并打印每条 FAIL 的断言细节）。

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const dist = (m) => join(REPO, 'dist', m)
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 't4-home-'))
delete process.env.DPR_LIBRARY_MANAGE_LANG

const LM = await import(pathToFileURL(dist('library-manage.js')).href)
const { ManageError } = LM
const { registerTools } = await import(pathToFileURL(dist('tools.js')).href)
const { createLibraryGuards } = await import(pathToFileURL(dist('library-guards.js')).href)
const LIB = await import(pathToFileURL(dist('library.js')).href)

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

/** 递归快照（相对路径 → [dir] / [symlink:t] / sha256）；含 .trash。 */
function snap(dir) {
  const out = {}
  const walk = (d, rel) => {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch (e) { out[rel || '.'] = `[unreadable:${e.code}]`; return }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      const st = lstatSync(p)
      if (st.isSymbolicLink()) { out[r] = `[symlink:${readlinkSync(p)}]`; continue }
      if (st.isDirectory()) { out[r] = '[dir]'; walk(p, r) } else out[r] = sha256(p)
    }
  }
  walk(dir, '')
  return out
}

const mkLib = () => {
  const root = mkdtempSync(join(tmpdir(), 't4-lib-'))
  const data = join(root, 'data')
  mkdirSync(data, { recursive: true })
  return { root, data }
}
const PDF = (tag) => `%PDF-1.4\n% ${tag}\n%%EOF\n`

function newPaper(data, topic, name, { extra = {}, suffixes } = {}) {
  const dir = join(data, topic, name)
  mkdirSync(dir, { recursive: true })
  const sfx = suffixes ?? ['.pdf', '.txt', '.pages.json', '.transcript.json', '.mineru.md', '.mineru.json', '.embeddings.json', '.study.json']
  for (const s of sfx) writeFileSync(join(dir, name + s), s === '.pdf' ? PDF(`${topic}/${name}`) : `cache:${name}${s}`)
  writeFileSync(join(dir, name + '-zh.pdf'), `variant:${name}`)
  for (const [f, c] of Object.entries(extra)) writeFileSync(join(dir, f), c)
  return dir
}

/** 审批替身：默认 allowed-once；可切四态 / 抛错 / 挂起 / 自定义返回值。 */
function fakeApproval(initial = 'allowed-once') {
  const requests = []
  const state = { outcome: initial, throws: false, gate: null, custom: undefined, useCustom: false }
  return {
    requests,
    state,
    service: {
      request: async (req) => {
        requests.push(req)
        if (state.gate) await state.gate
        if (state.throws) throw new Error('approval backend exploded')
        if (state.useCustom) return state.custom
        return state.outcome
      },
    },
  }
}

function makeTools(dataDir, { approval, guards, scanner } = {}) {
  const g = guards ?? createLibraryGuards(dataDir)
  if (scanner !== undefined) g.setPaperSessionScanner(scanner)
  const tools = {}
  const ctx = { tools: { register: (x) => { tools[x.name] = x } }, get: (n) => (n === 'approval' ? approval : undefined) }
  registerTools(ctx, { dataDir }, g)
  return { tools, tool: tools.library_manage, guards: g }
}

const execOf = (over = {}) => ({
  agent: { id: 't4-attacker-agent' },
  callId: 't4-call',
  signal: new AbortController().signal,
  deferContext() {}, concludeTurn() {},
  ...over,
})

const catchErr = async (fn) => { try { await fn(); return null } catch (e) { return e } }
const codeOf = (e) => (e instanceof ManageError ? e.code : `<non-ManageError:${e?.name}:${e?.message}>`)

const results = []
async function probe(id, fn) {
  // 精确匹配 + 「id 描述后缀」兼容（A/B/C/D/E 组的 id 形如 `A5 abort-during-approval`）
  if (ONLY && id !== ONLY && !id.startsWith(ONLY + ' ') && !id.startsWith(ONLY + '-')) return
  try { await fn(); results.push({ id, ok: true }) } catch (e) { results.push({ id, ok: false, detail: e?.stack ?? String(e) }) }
}
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? process.argv[i + 1] : null })()

/* ═══════════════ A. 审批门：绕过 / fail-open / 副作用 ═══════════════ */

// A1 闭集外的返回值（对象/字符串变体/布尔/数组）一律 fail closed。
await probe('A1 approval-outcome-closed-set', async () => {
  for (const bad of [{ outcome: 'allowed-once' }, 'allow', 'allowed', 'ALLOWED-ONCE', 'allowed-once ', '', null, 1, true, ['allowed-once']]) {
    const { data } = mkLib()
    newPaper(data, 'T', 'P')
    const ap = fakeApproval()
    ap.state.custom = bad
    ap.state.useCustom = true
    const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
    const before = snap(data)
    const err = await catchErr(() => tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf()))
    assert.ok(err, `坏返回值 ${JSON.stringify(bad)} 竟然被当成批准（破坏性动作被执行）`)
    assert.equal(codeOf(err), 'approval-unavailable', `坏返回值 ${JSON.stringify(bad)} 的错误码 ${codeOf(err)}`)
    assert.deepEqual(snap(data), before, `坏返回值 ${JSON.stringify(bad)} 产生了副作用`)
  }
})

// A2 控制探针：真的 allowed-once 必须放行（证明 A1 不是「永远拒绝」的空转）。
await probe('A2 allowed-once-control', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  const ap = fakeApproval('allowed-once')
  const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const out = await tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf())
  assert.equal(out.approval, 'allowed-once')
  assert.equal(existsSync(join(data, 'T', 'P')), false, '允许后论文目录应消失')
  assert.equal(ap.requests.length, 1)
})

// A3 「模型自填确认」不得冒充用户确认：参数里塞 confirm/approval/token/force 不改变任何一态。
await probe('A3 self-confirm-args-cannot-bypass', async () => {
  for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
    const { data } = mkLib()
    newPaper(data, 'T', 'P')
    const ap = fakeApproval(outcome)
    const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
    const before = snap(data)
    const err = await catchErr(() => tool.execute(
      { action: 'delete_paper', topic: 'T', name: 'P', confirm: true, approval: 'allowed-once', approved: true, token: 'yes', force: true, user_said_yes: true },
      execOf()))
    assert.ok(err, `${outcome} + 自填确认参数竟然执行了`)
    assert.match(codeOf(err), /^approval-/, `错误码应属审批族，实际 ${codeOf(err)}`)
    assert.deepEqual(snap(data), before, `${outcome} 下出现副作用`)
  }
  // 参数面本身不含任何「自填确认」字段
  const { data } = mkLib()
  const { tool } = makeTools(data, { approval: fakeApproval().service })
  const names = Object.keys(tool.parameters.properties)
  assert.deepEqual(names.sort(), ['action', 'name', 'new_name', 'source_path', 'to_topic', 'topic'])
  for (const n of names) assert.ok(!/confirm|approve|token|force|yes/i.test(n), `参数里出现自填确认字段 ${n}`)
})

// A4 无审批服务 / 无 agent / request 抛错 / agent 被换成 null 一律 fail closed。
await probe('A4 approval-channel-unavailable', async () => {
  const cases = [
    ['no-service', (data) => makeTools(data, { approval: undefined, scanner: async () => [] })],
    ['request-throws', (data) => { const ap = fakeApproval(); ap.state.throws = true; return makeTools(data, { approval: ap.service, scanner: async () => [] }) }],
    ['ctx.get-throws', (data) => {
      const g = createLibraryGuards(data); g.setPaperSessionScanner(async () => [])
      const tools = {}
      registerTools({ tools: { register: (x) => { tools[x.name] = x } }, get: () => { throw new Error('resolver exploded') } }, { dataDir: data }, g)
      return { tools, tool: tools.library_manage }
    }],
    ['no-agent', (data) => makeTools(data, { approval: fakeApproval().service, scanner: async () => [] })],
  ]
  for (const [label, build] of cases) {
    const { data } = mkLib()
    newPaper(data, 'T', 'P')
    const { tool } = build(data)
    const before = snap(data)
    const exec = label === 'no-agent' ? { callId: 'c', signal: new AbortController().signal } : execOf()
    const err = await catchErr(() => tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, exec))
    assert.ok(err, `${label} 竟然放行`)
    assert.deepEqual(snap(data), before, `${label} 下出现副作用`)
    assert.equal(codeOf(err), 'approval-unavailable', `${label} 错误码 ${codeOf(err)}`)
    // t6 修复（t4-F4）：ctx.get 自身抛错也必须带 [library_manage:*] 前缀（旧实现会冒泡裸 Error）
    if (label === 'ctx.get-throws') assert.match(err.message, /^\[library_manage:approval-unavailable\]/, `ctx.get 抛错未被统一：${err.message}`)
  }
})

// A5 审批挂起期间 signal 中止 → 即使随后返回 allowed-once 也必须零副作用。
// （这条专门打「批准后、第一次写盘前不再查取消」的变异。）
await probe('A5 abort-during-approval', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  const ap = fakeApproval()
  let release
  ap.state.gate = new Promise((r) => { release = r })
  const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const before = snap(data)
  const ac = new AbortController()
  const p = tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf({ signal: ac.signal }))
  await new Promise((r) => setTimeout(r, 15))
  assert.equal(ap.requests.length, 1, '审批请求应已发出')
  ac.abort()
  ap.state.outcome = 'allowed-once'
  release()
  const err = await catchErr(() => p)
  assert.ok(err, '中止后仍然执行了删除')
  assert.equal(codeOf(err), 'approval-cancelled', `中止错误码 ${codeOf(err)}`)
  assert.deepEqual(snap(data), before, '中止后仍有副作用')
})

// A6 审批请求内容：agent 身份 / callId / signal / reason 指名目标 / 一次性语义。
await probe('A6 approval-payload-shape', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P', { extra: {} })
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const exec = execOf()
  await tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, exec)
  assert.equal(ap.requests.length, 1)
  const r = ap.requests[0]
  assert.equal(r.toolName, 'library_manage')
  assert.equal(r.agent, exec.agent, '审批请求必须携带发起会话的 agent 身份')
  assert.equal(r.callId, exec.callId)
  assert.equal(r.signal, exec.signal)
  assert.match(r.reason, /delete_paper/)
  assert.match(r.reason, /T\/P/)
  assert.match(r.reason, /one-shot|仅本次/i)
  assert.equal(r.displayReason, r.reason, 'displayReason 与 reason 同源（仅透传，不参与判断）')
})

// A7 挂起的审批不释放锁：同一目标第二个请求 409 busy；且审批失败后锁必须被释放（无死锁）。
await probe('A7 lock-hold-and-release', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  newPaper(data, 'T', 'Q')
  const ap = fakeApproval()
  let release
  ap.state.gate = new Promise((r) => { release = r })
  const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const first = tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf())
  await new Promise((r) => setTimeout(r, 15))
  const err2 = await catchErr(() => tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf()))
  assert.equal(codeOf(err2), 'busy', `在途时第二个请求应 409 busy，实际 ${codeOf(err2)}`)
  ap.state.outcome = 'rejected'
  release()
  assert.equal(codeOf(await catchErr(() => first)), 'approval-rejected')
  // 锁必须已释放：同目标的下一次操作能正常走审批（不是 busy）
  ap.state.gate = null
  ap.state.outcome = 'allowed-once'
  const out = await tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf())
  assert.equal(out.ok, true, '失败后锁泄漏（下一次同目标操作仍 busy）')
})

/* ═══════════════ B. 路径安全：符号链接 / 词法变形 / TOCTOU ═══════════════ */

// B1 专题目录经库内符号链接间接指向另一专题 → 删/移/改名一律拒，且目标完好。
await probe('B1-symlink-topic-inside-root', async () => {
  for (const action of [
    { action: 'delete_topic', topic: 'L' },
    { action: 'rename_topic', topic: 'L', new_name: 'Z' },
    { action: 'delete_paper', topic: 'L', name: 'P' },
    { action: 'move_paper', topic: 'L', name: 'P', to_topic: 'S' },
  ]) {
    const { data } = mkLib()
    newPaper(data, 'T', 'P')
    mkdirSync(join(data, 'S'), { recursive: true })
    symlinkSync(join(data, 'T'), join(data, 'L'))
    const ap = fakeApproval()
    const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
    const before = snap(data)
    const err = await catchErr(() => tool.execute(action, execOf()))
    assert.ok(err, `${action.action} 经符号链接专题竟然成功`)
    assert.ok(['escape-rejected', 'not-found', 'bad-name'].includes(codeOf(err)), `${action.action} 错误码 ${codeOf(err)}`)
    assert.deepEqual(snap(data), before, `${action.action} 经符号链接产生了副作用`)
    assert.equal(ap.requests.length, 0, `${action.action} 在只读预检失败时不该打扰用户点审批`)
  }
})

// B2 论文目录本身是符号链接（指向库外）→ 删除拒绝，库外目标逐字节不变。
await probe('B2-symlink-paper-dir-outside', async () => {
  const { data, root } = mkLib()
  const outside = join(root, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'P.pdf'), PDF('outside/P'))
  mkdirSync(join(data, 'T'), { recursive: true })
  symlinkSync(outside, join(data, 'T', 'P'))
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const before = snap(data)
  const outsideBefore = snap(outside)
  const err = await catchErr(() => tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf()))
  assert.equal(codeOf(err), 'escape-rejected', `符号链接论文目录错误码 ${codeOf(err)}`)
  assert.deepEqual(snap(data), before)
  assert.deepEqual(snap(outside), outsideBefore, '库外目标被改动')
})

// B3 词法变形矩阵（删除/收录两条写路径都打）：必须拒绝且零副作用。
await probe('B3-lexical-deformations', async () => {
  const variants = ['T/', 'T//S', 'T/.', 'T/..', 'T/../S', '.trash', '.trash/x', 'T\u0000', '..', '../T', '/etc', 'T\\S']
  for (const v of variants) {
    const { data, root } = mkLib()
    newPaper(data, 'T', 'P')
    mkdirSync(join(data, 'S'), { recursive: true })
    const src = join(root, 'ok.pdf')
    writeFileSync(src, PDF('ok'))
    const ap = fakeApproval()
    const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
    const before = snap(data)
    for (const args of [
      { action: 'delete_topic', topic: v },
      { action: 'delete_paper', topic: v, name: 'P' },
      { action: 'add_paper', topic: v, source_path: src },
      { action: 'create_topic', topic: v },
    ]) {
      const err = await catchErr(() => tool.execute(args, execOf()))
      assert.ok(err, `${args.action} 接受变形 topic ${JSON.stringify(v)}`)
      assert.ok(['bad-name', 'not-found', 'escape-rejected'].includes(codeOf(err)), `${args.action} ${JSON.stringify(v)} → ${codeOf(err)}`)
    }
    assert.deepEqual(snap(data), before, `变形 ${JSON.stringify(v)} 产生副作用`)
  }
})

// B4 TOCTOU：plan 之后被换成符号链接 —— 执行期必须重新解析（不得顺着链接把库外目录搬进库）。
await probe('B4-move-toctou-symlink-swap', async () => {
  const { data, root } = mkLib()
  const src = newPaper(data, 'T', 'P')
  mkdirSync(join(data, 'S'), { recursive: true })
  const outside = join(root, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'P.pdf'), PDF('outside/P'))
  const plan = LM.planMovePaper(data, 'T', 'P', 'S')
  assert.equal(plan.sourceDir, src)
  // 竞态窗口：审批前预检之后，把源论文夹换成指向库外的符号链接
  rmSync(src, { recursive: true, force: true })
  symlinkSync(outside, src)
  const outsideBefore = snap(outside)
  const err = await catchErr(() => LM.movePaper(data, 'T', 'P', 'S'))
  assert.ok(err, 'TOCTOU：链接替换后仍然移动成功')
  assert.ok(['escape-rejected', 'not-found'].includes(err?.code), `TOCTOU 错误码 ${err?.code}`)
  assert.deepEqual(snap(outside), outsideBefore, 'TOCTOU：库外目录内容被搬动')
  assert.equal(existsSync(join(data, 'S', 'P')), false, 'TOCTOU：目标出现论文夹')
})

// B5 旧布局移动作业必须是只读拒绝（红线：迁移只能在界面执行）。
await probe('B5-move-legacy-rejected', async () => {
  const { data } = mkLib()
  mkdirSync(join(data, 'T'), { recursive: true })
  mkdirSync(join(data, 'S'), { recursive: true })
  writeFileSync(join(data, 'T', 'P.pdf'), PDF('legacy'))
  writeFileSync(join(data, 'T', 'P.txt'), 'cache')
  const before = snap(data)
  const err = await catchErr(() => LM.movePaper(data, 'T', 'P', 'S'))
  assert.equal(err?.code, 'legacy-layout', `旧布局移动错误码 ${err?.code}`)
  assert.deepEqual(snap(data), before, '旧布局移动产生了副作用（等于偷偷执行了迁移）')
})

// B6 源文件边界：FIFO / 字符设备 / 符号链接 / 目录 —— 拒绝且不挂起、不写盘。
await probe('B6-add-source-boundaries', async () => {
  const { data, root } = mkLib()
  mkdirSync(join(data, 'T'), { recursive: true })
  const fifo = join(root, 'fifo.pdf')
  execFileSync('mkfifo', [fifo])
  const cases = [
    ['fifo', fifo, 'source-invalid'],
    ['chardev', '/dev/null', 'source-invalid'],
    ['dir', root, 'source-invalid'],
    ['symlink', (() => { const p = join(root, 'link.pdf'); writeFileSync(join(root, 'real.pdf'), PDF('real')); symlinkSync(join(root, 'real.pdf'), p); return p })(), 'source-invalid'],
    ['missing', join(root, 'nope.pdf'), 'source-not-found'],
    ['empty', (() => { const p = join(root, 'empty.pdf'); writeFileSync(p, ''); return p })(), 'source-empty'],
    ['not-pdf', (() => { const p = join(root, 'text.pdf'); writeFileSync(p, 'hello world, not a pdf'); return p })(), 'source-not-pdf'],
  ]
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const before = snap(data)
  for (const [label, p, expectCode] of cases) {
    const err = await catchErr(() => tool.execute({ action: 'add_paper', topic: 'T', source_path: p }, execOf()))
    assert.equal(codeOf(err), expectCode, `${label} → ${codeOf(err)}（期望 ${expectCode}）`)
  }
  assert.deepEqual(snap(data), before, '源边界拒绝时产生副作用')
  assert.equal(ap.requests.length, 0, 'add_paper 不应请求审批')
})

/* ═══════════════ C. 破坏性正确性：回收站 / 并发 / 原子性 ═══════════════ */

// C1 回收站一致性：9 个产物 + 隐藏文件 + 未知文件；逐字节一致、可手工恢复、未知条目不被吞。
await probe('C1-trash-consistency-and-recover', async () => {
  const { data } = mkLib()
  const dir = newPaper(data, 'T', 'P', { extra: { '.DS_Store': 'junk', 'notes.md': 'user notes' } })
  const before = snap(data)
  const hashes = Object.fromEntries(readdirSync(dir).map((n) => [n, sha256(join(dir, n))]))
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const out = await tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf())
  // 产物（含 -zh 变体）9 个 + 隐藏 .DS_Store
  assert.deepEqual(out.files.slice().sort(), ['.DS_Store', 'P-zh.pdf', 'P.embeddings.json', 'P.mineru.json', 'P.mineru.md', 'P.pages.json', 'P.pdf', 'P.study.json', 'P.transcript.json', 'P.txt'].sort(), `受影响的文件清单 ${out.files}`)
  assert.ok(out.trashRel.startsWith('.trash/'))
  // 回收站内逐字节一致
  for (const n of out.files) assert.equal(sha256(join(out.trashDir, 'P', n)), hashes[n], `${n} 在回收站里内容不一致`)
  // 未知条目不被吞（notes.md 留在原处，目录保留）
  assert.equal(existsSync(join(dir, 'notes.md')), true, '未知条目被删除/吞掉')
  // manifest 给出恢复线索（相对路径 + 文件清单）
  const manifest = JSON.parse(readFileSync(join(out.trashDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.relativeDir, 'T/P')
  assert.equal(manifest.trashSubdir, 'P')
  assert.equal(manifest.kind, 'paper')
  assert.ok(manifest.files.length >= 9)
  // 手工恢复：把回收站子目录里的文件搬回 relativeDir，快照必须回到「原始 - notes.md」
  const { renameSync } = await import('node:fs')
  for (const n of readdirSync(join(out.trashDir, 'P'))) {
    if (n === 'manifest.json') continue   // 回收站自己的恢复线索，不属于产物
    renameSync(join(out.trashDir, 'P', n), join(data, 'T', 'P', n))
  }
  const after = snap(data)
  const notTrash = ([k]) => k !== '.trash' && !k.startsWith('.trash/')
  const expected = Object.fromEntries(Object.entries(before).filter(notTrash))
  const actual = Object.fromEntries(Object.entries(after).filter(notTrash))
  assert.deepEqual(actual, expected, '按 manifest 恢复后与删除前的库不一致')
})

// C2 并发删除同一篇：恰好一次成功，其余 busy；只留一个回收站 bundle，无残留半状态。
await probe('C2-concurrent-delete-same-paper', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const rs = await Promise.allSettled(Array.from({ length: 5 }, () => tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf())))
  const ok = rs.filter((r) => r.status === 'fulfilled')
  const codes = rs.filter((r) => r.status === 'rejected').map((r) => codeOf(r.reason))
  assert.equal(ok.length, 1, `并发删除成功数 ${ok.length}（期望 1）`)
  assert.ok(codes.every((c) => c === 'busy'), `失败码应全为 busy：${codes}`)
  const bundles = readdirSync(join(data, '.trash'))
  assert.equal(bundles.length, 1, `回收站 bundle 数 ${bundles.length}`)
  assert.equal(existsSync(join(data, 'T', 'P')), false)
  assert.equal(ap.requests.length, 1, `审批请求数 ${ap.requests.length}（并发下只应有一次真正执行到审批）`)
})

// C3 并发「移动 vs 删除」同一篇：不变量 = 论文恰好存在于一处（源/目标/回收站），绝不两处或零处。
await probe('C3-concurrent-move-vs-delete', async () => {
  for (let i = 0; i < 3; i++) {
    const { data } = mkLib()
    newPaper(data, 'T', 'P')
    mkdirSync(join(data, 'S'), { recursive: true })
    const ap = fakeApproval()
    const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
    const rs = await Promise.allSettled([
      tool.execute({ action: 'move_paper', topic: 'T', name: 'P', to_topic: 'S' }, execOf()),
      tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf()),
    ])
    const okCount = rs.filter((r) => r.status === 'fulfilled').length
    assert.equal(okCount, 1, `移动/删除并发成功数 ${okCount}：${rs.map((r) => r.status === 'fulfilled' ? 'ok' : codeOf(r.reason))}`)
    const inSrc = existsSync(join(data, 'T', 'P'))
    const inDst = existsSync(join(data, 'S', 'P'))
    const trashFiles = existsSync(join(data, '.trash'))
      ? readdirSync(join(data, '.trash')).flatMap((b) => existsSync(join(data, '.trash', b, 'P')) ? readdirSync(join(data, '.trash', b, 'P')) : [])
      : []
    const places = [inSrc, inDst, trashFiles.length > 0].filter(Boolean).length
    assert.equal(places, 1, `论文同时存在于 ${places} 处（src=${inSrc} dst=${inDst} trash=${trashFiles.length}）`)
    if (trashFiles.length > 0) assert.ok(trashFiles.includes('P.pdf'), '回收站里缺 .pdf')
  }
})

// C4 移动整目录：全部产物 + 隐藏目录 + 论文夹内符号链接都原样搬走；链接目标不被跟随/破坏。
await probe('C4-move-preserves-everything', async () => {
  const { data, root } = mkLib()
  const dir = newPaper(data, 'T', 'P')
  mkdirSync(join(dir, 'hiddenDir'))
  writeFileSync(join(dir, 'hiddenDir', 'x.txt'), 'x')
  writeFileSync(join(dir, 'link-payload'), 'payload')
  const outside = join(root, 'target.bin')
  writeFileSync(outside, 'outside-target')
  symlinkSync(outside, join(dir, 'link-to-outside'))
  mkdirSync(join(data, 'S'), { recursive: true })
  const before = Object.fromEntries(readdirSync(dir).filter((n) => lstatSync(join(dir, n)).isFile()).map((n) => [n, sha256(join(dir, n))]))
  const outsideHash = sha256(outside)
  const ap = fakeApproval()
  const { tool, guards } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  // 另测 detachedSessions 口径：scanner 返回 2 个会话
  guards.setPaperSessionScanner(async () => [{ running: false }, { running: false }])
  const out = await tool.execute({ action: 'move_paper', topic: 'T', name: 'P', to_topic: 'S' }, execOf())
  assert.equal(out.detachedSessions, 2, `detachedSessions=${out.detachedSessions}`)
  const dst = join(data, 'S', 'P')
  for (const [n, h] of Object.entries(before)) {
    const p = join(dst, n)
    assert.ok(existsSync(p), `${n} 未随移动`)
    assert.equal(sha256(p), h, `${n} 内容变了`)
  }
  assert.equal(readFileSync(join(dst, 'hiddenDir', 'x.txt'), 'utf8'), 'x', '隐藏目录内容未随移动')
  assert.equal(lstatSync(join(dst, 'link-to-outside')).isSymbolicLink(), true, '符号链接被解析成了普通文件')
  assert.equal(sha256(outside), outsideHash, '链接目标被改动')
  assert.equal(out.files.includes('P-zh.pdf'), true)
  assert.ok(out.files.includes('P.pdf'))
})

// C5 收录原子性（真实落盘）：目标内容 == 源、无 .tmp-* 残留、源文件只读不动。
await probe('C5-add-atomic-and-source-readonly', async () => {
  const { data, root } = mkLib()
  mkdirSync(join(data, 'T'), { recursive: true })
  const src = join(root, 'paper.pdf')
  writeFileSync(src, PDF('source'))
  const srcHash = sha256(src)
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const out = await tool.execute({ action: 'add_paper', topic: 'T', source_path: src }, execOf())
  assert.equal(out.ok, true)
  assert.equal(out.name, 'paper')
  assert.equal(sha256(join(data, 'T', 'paper', 'paper.pdf')), srcHash)
  assert.equal(sha256(src), srcHash, '源文件被改动')
  const leftovers = readdirSync(join(data, 'T', 'paper')).filter((n) => n.includes('.tmp-'))
  assert.deepEqual(leftovers, [], `落盘残留 ${leftovers}`)
})

// C6 收录目标竞态：目标在预检之后出现 —— 绝不覆盖既有文件（丢数据）。
await probe('C6-add-target-race-no-overwrite', async () => {
  const { data, root } = mkLib()
  mkdirSync(join(data, 'T'), { recursive: true })
  const src = join(root, 'paper.pdf')
  writeFileSync(src, PDF('source'))
  const target = join(data, 'T', 'paper', 'paper.pdf')
  const err = await catchErr(() => LM.addPaper(data, 'T', src, 'paper', {
    copyImpl: (from, to) => {
      // 模拟「预检之后、落盘之前」别人先占了这个名字（同进程内 + 跨进程竞态的等价物）
      mkdirSync(dirname(target), { recursive: true })
      if (!existsSync(target)) writeFileSync(target, 'ATTACKER-CONTENT')
      writeFileSync(to, readFileSync(from))
    },
  }))
  assert.ok(err, '竞态下竟然没有报错')
  assert.equal(codeOf(err), 'target-exists', `竞态错误码 ${codeOf(err)}`)
  assert.equal(readFileSync(target, 'utf8'), 'ATTACKER-CONTENT', '既有目标被覆盖（丢数据）')
})

// C7 收录中途失败：库回到零改动（含不留下空专题目录）。
await probe('C7-add-partial-cleanup', async () => {
  const { data, root } = mkLib()
  const src = join(root, 'paper.pdf')
  writeFileSync(src, PDF('source'))
  const before = snap(data)
  const err = await catchErr(() => LM.addPaper(data, 'Brand/New', src, 'paper', {
    copyImpl: (from, to) => { writeFileSync(to, 'partial'); const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e },
  }))
  assert.ok(err, '中途失败竟然报告成功')
  const after = snap(data)
  assert.deepEqual(after, before, `中途失败留下残留：${JSON.stringify(Object.keys(after).filter((k) => !(k in before)))}`)
})

// C8 删除空专题（仅有隐藏条目）：隐藏条目进回收站、目录消失、manifest 可恢复。
await probe('C8-delete-topic-hidden-only', async () => {
  const { data } = mkLib()
  mkdirSync(join(data, 'E'), { recursive: true })
  writeFileSync(join(data, 'E', '.DS_Store'), 'junk')
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const out = await tool.execute({ action: 'delete_topic', topic: 'E' }, execOf())
  assert.equal(existsSync(join(data, 'E')), false)
  assert.deepEqual(out.files, ['.DS_Store'])
  assert.ok(out.trashRel && out.trashRel.startsWith('.trash/'))
  assert.equal(readFileSync(join(out.trashDir, 'manifest.json'), 'utf8').includes('topic-hidden'), true)
})

/* ═══════════════ D. 审批后置语义（授权后才发现冲突是否仍零副作用） ═══════════════ */

// D1 rename 目标冲突：零副作用 + target-exists。t6 修复后**冲突在审批之前**判定（requests=0）；
// 这条探针同时守「修复把成本从『多打扰一次』降到 0」与「零副作用」两个性质。
await probe('D1-rename-conflict-zero-side-effect', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  newPaper(data, 'T', 'Q')
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const before = snap(data)
  const err = await catchErr(() => tool.execute({ action: 'rename_paper', topic: 'T', name: 'P', new_name: 'Q' }, execOf()))
  assert.equal(codeOf(err), 'target-exists', `错误码 ${codeOf(err)}`)
  assert.deepEqual(snap(data), before, '冲突时仍有副作用')
  assert.equal(ap.requests.length, 0, `t6 修复要求冲突在审批前拒绝，实际请求了 ${ap.requests.length} 次审批`)
})

// D2 rename 到自身同名 → 授权前就拒（不打扰用户）。
await probe('D2-rename-same-name-no-approval', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const before = snap(data)
  const err = await catchErr(() => tool.execute({ action: 'rename_paper', topic: 'T', name: 'P', new_name: 'P' }, execOf()))
  assert.equal(codeOf(err), 'bad-request')
  assert.deepEqual(snap(data), before)
  assert.equal(ap.requests.length, 0, '同名改名不该弹审批')
})

// D3 大小写与变体后缀口径（①）：add 允许大写 .PDF 源；名字里的 .PDF 一律拒；
//    -ZH（大写）是合法论文名且仍在库里被列出（与 isPaperPDF 大小写敏感同口径）。
await probe('D3-case-sensitivity-contract', async () => {
  const { data, root } = mkLib()
  mkdirSync(join(data, 'T'), { recursive: true })
  const upper = join(root, 'Upper.PDF')
  writeFileSync(upper, PDF('upper'))
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const out = await tool.execute({ action: 'add_paper', topic: 'T', source_path: upper }, execOf())
  assert.equal(out.name, 'Upper', `大写 .PDF 源未正确去后缀：${out.name}`)
  const errDotPdf = await catchErr(() => tool.execute({ action: 'add_paper', topic: 'T', source_path: upper, name: 'X.PDF' }, execOf()))
  assert.equal(codeOf(errDotPdf), 'bad-name', `.PDF 名字错误码 ${codeOf(errDotPdf)}`)
  // 大写变体后缀：允许创建，且 listPapers 仍列出该篇
  const outZh = await tool.execute({ action: 'add_paper', topic: 'T', source_path: upper, name: 'Paper-ZH' }, execOf())
  assert.equal(outZh.name, 'Paper-ZH')
  const listed = LIB.listPapers(data, 'T').map((p) => p.name)
  assert.ok(listed.includes('Paper-ZH'), `大写 -ZH 论文从库中消失：${listed}`)
  assert.ok(listed.includes('Upper'))
  // 小写变体后缀：拒（会被 isPaperPDF 当译文变体隐藏）
  const errZh = await catchErr(() => tool.execute({ action: 'add_paper', topic: 'T', source_path: upper, name: 'Paper-zh' }, execOf()))
  assert.equal(codeOf(errZh), 'bad-name')
})

/* ═══════════════ E. 迁移红线（静态：真实 import 图 + 产物里无执行调用） ═══════════════ */

await probe('E1-no-migration-execution-path', async () => {
  const toolsSrc = readFileSync(join(REPO, 'src', 'tools.ts'), 'utf8')
  const migrateImports = [...toolsSrc.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/migrate\.ts'/g)].map((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean))
  assert.deepEqual(migrateImports, [['formatMigrationReport', 'planMigration']], `tools.ts 从 migrate 取的东西：${JSON.stringify(migrateImports)}`)
  // 动态 import / require 也不能夹带迁移执行
  assert.ok(!/import\(\s*['"]\.\/migrate\.ts['"]\s*\)/.test(toolsSrc), 'tools.ts 出现动态 import 迁移模块')
  assert.ok(!/require\(\s*['"]\.\/migrate/.test(toolsSrc), 'tools.ts 出现 require 迁移模块')
  const distSrc = readFileSync(join(REPO, 'dist', 'tools.js'), 'utf8')
  assert.ok(!/\brunMigration\s*\(|\brollbackMigration\s*\(/.test(distSrc), 'dist/tools.js 调用了迁移执行函数')
  // 运行时：action 闭集
  const { data } = mkLib()
  const { tool } = makeTools(data, { approval: fakeApproval().service })
  assert.deepEqual(tool.parameters.properties.action.enum.slice().sort(), ['add_paper', 'create_topic', 'delete_paper', 'delete_topic', 'move_paper', 'rename_paper', 'rename_topic'])
  for (const a of ['migrate', 'migrate_library', 'rollback', 'clear_topic', 'restore']) {
    const err = await catchErr(() => tool.execute({ action: a }, execOf()))
    assert.ok(err, `action=${a} 竟然被接受`)
  }
  assert.equal(existsSync(join(data, 'migration-logs')), false)
})

/* ═══════════════ R. 第二轮（t6 修复）新攻击面：三路改名冲突 / 混合布局拒绝 / 残留如实呈现 / 修复自身 TOCTOU ═══════════════ */

const namesOf = (data, topic = 'T') => LIB.listPapers(data, topic).map((p) => `${p.name}${p.legacy ? '(legacy)' : ''}`).sort()
const mixedPaper = (data, topic = 'T', name = 'P') => {
  const dir = newPaper(data, topic, name)
  writeFileSync(join(data, topic, name + '.pdf'), PDF('flat-' + name))
  writeFileSync(join(data, topic, name + '.txt'), 'flat-cache')
  return dir
}

// R1 F1 原始复现：改成一个被**旧布局**文献占用的名字 → 审批前 target-exists、零副作用、不遮蔽既有文献。
await probe('R1-rename-legacy-target-blocked', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  mkdirSync(join(data, 'T'), { recursive: true })
  writeFileSync(join(data, 'T', 'Q.pdf'), PDF('Q-legacy'))
  writeFileSync(join(data, 'T', 'Q.txt'), 'Q-cache')
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const before = snap(data)
  assert.deepEqual(namesOf(data), ['P', 'Q(legacy)'])
  const err = await catchErr(() => tool.execute({ action: 'rename_paper', topic: 'T', name: 'P', new_name: 'Q' }, execOf()))
  assert.equal(codeOf(err), 'target-exists', `错误码 ${codeOf(err)}`)
  assert.deepEqual(snap(data), before, '冲突时有副作用')
  assert.equal(ap.requests.length, 0, `冲突必须在审批前拒绝，实际请求审批 ${ap.requests.length} 次`)
  assert.deepEqual(namesOf(data), ['P', 'Q(legacy)'], '既有 legacy 文献被遮蔽（t4-F1 未修复）')
})

// R2 目标是已存在的论文夹；R3 目标只剩孤儿 sidecar。
await probe('R2-rename-folder-target-blocked', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  newPaper(data, 'T', 'Q')
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const before = snap(data)
  const err = await catchErr(() => tool.execute({ action: 'rename_paper', topic: 'T', name: 'P', new_name: 'Q' }, execOf()))
  assert.equal(codeOf(err), 'target-exists')
  assert.deepEqual(snap(data), before)
  assert.equal(ap.requests.length, 0)
})
await probe('R3-rename-orphan-target-blocked', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  writeFileSync(join(data, 'T', 'Q.mineru.json'), '{}')
  writeFileSync(join(data, 'T', 'Q-zh.pdf'), 'variant-of-a-ghost')
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const before = snap(data)
  for (const target of ['Q']) {
    const err = await catchErr(() => tool.execute({ action: 'rename_paper', topic: 'T', name: 'P', new_name: target }, execOf()))
    assert.equal(codeOf(err), 'target-exists', `孤儿产物目标未拒：${codeOf(err)}`)
  }
  assert.deepEqual(snap(data), before)
  assert.equal(ap.requests.length, 0)
})

// R4 修复不能过度拦截：大小写-only 改名仍放行（Linux 大小写敏感 FS 上是真改名）。
await probe('R4-case-only-rename-still-allowed', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const out = await tool.execute({ action: 'rename_paper', topic: 'T', name: 'P', new_name: 'p' }, execOf())
  assert.equal(out.new_name, 'p', `大小写-only 改名被过度拦截：${out}`)
  assert.deepEqual(namesOf(data), ['p'])
})

// R5/R6/R7 混合态三动作：layout-conflict、审批前拒绝、零副作用、不留旧身份。
await probe('R5-mixed-delete-rejected', async () => {
  const { data } = mkLib()
  mixedPaper(data)
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const before = snap(data)
  assert.deepEqual(namesOf(data), ['P'])
  const err = await catchErr(() => tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf()))
  assert.equal(codeOf(err), 'layout-conflict', `错误码 ${codeOf(err)}`)
  assert.deepEqual(snap(data), before, '混合态拒绝时有副作用')
  assert.equal(ap.requests.length, 0, '混合态在审批前就应拒绝')
  assert.deepEqual(namesOf(data), ['P'], '旧实现这里会变 [P(legacy)]')
  const files = err?.extra?.files
  assert.ok(Array.isArray(files) && files.includes('P.pdf') && files.includes('P.txt'), `extra.files 未点名残留：${JSON.stringify(err?.extra)}`)
})
await probe('R6-mixed-rename-rejected', async () => {
  const { data } = mkLib()
  mixedPaper(data)
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const before = snap(data)
  const err = await catchErr(() => tool.execute({ action: 'rename_paper', topic: 'T', name: 'P', new_name: 'R' }, execOf()))
  assert.equal(codeOf(err), 'layout-conflict', `错误码 ${codeOf(err)}`)
  assert.deepEqual(snap(data), before)
  assert.equal(ap.requests.length, 0)
  assert.deepEqual(namesOf(data), ['P'])
})
await probe('R7-mixed-move-rejected', async () => {
  const { data } = mkLib()
  mixedPaper(data)
  mkdirSync(join(data, 'S'), { recursive: true })
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const before = snap(data)
  const err = await catchErr(() => tool.execute({ action: 'move_paper', topic: 'T', name: 'P', to_topic: 'S' }, execOf()))
  assert.equal(codeOf(err), 'layout-conflict', `错误码 ${codeOf(err)}`)
  assert.deepEqual(snap(data), before)
  assert.equal(ap.requests.length, 0)
  assert.deepEqual(namesOf(data), ['P'], '旧实现这里会 [S/P, T/P(legacy)]')
})

// R8 修复不能伤到纯旧布局 / 纯新布局（对照组）：legacy 删除/改名仍可、move 仍 legacy-layout；folder 删除 dirRemoved=true。
await probe('R8-pure-layout-controls', async () => {
  // 纯旧布局：delete 把平铺产物移入回收站
  {
    const { data } = mkLib()
    mkdirSync(join(data, 'T'), { recursive: true })
    writeFileSync(join(data, 'T', 'P.pdf'), PDF('legacy'))
    writeFileSync(join(data, 'T', 'P.txt'), 'cache')
    const { tool } = makeTools(data, { approval: fakeApproval().service, scanner: async () => [] })
    const out = await tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf())
    assert.equal(out.ok, true)
    assert.deepEqual(namesOf(data), [])
  }
  // 纯旧布局：rename 仍逐个文件改名
  {
    const { data } = mkLib()
    mkdirSync(join(data, 'T'), { recursive: true })
    writeFileSync(join(data, 'T', 'P.pdf'), PDF('legacy'))
    writeFileSync(join(data, 'T', 'P.txt'), 'cache')
    const { tool } = makeTools(data, { approval: fakeApproval().service, scanner: async () => [] })
    const out = await tool.execute({ action: 'rename_paper', topic: 'T', name: 'P', new_name: 'R' }, execOf())
    assert.equal(out.new_name, 'R')
    assert.deepEqual(namesOf(data), ['R(legacy)'])
  }
  // 纯旧布局：move 仍被红线拒绝
  {
    const { data } = mkLib()
    mkdirSync(join(data, 'T'), { recursive: true })
    mkdirSync(join(data, 'S'), { recursive: true })
    writeFileSync(join(data, 'T', 'P.pdf'), PDF('legacy'))
    const { tool } = makeTools(data, { approval: fakeApproval().service, scanner: async () => [] })
    const err = await catchErr(() => tool.execute({ action: 'move_paper', topic: 'T', name: 'P', to_topic: 'S' }, execOf()))
    assert.equal(codeOf(err), 'legacy-layout')
  }
  // 纯新布局：delete 仍成功且 dirRemoved=true
  {
    const { data } = mkLib()
    newPaper(data, 'T', 'P')
    const { tool } = makeTools(data, { approval: fakeApproval().service, scanner: async () => [] })
    const out = await tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf())
    assert.equal(out.dirRemoved, true, `dirRemoved=${out.dirRemoved}`)
  }
})

// R9 F3：move 的 otherEntries / delete 的 dirRemoved 必须如实进入输出与摘要。
await probe('R9-residue-truthfulness', async () => {
  {
    const { data } = mkLib()
    const dir = newPaper(data, 'T', 'P')
    writeFileSync(join(dir, 'notes.md'), 'user notes')
    mkdirSync(join(dir, 'fig'), { recursive: true })
    writeFileSync(join(dir, 'fig', 'a.png'), 'png')
    mkdirSync(join(data, 'S'), { recursive: true })
    const { tool } = makeTools(data, { approval: fakeApproval().service, scanner: async () => [] })
    const out = await tool.execute({ action: 'move_paper', topic: 'T', name: 'P', to_topic: 'S' }, execOf())
    assert.deepEqual([...(out.otherEntries ?? [])].sort(), ['fig', 'notes.md'], `otherEntries=${JSON.stringify(out.otherEntries)}`)
    assert.match(out.summary, /notes\.md/)
    assert.match(out.summary, /fig/)
  }
  {
    const { data } = mkLib()
    const dir = newPaper(data, 'T', 'P')
    writeFileSync(join(dir, 'notes.md'), 'user notes')
    const { tool } = makeTools(data, { approval: fakeApproval().service, scanner: async () => [] })
    const out = await tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf())
    assert.equal(out.dirRemoved, false, `dirRemoved=${out.dirRemoved}`)
    assert.match(out.summary, /未删净/)
    assert.ok(existsSync(join(dir, 'notes.md')))
  }
})

// R10 F4：ctx.get 抛错 → 带机器码的 approval-unavailable（503），零副作用。
await probe('R10-approval-resolver-throw-coded', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  const g = createLibraryGuards(data)
  g.setPaperSessionScanner(async () => [])
  const tools = {}
  registerTools({ tools: { register: (x) => { tools[x.name] = x } }, get: () => { throw new Error('resolver exploded') } }, { dataDir: data }, g)
  const before = snap(data)
  const err = await catchErr(() => tools.library_manage.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf()))
  assert.ok(err instanceof ManageError, `必须是 ManageError，实际 ${err?.name}: ${err?.message}`)
  assert.equal(err.code, 'approval-unavailable', `code=${err.code}`)
  assert.equal(err.status, 503)
  assert.match(err.message, /^\[library_manage:approval-unavailable\]/)
  assert.deepEqual(snap(data), before)
})

// R11 t3-low-1：create_topic 目标为同名普通文件 → 409 target-exists（不被覆盖）；真目录仍幂等；符号链接仍拒。
await probe('R11-create-topic-target-kinds', async () => {
  const { data } = mkLib()
  writeFileSync(join(data, 'F'), 'i am a file')
  const { tool } = makeTools(data, { approval: fakeApproval().service })
  const before = snap(data)
  const err = await catchErr(() => tool.execute({ action: 'create_topic', topic: 'F' }, execOf()))
  assert.equal(codeOf(err), 'target-exists', `同名普通文件错误码 ${codeOf(err)}`)
  assert.deepEqual(snap(data), before)
  mkdirSync(join(data, 'D'), { recursive: true })
  const ok = await tool.execute({ action: 'create_topic', topic: 'D' }, execOf())
  assert.equal(ok.created, false, '已存在真目录必须幂等')
  mkdirSync(join(data, 'Target'), { recursive: true })
  symlinkSync(join(data, 'Target'), join(data, 'L'))
  const before2 = snap(data)
  const err2 = await catchErr(() => tool.execute({ action: 'create_topic', topic: 'L' }, execOf()))
  assert.equal(codeOf(err2), 'escape-rejected', `符号链接专题错误码 ${codeOf(err2)}`)
  assert.deepEqual(snap(data), before2)
})

// R12 修复自身的 TOCTOU：审批挂起期间把「混合态/目标占位」造出来，执行期必须重新预检。
await probe('R12-fix-toctou-recheck', async () => {
  // 12a delete：预检干净 → 审批挂起时造出平铺残留 → 执行期必须 layout-conflict
  {
    const { data } = mkLib()
    newPaper(data, 'T', 'P')
    const ap = fakeApproval()
    let release
    ap.state.gate = new Promise((r) => { release = r })
    const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
    const p = tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf())
    await new Promise((r) => setTimeout(r, 15))
    assert.equal(ap.requests.length, 1)
    writeFileSync(join(data, 'T', 'P.pdf'), PDF('flat-injected'))
    release()
    const err = await catchErr(() => p)
    assert.equal(codeOf(err), 'layout-conflict', `12a 执行期未重新预检：${codeOf(err)}`)
    assert.equal(existsSync(join(data, 'T', 'P', 'P.pdf')), true, '12a 论文夹被动了')
    assert.equal(existsSync(join(data, '.trash')), false, '12a 产生了回收站残留')
  }
  // 12b move：同上，执行期必须 layout-conflict，且不得出现在目标专题
  {
    const { data } = mkLib()
    newPaper(data, 'T', 'P')
    mkdirSync(join(data, 'S'), { recursive: true })
    const ap = fakeApproval()
    let release
    ap.state.gate = new Promise((r) => { release = r })
    const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
    const p = tool.execute({ action: 'move_paper', topic: 'T', name: 'P', to_topic: 'S' }, execOf())
    await new Promise((r) => setTimeout(r, 15))
    writeFileSync(join(data, 'T', 'P.pdf'), PDF('flat-injected'))
    release()
    const err = await catchErr(() => p)
    assert.equal(codeOf(err), 'layout-conflict', `12b 执行期未重新预检：${codeOf(err)}`)
    assert.equal(existsSync(join(data, 'S', 'P')), false, '12b 目标出现论文夹（重复身份）')
  }
  // 12c rename：预检干净 → 审批挂起时造出目标平铺占位 → 执行期必须 target-exists
  {
    const { data } = mkLib()
    newPaper(data, 'T', 'P')
    const ap = fakeApproval()
    let release
    ap.state.gate = new Promise((r) => { release = r })
    const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
    const p = tool.execute({ action: 'rename_paper', topic: 'T', name: 'P', new_name: 'Q' }, execOf())
    await new Promise((r) => setTimeout(r, 15))
    writeFileSync(join(data, 'T', 'Q.pdf'), PDF('Q-injected'))
    release()
    const err = await catchErr(() => p)
    assert.equal(codeOf(err), 'target-exists', `12c 执行期未重新预检：${codeOf(err)}`)
    assert.equal(existsSync(join(data, 'T', 'P', 'P.pdf')), true, '12c 源论文夹被改名')
    assert.equal(existsSync(join(data, 'T', 'Q', 'Q.pdf')), false, '12c 目标论文夹出现（遮蔽既有占位）')
  }
})

// R13 混合态并发：3 个破坏性动作并发 → 全部 layout-conflict、零写盘、listPapers 稳定。
await probe('R13-mixed-concurrent-rejects', async () => {
  const { data } = mkLib()
  mixedPaper(data)
  mkdirSync(join(data, 'S'), { recursive: true })
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const before = snap(data)
  const rs = await Promise.allSettled([
    tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf()),
    tool.execute({ action: 'rename_paper', topic: 'T', name: 'P', new_name: 'R' }, execOf()),
    tool.execute({ action: 'move_paper', topic: 'T', name: 'P', to_topic: 'S' }, execOf()),
  ])
  const codes = rs.map((r) => (r.status === 'fulfilled' ? 'ok' : codeOf(r.reason)))
  assert.deepEqual(codes, ['layout-conflict', 'layout-conflict', 'layout-conflict'], `并发错误码 ${codes}`)
  assert.deepEqual(snap(data), before)
  assert.equal(ap.requests.length, 0)
})

/* ═══════════════ 结果 ═══════════════ */
const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : '\n' + r.detail}`)
console.log(`\n== ${results.length - failed.length}/${results.length} PASS ==`)
process.exit(failed.length === 0 ? 0 : 1)
