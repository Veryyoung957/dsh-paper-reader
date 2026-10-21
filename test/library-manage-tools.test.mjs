// test/library-manage-tools.test.mjs — agent 侧「文献整理」工具（library_manage）的契约用例。
//
// 冻结契约：docs/library-manage-tools-plan.md（工具面 §1 / 审批门 §2 / 复用 §3 / 拒绝码 §4 /
// 红线 §5 / 测试计划 §6）。本文件按 §6.2 的 A–F 分组组织，每条用例名以组号开头，
// 评审可以逐组跑：`node --test --test-name-pattern='B' test/library-manage-tools.test.mjs`。
//
// 纪律：
//   · 只 import `dist/*.js`（跑前 `npm run build`；package.json 的 pretest 已自动 build）；
//   · 所有夹具在 mkdtemp 临时库里，绝不碰真实文献库（`~/.dsh-paper-reader/data`）；
//   · 「零副作用」用递归 **sha256 快照**断言（含 `.trash`），不看实现自述；
//   · 审批用 fake service（记录请求、可配置四态/抛错/挂起），不测 DSH 自身。
//
// 与方案的两处**有据偏离**（如实记录，不隐瞒）：
//   1) `action` 枚举由 `defineTool` 的参数 schema 先行校验（框架抛 ToolArgsError）；工具在注册前
//      把它统一翻译成 `bad-request`（见 src/tools.ts 的注册包装），因此调用方看到的仍是本工具的
//      错误码，而 schema 层依然不可能把 `migrate*` 派发进来。
//   2) `displayReason` 在 0.1.5 的审批类型里不存在（方案 §0.4 因此冻结「不使用」）；本实现把它作为
//      **可选**字段透传（0.1.5 忽略、0.2.x 用），因为任务硬性要求参数里含 displayReason，且不靠它做
//      任何判断。B1 断言两者都在请求里。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  renameSync, rmSync, symlinkSync, writeFileSync, statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')
const dist = (m) => join(REPO, 'dist', m)
// 隔离 agent preset 安装（host.registerRoutes 会往 $DSH_HOME/.agent-presets 写）
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dpr-lmt-home-'))
delete process.env.DPR_LIBRARY_MANAGE_LANG

const LM = await import(pathToFileURL(dist('library-manage.js')).href)
const { ManageError } = LM
const { registerTools } = await import(pathToFileURL(dist('tools.js')).href)
const { createLibraryGuards } = await import(pathToFileURL(dist('library-guards.js')).href)
const { registerRoutes } = await import(pathToFileURL(dist('host.js')).href)
const LIB = await import(pathToFileURL(dist('library.js')).href)

/* ═══════════════════════════════════════════════════════════════════════════
   基座：临时库夹具 / sha256 快照 / fake 审批 / 工具替身
   ═══════════════════════════════════════════════════════════════════════════ */

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

/** 递归快照（相对路径 → `[dir]` / `[symlink:target]` / sha256）；**包含 `.trash`**。 */
function snap(dir) {
  const out = {}
  const walk = (d, rel) => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch (e) {
      out[rel || '.'] = `[unreadable:${e.code ?? 'error'}]`
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      const st = lstatSync(p)
      if (st.isSymbolicLink()) { out[r] = `[symlink:${readlinkSync(p)}]`; continue }
      if (st.isDirectory()) { out[r] = '[dir]'; walk(p, r) } else { out[r] = sha256(p) }
    }
  }
  walk(dir, '')
  return out
}

function mkLib() {
  const root = mkdtempSync(join(tmpdir(), 'dpr-lmt-'))
  const data = join(root, 'data')
  mkdirSync(data, { recursive: true })
  return { root, data }
}

const PDF = (tag) => `%PDF-1.4\n% ${tag}\n%%EOF\n`

/** 新布局论文夹具：`<data>/<topic>/<name>/<name><后缀>`。 */
function newPaper(data, topic, name, { suffixes = ['.pdf', '.txt'], extra = {} } = {}) {
  const dir = join(data, topic, name)
  mkdirSync(dir, { recursive: true })
  for (const s of suffixes) writeFileSync(join(dir, name + s), s === '.pdf' ? PDF(`${topic}/${name}`) : `cache:${name}${s}`)
  for (const [f, c] of Object.entries(extra)) writeFileSync(join(dir, f), c)
  return dir
}

/** 旧布局（未迁移）夹具：平铺 `<data>/<topic>/<name>.pdf`。 */
function legacyPaper(data, topic, name) {
  mkdirSync(join(data, topic), { recursive: true })
  writeFileSync(join(data, topic, name + '.pdf'), PDF(`${topic}/${name}`))
  writeFileSync(join(data, topic, name + '.txt'), `cache:${name}`)
}

function fakeApproval(outcome = 'allowed-once') {
  const requests = []
  const state = { outcome, throws: false, gate: null }
  const service = {
    request: async (req) => {
      requests.push(req)
      if (state.gate) await state.gate
      if (state.throws) throw new Error('approval service down')
      return state.outcome
    },
  }
  return { service, requests, state }
}

/** 工具替身：假 ctx 提供 `get('approval')`（与 Cordis 的运行时可选读取同形）。 */
function makeTools(dataDir, { approval, guards, scanner, getThrows = false } = {}) {
  const g = guards ?? createLibraryGuards(dataDir)
  if (scanner !== undefined) g.setPaperSessionScanner(scanner)
  const tools = {}
  const ctx = {
    tools: { register: (x) => { tools[x.name] = x } },
    // getThrows：模拟 Cordis 的**服务解析器自己抛错**（缺失服务是返回 undefined，不抛）
    get: (name) => {
      if (getThrows) throw new Error('resolver exploded')
      return name === 'approval' ? approval : undefined
    },
  }
  registerTools(ctx, { dataDir }, g)
  return { tools, tool: tools.library_manage, guards: g }
}

/** 执行上下文替身（形状见 dsh-tools 的 ToolRunContext）。默认会话 id 是一个**伴读会话**。 */
function execOf(over = {}) {
  return {
    agent: { id: 'dpr-' + Buffer.from('T/P').toString('base64url') },
    callId: 'call-1',
    signal: new AbortController().signal,
    deferContext() {},
    concludeTurn() {},
    ...over,
  }
}

const catchErr = async (fn) => { try { await fn(); return null } catch (e) { return e } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, { timeout = 2000, step = 5 } = {}) {
  const at = Date.now()
  while (Date.now() - at < timeout) {
    if (fn()) return true
    await sleep(step)
  }
  return false
}

/** 一个带 .pdf 的可收录源文件。 */
function srcPdf(root, name = 'local.pdf', body = PDF('source')) {
  const p = join(root, name)
  writeFileSync(p, body)
  return p
}

/* ═══════════════════════════════════════════════════════════════════════════
   A. 工具面 / schema / 入参（无审批）
   ═══════════════════════════════════════════════════════════════════════════ */

test('A1 工具 schema 快照：6 个参数、无任何「模型自填确认」字段、输出 schema 冻结', () => {
  const { data } = mkLib()
  const { tool } = makeTools(data, { approval: fakeApproval().service })
  assert.equal(tool.name, 'library_manage')
  // defineTool 会把 parameters 编译成 JSON schema：属性表就在 properties 上
  const keys = Object.keys(tool.parameters.properties).sort()
  assert.deepEqual(keys, ['action', 'name', 'new_name', 'source_path', 'to_topic', 'topic'])
  for (const banned of ['confirm', 'confirmName', 'token', 'approve', 'confirm_name', 'approval']) {
    assert.ok(!keys.includes(banned), `参数里绝不能出现「模型自填确认」字段：${banned}`)
  }
  assert.deepEqual(tool.parameters.required, ['action'], '只有 action 在 schema 层必填，其余在 execute 内按 action 自查')
  // 输出 schema：required 字段齐全，且是扁平对象（DSL 不支持 oneOf 成员上的 required）
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(tool.output.schema.additionalProperties, false)
  for (const f of ['ok', 'action', 'topic', 'files', 'trashDir', 'trashRel', 'approval', 'detachedSessions', 'summary', 'otherEntries', 'dirRemoved']) {
    assert.ok(tool.output.schema.properties[f], `输出 schema 缺字段 ${f}`)
  }
})

test('A2 action 闭集：7 个值可识别；migrate/clear_topic/空串被拒且不写盘；dpr- 会话下缺 name 仍 400、不调审批', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service })
  assert.deepEqual(tool.parameters.properties.action.enum,
    ['create_topic', 'add_paper', 'move_paper', 'rename_paper', 'rename_topic', 'delete_paper', 'delete_topic'])
  const before = snap(data)
  for (const bad of ['migrate', 'migrate_rollback', 'clear_topic', '']) {
    const err = await catchErr(() => tool.execute({ action: bad, topic: 'T' }, execOf()))
    assert.ok(err, `action=${JSON.stringify(bad)} 必须被拒`)
    assert.equal(err.code, 'bad-request', `action=${JSON.stringify(bad)} 必须是 bad-request：${err.message}`)
    assert.match(err.message, /^\[library_manage:bad-request\] /)
  }
  // §1.6 冻结：写动作**不**复用 locate() 的会话反解 —— 在 dpr- 会话里也必须显式给 name
  const err = await catchErr(() => tool.execute({ action: 'delete_paper', topic: 'T' }, execOf()))
  assert.ok(err)
  assert.equal(err.code, 'bad-request')
  assert.match(err.message, /name/)
  assert.equal(ap.requests.length, 0, '缺参不该弹审批')
  assert.deepEqual(snap(data), before, '被拒的调用零副作用')
})

test('A3 必填字段矩阵：7 个 action 各缺必填 → bad-request 点名缺哪个字段，库快照不变', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  mkdirSync(join(data, 'S'), { recursive: true })
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service })
  const before = snap(data)
  const cases = [
    ['create_topic', {}, 'topic'],
    ['add_paper', { topic: 'T' }, 'source_path'],
    ['move_paper', { topic: 'T', name: 'P' }, 'to_topic'],
    ['rename_paper', { topic: 'T', name: 'P' }, 'new_name'],
    ['rename_topic', { topic: 'T' }, 'new_name'],
    ['delete_paper', { topic: 'T' }, 'name'],
    ['delete_topic', {}, 'topic'],
  ]
  for (const [action, args, field] of cases) {
    const err = await catchErr(() => tool.execute({ action, ...args }, execOf()))
    assert.ok(err, `${action} 缺 ${field} 必须被拒`)
    assert.equal(err.code, 'bad-request', `${action}: ${err.message}`)
    assert.match(err.message, new RegExp(field), `${action} 的错误必须点名缺哪个字段：${err.message}`)
  }
  assert.equal(ap.requests.length, 0, '参数不全不打扰用户')
  assert.deepEqual(snap(data), before)
})

test('A4 非字符串/畸形参数：topic:123 / name:null / source_path:{} → bad-request 或 bad-name，不抛 TypeError', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service })
  const before = snap(data)
  const cases = [
    { action: 'delete_paper', topic: 123, name: 'P' },
    { action: 'delete_paper', topic: 'T', name: null },
    { action: 'add_paper', topic: 'T', source_path: {} },
    { action: 'rename_topic', topic: 'T', new_name: 42 },
  ]
  for (const args of cases) {
    const err = await catchErr(() => tool.execute(args, execOf()))
    assert.ok(err, `必须被拒：${JSON.stringify(args)}`)
    assert.ok(['bad-request', 'bad-name'].includes(err.code), `${JSON.stringify(args)} → ${err.code}: ${err.message}`)
    assert.match(err.message, /^\[library_manage:/)
    assert.ok(!(err instanceof TypeError), '不得把 TypeError 抛给调用方')
  }
  assert.equal(ap.requests.length, 0)
  assert.deepEqual(snap(data), before)
})

test('A5 render 双语：默认 zh；DPR_LIBRARY_MANAGE_LANG=en 切 en；render 与 summary 同源', async () => {
  const { data, root } = mkLib()
  mkdirSync(join(data, 'T'), { recursive: true })
  const { tool } = makeTools(data, { approval: fakeApproval().service })
  try {
    const zh = await tool.execute({ action: 'create_topic', topic: 'T/Lab' }, execOf())
    assert.match(zh.summary, /已创建专题/)
    assert.deepEqual(tool.output.render({}, zh).map((b) => b.text), [zh.summary])
    process.env.DPR_LIBRARY_MANAGE_LANG = 'en'
    const src = srcPdf(root, 'paper.pdf', PDF('en'))
    const en = await tool.execute({ action: 'add_paper', topic: 'T', source_path: src }, execOf())
    assert.match(en.summary, /^Added T\/paper: \d+ bytes/)
    assert.equal(en.bytes, statSync(src).size)
    assert.match(en.summary, /left untouched/)
    process.env.DPR_LIBRARY_MANAGE_LANG = 'en'
    { // 库层错误在 en 模式只追加英文要点，不谎称已本地化（§4.1）
      const err = await catchErr(() => tool.execute({ action: 'delete_paper', topic: 'T', name: 'nope' }, execOf()))
      assert.equal(err.code, 'not-found')
      assert.match(err.message, /\(en: Topic\/paper not found\)$/)
    }
  } finally {
    delete process.env.DPR_LIBRARY_MANAGE_LANG
  }
})

/* ═══════════════════════════════════════════════════════════════════════════
   B. 审批四态 × 5 个必须审批的 action（核心）
   ═══════════════════════════════════════════════════════════════════════════ */

/** 每个「需要审批」的 action 一个夹具 + 调用器（都在临时库里，互不影响）。 */
function approvalCase(action, root) {
  const lib = mkLib()
  const data = lib.data
  const src = srcPdf(root, `${action}-src.pdf`, PDF(action))
  switch (action) {
    case 'delete_paper':
      newPaper(data, 'T', 'P')
      return { data, call: (tool, exec) => tool.execute({ action, topic: 'T', name: 'P' }, exec) }
    case 'delete_topic': {
      mkdirSync(join(data, 'T'), { recursive: true })
      writeFileSync(join(data, 'T', '.DS_Store'), 'junk')   // 隐藏条目也进回收站（仍算「空专题」）
      return { data, call: (tool, exec) => tool.execute({ action, topic: 'T' }, exec) }
    }
    case 'rename_paper':
      newPaper(data, 'T', 'P')
      return { data, call: (tool, exec) => tool.execute({ action, topic: 'T', name: 'P', new_name: 'Q' }, exec) }
    case 'rename_topic':
      newPaper(data, 'T', 'P')
      return { data, call: (tool, exec) => tool.execute({ action, topic: 'T', new_name: 'T2' }, exec) }
    case 'move_paper':
      newPaper(data, 'T', 'P')
      mkdirSync(join(data, 'S'), { recursive: true })
      return { data, call: (tool, exec) => tool.execute({ action, topic: 'T', name: 'P', to_topic: 'S' }, exec) }
    default:
      throw new Error(`unknown action ${action}`)
  }
}

const APPROVAL_ACTIONS = ['delete_paper', 'delete_topic', 'rename_paper', 'rename_topic', 'move_paper']
const OUTCOME_CASES = [
  ['rejected', 'approval-rejected', 403, /用户拒绝了本次|rejected/],
  ['cancelled', 'approval-cancelled', 409, /审批被取消|cancelled/],
  ['unavailable', 'approval-unavailable', 503, /审批通道不可用|unavailable/],
]

test('B1–B3 审批四态 × 5 个 action：非 allowed-once 一律零副作用（sha256 快照不变，含 .trash）', async () => {
  const { root } = mkLib()
  for (const action of APPROVAL_ACTIONS) {
    for (const [outcome, code, status, msgRe] of OUTCOME_CASES) {
      const c = approvalCase(action, root)
      const ap = fakeApproval(outcome)
      ap.state.outcome = outcome
      const guards = createLibraryGuards(c.data)
      guards.setPaperSessionScanner(async () => [])
      const { tool } = makeTools(c.data, { approval: ap.service, guards })
      const before = snap(c.data)
      const at = Date.now()
      const err = await catchErr(() => c.call(tool, execOf()))
      assert.ok(err, `${action}/${outcome} 必须被拒`)
      assert.ok(err instanceof ManageError, `${action}/${outcome} 必须抛 ManageError：${err}`)
      assert.equal(err.code, code, `${action}/${outcome}: ${err.message}`)
      assert.equal(err.status, status)
      assert.match(err.message, /^\[library_manage:/)
      assert.match(err.message, msgRe)
      assert.match(err.message, /未做任何改动|nothing changed/)
      assert.equal(ap.requests.length, 1, `${action}/${outcome} 必须恰好问一次审批`)
      const req = ap.requests[0]
      assert.equal(req.toolName, 'library_manage')
      assert.equal(req.callId, 'call-1')
      assert.deepEqual(req.agent, { id: 'dpr-' + Buffer.from('T/P').toString('base64url') })
      assert.ok(req.signal instanceof AbortSignal, 'signal 必须原样透传（取消传播）')
      assert.ok(typeof req.reason === 'string' && req.reason.length > 0)
      assert.equal(req.displayReason, req.reason, 'displayReason 与 reason 同源（0.1.5 忽略、0.2.x 展示）')
      assert.ok(Date.now() - at < 5000)
      assert.deepEqual(snap(c.data), before, `${action}/${outcome}：库内逐字节不变（含 .trash）`)
      assert.ok(!existsSync(join(c.data, '.trash')), `${action}/${outcome}：不得创建回收站目录`)
      rmSync(c.data, { recursive: true, force: true })
    }
  }
})

test('B4 allowed-once：动作真的发生，结果带 approval=allowed-once（5 个 action）', async () => {
  const { root } = mkLib()
  for (const action of APPROVAL_ACTIONS) {
    const c = approvalCase(action, root)
    const ap = fakeApproval('allowed-once')
    const guards = createLibraryGuards(c.data)
    guards.setPaperSessionScanner(async () => [])
    const { tool } = makeTools(c.data, { approval: ap.service, guards })
    const before = snap(c.data)
    const out = await c.call(tool, execOf())
    assert.equal(out.ok, true, action)
    assert.equal(out.action, action)
    assert.equal(out.approval, 'allowed-once')
    assert.equal(ap.requests.length, 1)
    assert.equal(out.detachedSessions, 0)
    assert.notDeepEqual(snap(c.data), before, `${action}：批准后必须有实际变化`)
    rmSync(c.data, { recursive: true, force: true })
  }
})

test('B5 无审批服务（ctx.get 缺失/返回 undefined）→ approval-unavailable，零副作用', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  const tools = {}
  const guards = createLibraryGuards(data)
  guards.setPaperSessionScanner(async () => [])   // 会话前置通过，才能走到审批门
  // 假 ctx **没有** get：生产里用 typeof ctx.get === 'function' 守卫（R9），不得 TypeError
  registerTools({ tools: { register: (x) => { tools[x.name] = x } } }, { dataDir: data }, guards)
  const before = snap(data)
  const err = await catchErr(() => tools.library_manage.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf()))
  assert.ok(err)
  assert.equal(err.code, 'approval-unavailable')
  assert.equal(err.status, 503)
  assert.deepEqual(snap(data), before)
  assert.ok(!existsSync(join(data, '.trash')))
})

test('B6 无 agent → approval-unavailable，零副作用（不调 request）', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const before = snap(data)
  const err = await catchErr(() => tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf({ agent: undefined })))
  assert.ok(err)
  assert.equal(err.code, 'approval-unavailable')
  assert.equal(ap.requests.length, 0, '没有 agent 不能发起审批请求')
  assert.deepEqual(snap(data), before)
})

test('B7 request() 抛错（无 open turn / 审计写失败）→ approval-unavailable（fail closed）', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  const ap = fakeApproval()
  ap.state.throws = true
  const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const before = snap(data)
  const err = await catchErr(() => tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf()))
  assert.ok(err)
  assert.equal(err.code, 'approval-unavailable')
  assert.equal(err.status, 503)
  assert.deepEqual(snap(data), before)
})

test('B8 闭集外的返回值（旧/坏实现返回 "allow"）→ approval-unavailable，零副作用', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  const ap = fakeApproval('allow')
  const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const before = snap(data)
  const err = await catchErr(() => tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf()))
  assert.ok(err)
  assert.equal(err.code, 'approval-unavailable', `闭集外的值绝不能当允许：${err.message}`)
  assert.deepEqual(snap(data), before)
})

test('B9 signal 已中止 → approval-cancelled，且**不调** request、零副作用', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service })
  const before = snap(data)
  const ac = new AbortController()
  ac.abort()
  const err = await catchErr(() => tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf({ signal: ac.signal })))
  assert.ok(err)
  assert.equal(err.code, 'approval-cancelled')
  assert.equal(ap.requests.length, 0, '已取消的调用连审批都不该弹')
  assert.deepEqual(snap(data), before)
})

test('B10 审批前的只读校验失败 → not-found 且**不打扰用户**（requests=0）；B11 无 .trash 目录', async () => {
  const { data } = mkLib()
  mkdirSync(join(data, 'T'), { recursive: true })
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service })
  const before = snap(data)
  for (const args of [
    { action: 'delete_paper', topic: 'T', name: 'ghost' },
    { action: 'rename_paper', topic: 'T', name: 'ghost', new_name: 'Q' },
    { action: 'move_paper', topic: 'T', name: 'ghost', to_topic: 'T' },
    { action: 'delete_topic', topic: 'ghost' },
  ]) {
    const err = await catchErr(() => tool.execute(args, execOf()))
    assert.ok(err, `${args.action} 必须被拒`)
    assert.ok(['not-found', 'bad-request'].includes(err.code), `${args.action}: ${err.code} ${err.message}`)
  }
  assert.equal(ap.requests.length, 0, '校验失败不该展示成审批弹窗')
  assert.deepEqual(snap(data), before)
  assert.ok(!existsSync(join(data, '.trash')))
})

test('B12 创建/收录不审批：approval=not-required、requests=0', async () => {
  const { data, root } = mkLib()
  const ap = fakeApproval('rejected')   // 即使审批服务「会拒绝」，这两个动作也不该问它
  const { tool } = makeTools(data, { approval: ap.service })
  const created = await tool.execute({ action: 'create_topic', topic: 'T' }, execOf())
  assert.equal(created.approval, 'not-required')
  const src = srcPdf(root, 'p.pdf', PDF('add'))
  const added = await tool.execute({ action: 'add_paper', topic: 'T', source_path: src }, execOf())
  assert.equal(added.approval, 'not-required')
  assert.equal(added.name, 'p')
  assert.equal(ap.requests.length, 0)
})

/* ═══════════════════════════════════════════════════════════════════════════
   C. 词法 / 穿越 / 符号链接 / 源文件边界
   ═══════════════════════════════════════════════════════════════════════════ */

test('C1 topic 穿越：.. / 多级上跳 / 绝对路径 / 空段 / NUL / 编码变形 / .trash 一律拒，快照不变', async () => {
  const { data, root } = mkLib()
  newPaper(data, 'T', 'P')
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service })
  const before = snap(data)
  const badTopics = ['../x', 'T/../../x', '/etc', 'A//B', 'T\u0000x', '%2E%2E%2F', '.trash', '.trash/x', '']
  for (const topic of badTopics) {
    for (const [action, args] of [
      ['create_topic', {}],
      ['add_paper', { source_path: srcPdf(root, 'x.pdf', PDF('x')) }],
      ['delete_paper', { name: 'P' }],
      ['delete_topic', {}],
    ]) {
      const err = await catchErr(() => tool.execute({ action, topic, ...args }, execOf()))
      assert.ok(err, `${action} topic=${JSON.stringify(topic)} 必须被拒`)
      assert.ok(['bad-name', 'bad-request', 'escape-rejected'].includes(err.code), `${action} ${JSON.stringify(topic)} → ${err.code}`)
    }
  }
  assert.deepEqual(snap(data), before)
})

test('C2 name 穿越：../p / a/b / .. / . / 空串 / NUL / 带 .pdf → bad-name，快照不变', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service })
  const before = snap(data)
  for (const name of ['../p', 'a/b', '..', '.', '', 'p\u0000', 5]) {
    const err = await catchErr(() => tool.execute({ action: 'delete_paper', topic: 'T', name }, execOf()))
    assert.ok(err, `name=${JSON.stringify(name)} 必须被拒`)
    assert.ok(['bad-name', 'bad-request'].includes(err.code), `${JSON.stringify(name)} → ${err.code}`)
  }
  // 改名目标带 .pdf 后缀：有意收紧（否则会生成 X.pdf/X.pdf.pdf 的嵌套怪名）
  const err = await catchErr(() => tool.execute({ action: 'rename_paper', topic: 'T', name: 'P', new_name: 'X.pdf' }, execOf()))
  assert.equal(err.code, 'bad-name')
  assert.equal(ap.requests.length, 0, '词法失败的改名不该弹审批')
  assert.deepEqual(snap(data), before)
})

test('C8 变体后缀大小写敏感（与 isPaperPDF 同口径）：-zh/-en/-dual 拒；大写 -ZH 允许且改名后仍在库', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  const { tool, tools } = makeTools(data, { approval: fakeApproval().service, scanner: async () => [] })
  for (const bad of ['P-zh', 'P-en', 'P-dual']) {
    const err = await catchErr(() => tool.execute({ action: 'rename_paper', topic: 'T', name: 'P', new_name: bad }, execOf()))
    assert.equal(err.code, 'bad-name', `${bad} 必须被拒：${err && err.message}`)
  }
  // 大写 `-ZH` 不在 isPaperPDF 的排除集里（大小写敏感）⇒ 允许改名，且改名后文献不得从库视图消失
  const out = await tool.execute({ action: 'rename_paper', topic: 'T', name: 'P', new_name: 'P-ZH' }, execOf())
  assert.equal(out.new_name, 'P-ZH')
  const listed = (await tools.list_papers.execute({}, execOf())).papers
  assert.ok(listed.includes('T/P-ZH'), `大写 -ZH 改名后文献必须仍在库里：${listed}`)
})

test('C3 专题符号链接（指向库外）→ escape-rejected（创建/源/目标三处都测），库外目录不被写', async () => {
  const { data, root } = mkLib()
  const outside = join(root, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'keep.txt'), 'outside')
  symlinkSync(outside, join(data, 'Evil'), 'dir')
  newPaper(data, 'T', 'P')
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service })
  const outsideBefore = snap(outside)
  const before = snap(data)
  // create_topic 目标
  let err = await catchErr(() => tool.execute({ action: 'create_topic', topic: 'Evil/Sub' }, execOf()))
  assert.ok(err); assert.ok(['escape-rejected', 'bad-name'].includes(err.code), `create: ${err.code}`)
  // add_paper 目标专题
  const src = srcPdf(root, 'a.pdf', PDF('a'))
  err = await catchErr(() => tool.execute({ action: 'add_paper', topic: 'Evil', source_path: src }, execOf()))
  assert.ok(err); assert.equal(err.code, 'escape-rejected')
  // move_paper 目标专题
  err = await catchErr(() => tool.execute({ action: 'move_paper', topic: 'T', name: 'P', to_topic: 'Evil' }, execOf()))
  assert.ok(err); assert.equal(err.code, 'escape-rejected')
  // rename_topic 源
  err = await catchErr(() => tool.execute({ action: 'rename_topic', topic: 'Evil', new_name: 'Ok' }, execOf()))
  assert.ok(err); assert.equal(err.code, 'escape-rejected')
  assert.deepEqual(snap(outside), outsideBefore, '库外目录绝不能被写')
  assert.deepEqual(snap(data), before)
})

test('C4 论文目录是符号链接 → escape-rejected（delete/rename/move 三处）', async () => {
  const { data, root } = mkLib()
  const outside = join(root, 'outside-paper')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'P.pdf'), PDF('linked'))
  mkdirSync(join(data, 'T'), { recursive: true })
  mkdirSync(join(data, 'S'), { recursive: true })
  symlinkSync(outside, join(data, 'T', 'P'), 'dir')
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service })
  const before = snap(data)
  const outsideBefore = snap(outside)
  for (const args of [
    { action: 'delete_paper', topic: 'T', name: 'P' },
    { action: 'rename_paper', topic: 'T', name: 'P', new_name: 'Q' },
    { action: 'move_paper', topic: 'T', name: 'P', to_topic: 'S' },
  ]) {
    const err = await catchErr(() => tool.execute(args, execOf()))
    assert.ok(err, `${args.action} 必须被拒`)
    assert.equal(err.code, 'escape-rejected', `${args.action}: ${err.code} ${err.message}`)
  }
  assert.equal(ap.requests.length, 0, '符号链接专题/论文在审批前就被拒')
  assert.deepEqual(snap(data), before)
  assert.deepEqual(snap(outside), outsideBefore)
})

test('C5 源文件边界：不存在/目录/符号链接/空/非 PDF → 各自拒绝码，库快照不变', async () => {
  const { data, root } = mkLib()
  mkdirSync(join(data, 'T'), { recursive: true })
  const dirSrc = join(root, 'a-dir')
  mkdirSync(dirSrc, { recursive: true })
  const linkSrc = join(root, 'link.pdf')
  symlinkSync(srcPdf(root, 'real.pdf', PDF('real')), linkSrc, 'file')
  const emptySrc = join(root, 'empty.pdf')
  writeFileSync(emptySrc, '')
  const textSrc = join(root, 'text.pdf')
  writeFileSync(textSrc, 'this is not a pdf at all\n')
  const { tool } = makeTools(data, { approval: fakeApproval().service })
  const before = snap(data)
  const cases = [
    [join(root, 'missing.pdf'), 'source-not-found'],
    [dirSrc, 'source-invalid'],
    [linkSrc, 'source-invalid'],
    [emptySrc, 'source-empty'],
    [textSrc, 'source-not-pdf'],
  ]
  for (const [source_path, code] of cases) {
    const err = await catchErr(() => tool.execute({ action: 'add_paper', topic: 'T', source_path }, execOf()))
    assert.ok(err, `${source_path} 必须被拒`)
    assert.equal(err.code, code, `${source_path}: ${err.message}`)
  }
  assert.deepEqual(snap(data), before, '源文件全部被拒 ⇒ 库里零变化')
  assert.ok(!existsSync(join(data, '.trash')))
})

test('C6 源文件只读：add 成功后源文件 sha256 不变、仍在原处', async () => {
  const { data, root } = mkLib()
  mkdirSync(join(data, 'T'), { recursive: true })
  const src = srcPdf(root, 'paper.pdf', PDF('readonly'))
  const hashBefore = sha256(src)
  const { tool } = makeTools(data, { approval: fakeApproval().service })
  const out = await tool.execute({ action: 'add_paper', topic: 'T', source_path: src }, execOf())
  assert.equal(out.bytes, statSync(src).size)
  assert.ok(existsSync(src))
  assert.equal(sha256(src), hashBefore)
})

/* ═══════════════════════════════════════════════════════════════════════════
   D. 在途 / 会话 / 翻译（复用 host 语义）
   ═══════════════════════════════════════════════════════════════════════════ */

/** 起一个真 HTTP 路由（假 webServer/connection/sessionController），用于工具 × 路由共享锁的用例。 */
function boot(dataDir, guards, { sessionController } = {}) {
  let spec = null
  registerRoutes({
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: sessionController ?? { list: async () => ({ items: [] }) },
    workspaceController: {}, workspaceRegistry: {}, effect: (fn) => fn(),
  }, { dataDir }, guards)
  const srv = createServer((req, res) => spec.handler(req, res))
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${srv.address().port}/paper-reader`
    const call = async (method, p, body) => {
      const r = await fetch(base + p, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      })
      const txt = await r.text()
      let json = null
      try { json = JSON.parse(txt) } catch { /* 非 JSON */ }
      return { status: r.status, body: json, txt }
    }
    resolve({ srv, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) })
  }))
}

const session = (topic, name, n = 1, running = true) => ({
  sessionId: `dpr-${Buffer.from(`${topic}/${name}`).toString('base64url')}-${n}`,
  updatedAt: Date.now(), running, blank: false,
})

test('D1 路由在途 → 工具 busy：同一 guards 实例，路由卡在会话查询时工具拿不到锁，快照不变', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  let release
  const gate = new Promise((r) => { release = r })
  const guards = createLibraryGuards(data)
  const { tool } = makeTools(data, { approval: fakeApproval().service, guards })
  // 安全阀：**锁失效时**工具会跟着路由一起等同一个 gate（互等死锁）。3s 后强制放行，
  // 让「锁不生效」表现为**断言变红**而不是把整个测试文件挂死（变异测试必须能收敛）。
  const gateGuard = setTimeout(() => release(), 3000)
  gateGuard.unref?.()
  const srv = await boot(data, guards, { sessionController: { list: async () => { await gate; return { items: [] } } } })
  let pending = null
  try {
    const before = snap(data)
    pending = srv.post('/api/library/delete-paper', { topic: 'T', name: 'P' })
    assert.ok(await waitFor(() => guards.isBusy('topic\u0000T')), '路由必须已拿到 topic 锁')
    const err = await catchErr(() => tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf()))
    assert.ok(err)
    assert.equal(err.code, 'busy')
    assert.equal(err.status, 409)
    assert.deepEqual(snap(data), before)
    release()
    const r = await pending
    pending = null
    assert.equal(r.status, 200, r.txt)
  } finally {
    clearTimeout(gateGuard)
    release?.()
    // 断言失败时也要把未消费的响应收掉：否则 keep-alive 连接让 server.close 等不到、测试进程不退
    if (pending) await pending.catch(() => {})
    srv.srv.close()
  }
})

test('D2 工具在途（审批挂起）→ 路由 busy：共享锁双向生效', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  const ap = fakeApproval('allowed-once')
  let release
  ap.state.gate = new Promise((r) => { release = r })
  const guards = createLibraryGuards(data)
  guards.setPaperSessionScanner(async () => [])
  const { tool } = makeTools(data, { approval: ap.service, guards })
  const srv = await boot(data, guards)
  let pending = null
  try {
    const before = snap(data)
    pending = tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf())
    assert.ok(await waitFor(() => ap.requests.length === 1), '工具必须已进入审批等待（锁已持有）')
    const r = await srv.post('/api/library/delete-paper', { topic: 'T', name: 'P' })
    assert.equal(r.status, 409, r.txt)
    assert.equal(r.body.code, 'busy')
    assert.deepEqual(snap(data), before, '路由被锁挡住 ⇒ 零改动')
    release()
    const out = await pending
    pending = null
    assert.equal(out.ok, true)
  } finally {
    release?.()
    if (pending) await pending.catch(() => {})
    srv.srv.close()
  }
})

test('D3 方向锁：工具在途持 topic 键时，同专题的 delete_paper 路由 → busy（topic 键扩展生效）', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  const ap = fakeApproval('allowed-once')
  let release
  ap.state.gate = new Promise((r) => { release = r })
  const guards = createLibraryGuards(data)
  guards.setPaperSessionScanner(async () => [])
  const { tool } = makeTools(data, { approval: ap.service, guards })
  const srv = await boot(data, guards)
  let pending = null
  try {
    // rename_topic 持 topicKey('T')（+ 目标键）；同专题的 delete_paper 需要 topicKey('T') ⇒ 必须 busy
    pending = tool.execute({ action: 'rename_topic', topic: 'T', new_name: 'T2' }, execOf())
    assert.ok(await waitFor(() => ap.requests.length === 1))
    const r = await srv.post('/api/library/delete-paper', { topic: 'T', name: 'P' })
    assert.equal(r.status, 409, r.txt)
    assert.equal(r.body.code, 'busy')
    release()
    await pending
    pending = null
  } finally {
    release?.()
    if (pending) await pending.catch(() => {})
    srv.srv.close()
  }
})

test('D4 运行中会话 → 409 session-running，extra.sessions 同形，快照不变', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  const ap = fakeApproval()
  const guards = createLibraryGuards(data)
  guards.setPaperSessionScanner(async () => [{ running: true }, { running: false }, { running: false }])
  const { tool } = makeTools(data, { approval: ap.service, guards })
  const before = snap(data)
  const err = await catchErr(() => tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf()))
  assert.ok(err)
  assert.equal(err.code, 'session-running')
  assert.equal(err.status, 409)
  assert.deepEqual(err.extra.sessions, { total: 3, running: 1 })
  assert.match(err.message, /该文献有 1 个正在运行的伴读会话/)
  assert.equal(ap.requests.length, 0, '会话在跑不该弹审批')
  assert.deepEqual(snap(data), before)
})

test('D5 会话不可知：scanner 抛错 / 未注入（headless）→ 503 session-unknown（fail closed），快照不变', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  const before = snap(data)
  // ① scanner 抛错
  const ap1 = fakeApproval()
  const g1 = createLibraryGuards(data)
  g1.setPaperSessionScanner(async () => { throw new Error('controller down') })
  const t1 = makeTools(data, { approval: ap1.service, guards: g1 }).tool
  let err = await catchErr(() => t1.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf()))
  assert.ok(err); assert.equal(err.code, 'session-unknown'); assert.equal(err.status, 503)
  // ② 未注入 scanner（headless / web 服务尚未就绪）
  const ap2 = fakeApproval()
  const t2 = makeTools(data, { approval: ap2.service, guards: createLibraryGuards(data) }).tool
  err = await catchErr(() => t2.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf()))
  assert.ok(err); assert.equal(err.code, 'session-unknown')
  assert.equal(ap1.requests.length + ap2.requests.length, 0)
  assert.deepEqual(snap(data), before)
})

test('D6 翻译在途 → 409 translation-busy，快照不变', async (t) => {
  // win32：假 babeldoc 的 `#!/bin/sh` 造不出来（与既有 library-clear-and-busy B5 同因），显式 skip 并注明未验证
  if (process.platform === 'win32') {
    return t.skip('win32：假 babeldoc 的路径/解释器与 src/translate.ts 的 win32 候选不一致，本机与 CI 均未跑过 win32 —— 未验证')
  }
  const { data, root } = mkLib()
  newPaper(data, 'T', 'P')
  const pidFile = join(root, 'pid')
  process.env.DPR_LMT_TX_PIDFILE = pidFile
  const binPath = join(root, '.venv-pdf2zh', 'bin', 'babeldoc')
  mkdirSync(join(root, '.venv-pdf2zh', 'bin'), { recursive: true })
  writeFileSync(binPath, '#!/bin/sh\ncase "$1" in\n  --version) echo "babeldoc fake 1.0"; exit 0 ;;\n  --help) echo "--no-watermark --skip-figure-text"; exit 0 ;;\n  *) echo $$ > "$DPR_LMT_TX_PIDFILE"; exec sleep 30 ;;\nesac\n')
  chmodSync(binPath, 0o755)
  const guards = createLibraryGuards(data)
  guards.setPaperSessionScanner(async () => [])
  const { tool } = makeTools(data, { approval: fakeApproval().service, guards })
  try {
    const { startTranslation, zhStatus } = await import(pathToFileURL(dist('translate.js')).href)
    const ref = LIB.resolvePaper(data, { topic: 'T', name: 'P' })
    const started = await startTranslation(ref, data, { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm' })
    assert.equal(started.started, true, JSON.stringify(started))
    assert.equal(zhStatus(ref).busy, true)
    const before = snap(join(data, 'T'))
    const err = await catchErr(() => tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf()))
    assert.ok(err)
    assert.equal(err.code, 'translation-busy')
    assert.equal(err.status, 409)
    assert.deepEqual(snap(join(data, 'T')), before, '前置拒绝 = 第一字节都没动')
  } finally {
    // 假 babeldoc 的 pidfile 是**异步**落盘的（脚本被拉起后立刻 exec sleep）⇒ 轮询等它出现再 kill；
    // 抢跑就读会读到空串 ⇒ 不 kill ⇒ 整个测试文件要陪着 `sleep 30` 挂 30 秒（实测过）。
    let pid = 0
    for (let i = 0; i < 50 && !(pid > 1); i++) {
      if (existsSync(pidFile)) pid = Number(readFileSync(pidFile, 'utf8').trim()) || 0
      if (!(pid > 1)) await sleep(20)
    }
    if (pid > 1) { try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ } }
    delete process.env.DPR_LMT_TX_PIDFILE
  }
})

test('D7 detachedSessions 口径：rename/move/delete 取 scanner 的 total（3 个会话 → 3）', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  newPaper(data, 'T', 'Q')
  mkdirSync(join(data, 'S'), { recursive: true })
  const guards = createLibraryGuards(data)
  guards.setPaperSessionScanner(async () => [{ running: false }, { running: false }, { running: false }])
  const { tool } = makeTools(data, { approval: fakeApproval().service, guards })
  const renamed = await tool.execute({ action: 'rename_paper', topic: 'T', name: 'P', new_name: 'P2' }, execOf())
  assert.equal(renamed.detachedSessions, 3)
  const moved = await tool.execute({ action: 'move_paper', topic: 'T', name: 'Q', to_topic: 'S' }, execOf())
  assert.equal(moved.detachedSessions, 3)
  const deleted = await tool.execute({ action: 'delete_paper', topic: 'S', name: 'Q' }, execOf())
  assert.equal(deleted.detachedSessions, 3)
})

test('D8 钩子：rename_topic/delete_topic 成功 → topicPathChanged 收到专题；删除文献不触发', async () => {
  const { data } = mkLib()
  newPaper(data, 'A', 'P')
  mkdirSync(join(data, 'E'), { recursive: true })
  const guards = createLibraryGuards(data)
  guards.setPaperSessionScanner(async () => [])
  const seen = []
  guards.setTopicPathChangedHook((t) => seen.push(t))
  const { tool } = makeTools(data, { approval: fakeApproval().service, guards })
  await tool.execute({ action: 'delete_paper', topic: 'A', name: 'P' }, execOf())
  assert.deepEqual(seen, [], '删一篇论文不该清专题的工作区缓存')
  await tool.execute({ action: 'rename_topic', topic: 'A', new_name: 'B' }, execOf())
  assert.deepEqual(seen, ['A'])
  await tool.execute({ action: 'delete_topic', topic: 'E' }, execOf())
  assert.deepEqual(seen, ['A', 'E'])
})

test('D9 读路径 busy 提示语义原样保留：持 topic 锁时 isBusy(T)=true，paper scope（T/P）仍 false', () => {
  const { data } = mkLib()
  const guards = createLibraryGuards(data)
  assert.equal(guards.tryAcquire([guards.topicKey('T')]), true)
  assert.equal(guards.isBusy('T'), true)
  assert.equal(guards.isBusy('T/P'), false, '历史子串语义不得趁重构「顺手修好」（R5/V5）')
  guards.release([guards.topicKey('T')])
  assert.equal(guards.isBusy('T'), false)
  // 多键原子性：任一被占则整体失败（不留半持有）
  assert.equal(guards.tryAcquire([guards.topicKey('T')]), true)
  assert.equal(guards.tryAcquire([guards.topicKey('T'), guards.topicKey('S')]), false)
  guards.release([guards.topicKey('T'), guards.topicKey('S')])
  assert.equal(guards.isBusy('T'), false)
})

test('D11 装配：index 显式创建一个 guards 并双传给 tools 与 routes（否则锁不共享，R8）', () => {
  const src = readFileSync(join(REPO, 'src', 'index.ts'), 'utf8')
  assert.match(src, /const guards = createLibraryGuards\(/, 'index 必须显式创建共享 guards')
  assert.match(src, /registerTools\(ctx, config, guards\)/, '工具必须拿到共享实例')
  assert.match(src, /registerRoutes\(rctx, config, guards\)/, '路由必须拿到同一个实例')
  assert.match(src, /library_manage/, '启动日志的手写工具清单必须包含新工具')
  const preset = readFileSync(join(REPO, 'presets', 'paper-reader', 'agent.cordis.yml'), 'utf8')
  assert.match(preset, /library_manage/, 'preset 头部工具清单与 persona 必须列出 library_manage')
  assert.match(preset, /审批/, 'persona 必须写明「删除/改名/移动要用户审批」')
  assert.match(preset, /不批量删除|逐篇/, 'persona 必须写明「不得批量删除未要求的东西」')
})

test('D10 迁移提示缓存失效：删掉一篇旧布局文献后 list_papers 重新扫描（2 → 1）', async () => {
  const { data } = mkLib()
  legacyPaper(data, 'T', 'P')
  legacyPaper(data, 'T', 'Q')
  const guards = createLibraryGuards(data)
  guards.setPaperSessionScanner(async () => [])
  const { tools, tool } = makeTools(data, { approval: fakeApproval().service, guards })
  const first = await tools.list_papers.execute({}, execOf())
  assert.equal(first.migration.papers, 2, `夹具：两篇旧布局：${JSON.stringify(first.migration)}`)
  await tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf())
  const second = await tools.list_papers.execute({}, execOf())
  assert.equal(second.migration.papers, 1, '写动作必须让迁移判据缓存失效（否则界面对旧数据提问）')
})

/* ═══════════════════════════════════════════════════════════════════════════
   E. 冲突 / 零覆盖 / 回滚 / 回收站可恢复
   ═══════════════════════════════════════════════════════════════════════════ */

test('E1 add 目标冲突：同名论文夹 / 平铺 pdf / 孤儿 sidecar → target-exists，原文件 sha256 不变', async () => {
  const { data, root } = mkLib()
  const src = srcPdf(root, 'P.pdf', PDF('new'))
  const srcHash = sha256(src)
  const { tool } = makeTools(data, { approval: fakeApproval().service })
  // ① 同名论文夹
  newPaper(data, 'T', 'P')
  let before = snap(data)
  let err = await catchErr(() => tool.execute({ action: 'add_paper', topic: 'T', source_path: src }, execOf()))
  assert.equal(err.code, 'target-exists'); assert.equal(err.status, 409)
  assert.deepEqual(snap(data), before)
  // ② 平铺 `<name>.pdf`
  const lib2 = mkLib()
  mkdirSync(join(lib2.data, 'T2'), { recursive: true })
  writeFileSync(join(lib2.data, 'T2', 'P.pdf'), PDF('flat'))
  const t2 = makeTools(lib2.data, { approval: fakeApproval().service }).tool
  before = snap(lib2.data)
  err = await catchErr(() => t2.execute({ action: 'add_paper', topic: 'T2', source_path: src }, execOf()))
  assert.equal(err.code, 'target-exists')
  assert.deepEqual(snap(lib2.data), before)
  // ③ 同名孤儿 sidecar（没有 pdf，只有缓存）
  const lib3 = mkLib()
  mkdirSync(join(lib3.data, 'T3'), { recursive: true })
  writeFileSync(join(lib3.data, 'T3', 'P.txt'), 'orphan')
  const t3 = makeTools(lib3.data, { approval: fakeApproval().service }).tool
  before = snap(lib3.data)
  err = await catchErr(() => t3.execute({ action: 'add_paper', topic: 'T3', source_path: src }, execOf()))
  assert.equal(err.code, 'target-exists')
  assert.deepEqual(snap(lib3.data), before)
  assert.equal(sha256(src), srcHash, '源文件绝不被改写')
})

test('E2 add 原子落盘：目标内容 == 源（sha256）、无 .tmp-* 残留、目录结构正确', async () => {
  const { data, root } = mkLib()
  mkdirSync(join(data, 'T'), { recursive: true })
  const src = srcPdf(root, 'Paper One.PDF', PDF('atomic'))
  const { tool } = makeTools(data, { approval: fakeApproval().service })
  const out = await tool.execute({ action: 'add_paper', topic: 'T', source_path: src }, execOf())
  assert.equal(out.name, 'Paper One', '省略 name 时取源文件名并去掉 .pdf（大小写不敏感）')
  const final = join(data, 'T', 'Paper One', 'Paper One.pdf')
  assert.ok(existsSync(final))
  assert.equal(sha256(final), sha256(src))
  const entries = readdirSync(join(data, 'T', 'Paper One'))
  assert.deepEqual(entries, ['Paper One.pdf'], '不得写任何 sidecar / 临时文件')
  assert.deepEqual(out.files, ['Paper One.pdf'])
})

test('E3 add 中断清理：copyImpl 抛 ENOSPC → add-partial，无 .tmp-*、无空论文夹、快照不变', async () => {
  const { data, root } = mkLib()
  mkdirSync(join(data, 'T'), { recursive: true })
  const src = srcPdf(root, 'x.pdf', PDF('x'))
  const before = snap(data)
  // 关键：注入的 copyImpl **先写出半个临时文件再失败**（否则「清理 tmp」这条分支根本没被走到，
  // 变异 M9/L9「失败时不删 tmp」会让用例空转——实测过，这正是变异测试要抓的空转）
  const err = catchErr(() => LM.addPaper(data, 'T', src, undefined, {
    copyImpl: (_from, to) => {
      writeFileSync(to, 'partial-tmp')
      throw Object.assign(new Error('ENOSPC: injected'), { code: 'ENOSPC' })
    },
  }))
  const e = await err
  assert.ok(e instanceof ManageError)
  assert.equal(e.code, 'add-partial')
  assert.equal(e.status, 500)
  assert.deepEqual(snap(data), before, '清理成功 = 零改动（不是「残留但装作成功」）')
  assert.ok(!existsSync(join(data, 'T', 'x')))
  assert.deepEqual(readdirSync(join(data, 'T')), [], '不得残留 .tmp-* 或空论文夹')
})

test('E4 move 目标冲突：目标已有论文夹 / 平铺 pdf / 孤儿产物 → target-exists，快照不变', async () => {
  const { root } = mkLib()
  // ① 目标已有同名论文夹
  {
    const { data } = mkLib()
    newPaper(data, 'T', 'P')
    newPaper(data, 'S', 'P')
    const { tool } = makeTools(data, { approval: fakeApproval().service })
    const before = snap(data)
    const err = await catchErr(() => tool.execute({ action: 'move_paper', topic: 'T', name: 'P', to_topic: 'S' }, execOf()))
    assert.equal(err.code, 'target-exists')
    assert.deepEqual(snap(data), before)
  }
  // ② 目标有平铺 `<name>.pdf`
  {
    const { data } = mkLib()
    newPaper(data, 'T', 'P')
    mkdirSync(join(data, 'S'), { recursive: true })
    writeFileSync(join(data, 'S', 'P.pdf'), PDF('flat'))
    const { tool } = makeTools(data, { approval: fakeApproval().service })
    const before = snap(data)
    const err = await catchErr(() => tool.execute({ action: 'move_paper', topic: 'T', name: 'P', to_topic: 'S' }, execOf()))
    assert.equal(err.code, 'target-exists')
    assert.deepEqual(snap(data), before)
  }
  // ③ 目标有同名孤儿 sidecar
  {
    const { data } = mkLib()
    newPaper(data, 'T', 'P')
    mkdirSync(join(data, 'S'), { recursive: true })
    writeFileSync(join(data, 'S', 'P.txt'), 'orphan')
    const { tool } = makeTools(data, { approval: fakeApproval().service })
    const before = snap(data)
    const err = await catchErr(() => tool.execute({ action: 'move_paper', topic: 'T', name: 'P', to_topic: 'S' }, execOf()))
    assert.equal(err.code, 'target-exists')
    assert.deepEqual(snap(data), before)
  }
  void root
})

test('E5 move 全产物：8 类产物 + 译文变体 + 隐藏条目 + 未知文件整体搬走，逐个 sha256 一致', async () => {
  const { data } = mkLib()
  const dir = newPaper(data, 'T', 'P', {
    suffixes: ['.pdf', '.txt', '.pages.json', '.transcript.json', '.mineru.md', '.mineru.json', '.embeddings.json', '.study.json'],
    extra: {
      'P-en.pdf': PDF('en'),
      'P-zh.pdf': PDF('zh'),
      'P-dual.pdf': PDF('dual'),
      '.DS_Store': 'hidden',
      'notes.md': 'user notes',
    },
  })
  const hashes = Object.fromEntries(readdirSync(dir).map((n) => [n, sha256(join(dir, n))]))
  mkdirSync(join(data, 'S'), { recursive: true })
  const { tool } = makeTools(data, { approval: fakeApproval().service, scanner: async () => [] })
  const out = await tool.execute({ action: 'move_paper', topic: 'T', name: 'P', to_topic: 'S' }, execOf())
  assert.ok(!existsSync(dir), '源论文夹必须消失（整目录 rename）')
  const target = join(data, 'S', 'P')
  assert.ok(existsSync(target))
  assert.deepEqual(readdirSync(target).sort(), Object.keys(hashes).sort(), '全部条目（含隐藏/未知）随目录移动')
  for (const [n, h] of Object.entries(hashes)) assert.equal(sha256(join(target, n)), h, `${n} 内容不变`)
  assert.equal(out.topic, 'T')
  assert.equal(out.to_topic, 'S')
  assert.ok(out.files.includes('P.pdf') && out.files.includes('P.txt'))
  assert.match(out.summary, /个产物随论文文件夹整体移动/)
})

test('E6 move 失败零改动：注入 EBUSY → file-busy 409；EXDEV → move-partial 500；两种快照均不变', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  newPaper(data, 'T', 'Q')
  mkdirSync(join(data, 'S'), { recursive: true })
  const before = snap(data)
  const busy = catchErr(() => LM.movePaper(data, 'T', 'P', 'S', () => {
    throw Object.assign(new Error('EBUSY: injected'), { code: 'EBUSY' })
  }))
  const e1 = await busy
  assert.equal(e1.code, 'file-busy')
  assert.equal(e1.status, 409)
  assert.deepEqual(snap(data), before)
  const xdev = catchErr(() => LM.movePaper(data, 'T', 'Q', 'S', () => {
    throw Object.assign(new Error('EXDEV: injected'), { code: 'EXDEV' })
  }))
  const e2 = await xdev
  assert.equal(e2.code, 'move-partial')
  assert.equal(e2.status, 500)
  assert.equal(e2.extra.cause, 'EXDEV')
  assert.deepEqual(snap(data), before)
})

test('E7 move 后置校验：rename 后目标不是论文夹 → 回滚并报 rolledBack；回滚也失败 → rollbackFailed', async () => {
  // ① 回滚成功：注入实现「第一次假装成功（什么都不做）→ 目标不存在」，回滚自然不会成功 —— 先测 ②；
  //    ① 用「先真搬、再把 .pdf 从目标移走、回滚时放回」的实现，验证回滚后库快照回到原样。
  const { data } = mkLib()
  const dir = newPaper(data, 'T', 'P')
  mkdirSync(join(data, 'S'), { recursive: true })
  const before = snap(data)
  let calls = 0
  const sneaky = (from, to) => {
    calls++
    if (calls === 1) {
      renameSync(from, to)
      renameSync(join(to, 'P.pdf'), join(to, 'P.txt.bak'))   // 目标不再是论文夹
      return
    }
    renameSync(join(from, 'P.txt.bak'), join(from, 'P.pdf')) // 回滚时先放回
    renameSync(from, to)
  }
  const e1 = await catchErr(() => LM.movePaper(data, 'T', 'P', 'S', sneaky))
  assert.equal(e1.code, 'move-partial')
  assert.deepEqual(e1.extra.rolledBack, ['P'])
  assert.deepEqual(snap(data), before, '回滚成功 = 文献库未改变')
  assert.ok(existsSync(dir))

  // ② 回滚也失败：注入实现第一次什么都不做（源仍在、目标缺失）⇒ 后置校验失败；回滚 rename 抛 ENOENT
  let noopCalls = 0
  const e2 = await catchErr(() => LM.movePaper(data, 'T', 'P', 'S', () => {
    noopCalls += 1
    if (noopCalls === 1) return   // 假装成功（源仍在、目标缺失）
    throw Object.assign(new Error('ENOENT: injected on rollback'), { code: 'ENOENT' })
  }))
  assert.equal(e2.code, 'move-partial')
  assert.deepEqual(e2.extra.rollbackFailed, ['P'])
  assert.equal(e2.extra.trashRel, null)
  assert.match(e2.message, /请手动检查/)
  assert.deepEqual(snap(data), before, '实际上什么都没动 ⇒ 快照仍不变')
})

test('E8 move 旧布局拒绝（红线）：平铺文献 → legacy-layout 409、消息指向界面、不审批、快照不变', async () => {
  const { data } = mkLib()
  legacyPaper(data, 'T', 'P')
  mkdirSync(join(data, 'S'), { recursive: true })
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service })
  const before = snap(data)
  const err = await catchErr(() => tool.execute({ action: 'move_paper', topic: 'T', name: 'P', to_topic: 'S' }, execOf()))
  assert.ok(err)
  assert.equal(err.code, 'legacy-layout')
  assert.equal(err.status, 409)
  assert.match(err.message, /界面/)
  assert.equal(ap.requests.length, 0, '旧布局在审批前就被拒（对话侧绝不替用户做迁移）')
  assert.deepEqual(snap(data), before)
})

test('E9 move 自子树：目标专题在源论文夹内部 → bad-request 409，快照不变', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  mkdirSync(join(data, 'T', 'P', 'Sub'), { recursive: true })
  const { tool } = makeTools(data, { approval: fakeApproval().service })
  const before = snap(data)
  const err = await catchErr(() => tool.execute({ action: 'move_paper', topic: 'T', name: 'P', to_topic: 'T/P/Sub' }, execOf()))
  assert.ok(err)
  assert.equal(err.code, 'bad-request')
  assert.equal(err.status, 409, `自子树是 409（与 renameTopic 同口径）：${err.status}`)
  assert.deepEqual(snap(data), before)
})

test('E10 rename 的目标冲突/回滚映射：已存在同名 → target-exists（**审批前**）；注入 EBUSY → 409 且库不变', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  newPaper(data, 'T', 'Q')
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const before = snap(data)
  const err = await catchErr(() => tool.execute({ action: 'rename_paper', topic: 'T', name: 'P', new_name: 'Q' }, execOf()))
  assert.equal(err.code, 'target-exists')
  // t6 修复：三路目标冲突判定已提前到**审批之前**（不再让用户点完「允许」才发现没必要）
  assert.equal(ap.requests.length, 0, '目标冲突必须在审批前拒绝（t4-F1/④）')
  assert.deepEqual(snap(data), before)
  // 注入 EBUSY：库层既有语义（409 file-busy），工具只做码映射
  const e2 = await catchErr(() => LM.renamePaper(data, 'T', 'P', 'R', () => {
    throw Object.assign(new Error('EBUSY: injected'), { code: 'EBUSY' })
  }))
  assert.equal(e2.code, 'file-busy')
  assert.equal(e2.status, 409)
  assert.deepEqual(snap(data), before)
})

test('E11 delete 回收站可恢复：manifest 记 relativeDir/files，按相对路径移回后内容 sha256 一致', async () => {
  const { data } = mkLib()
  const dir = newPaper(data, 'T', 'P')
  const originals = Object.fromEntries(readdirSync(dir).map((n) => [n, sha256(join(dir, n))]))
  // 加一个隐藏条目：它不是产物，但也要可恢复
  writeFileSync(join(dir, '.DS_Store'), 'hidden')
  originals['.DS_Store'] = sha256(join(dir, '.DS_Store'))
  const { tool } = makeTools(data, { approval: fakeApproval().service, scanner: async () => [] })
  const out = await tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf())
  assert.ok(!existsSync(dir), '删除后论文夹消失')
  assert.ok(out.trashDir && existsSync(out.trashDir), '成功响应必须给回收站绝对路径（恢复线索）')
  assert.ok(String(out.trashRel).startsWith('.trash/'))
  assert.ok(!out.summary.includes(data), 'render/summary 只用相对路径，不暴露服务端绝对路径')
  const manifest = JSON.parse(readFileSync(join(out.trashDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.kind, 'paper')
  assert.equal(manifest.relativeDir, 'T/P')
  assert.ok(manifest.files.some((f) => f.name === 'P.pdf'))
  // 按 manifest 的相对路径手工移回 = 恢复
  const sub = join(out.trashDir, manifest.trashSubdir)
  for (const name of readdirSync(sub)) {
    if (name === 'manifest.json') continue
    mkdirSync(dir, { recursive: true })
    renameSync(join(sub, name), join(dir, name))
  }
  for (const [n, h] of Object.entries(originals)) assert.equal(sha256(join(dir, n)), h, `${n} 恢复后内容一致`)
})

test('E12 delete_topic 非空 → topic-not-empty 409（带 entries/papers），不审批、快照不变', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service })
  const before = snap(data)
  const err = await catchErr(() => tool.execute({ action: 'delete_topic', topic: 'T' }, execOf()))
  assert.equal(err.code, 'topic-not-empty')
  assert.equal(err.status, 409)
  assert.ok(Array.isArray(err.extra.entries) && err.extra.entries.length > 0)
  assert.deepEqual(err.extra.papers, ['P'])
  assert.match(err.message, /逐篇删除/)
  assert.equal(ap.requests.length, 0)
  assert.deepEqual(snap(data), before)
})

test('E13 delete_topic 空专题：有隐藏条目 → 移入回收站并给 trashRel；无隐藏 → trashDir:null', async () => {
  const { data } = mkLib()
  mkdirSync(join(data, 'H'), { recursive: true })
  writeFileSync(join(data, 'H', '.DS_Store'), 'junk')
  mkdirSync(join(data, 'E'), { recursive: true })
  const { tool } = makeTools(data, { approval: fakeApproval().service })
  const withHidden = await tool.execute({ action: 'delete_topic', topic: 'H' }, execOf())
  assert.ok(withHidden.trashRel)
  assert.ok(withHidden.trashDir && existsSync(join(withHidden.trashDir, '.DS_Store')), '隐藏条目可恢复')
  assert.deepEqual(withHidden.files, ['.DS_Store'])
  assert.match(withHidden.summary, /隐藏条目已移入/)
  const empty = await tool.execute({ action: 'delete_topic', topic: 'E' }, execOf())
  assert.equal(empty.trashDir, null)
  assert.equal(empty.trashRel, null)
  assert.deepEqual(empty.files, [])
  assert.match(empty.summary, /未创建回收站目录/)
})

test('E14 create_topic 幂等：首次 created:true；再次 created:false 且不改既有内容', async () => {
  const { data } = mkLib()
  const { tool } = makeTools(data, { approval: fakeApproval().service })
  const first = await tool.execute({ action: 'create_topic', topic: 'A/B' }, execOf())
  assert.equal(first.created, true)
  writeFileSync(join(data, 'A', 'B', 'keep.txt'), 'keep')
  const before = snap(data)
  const again = await tool.execute({ action: 'create_topic', topic: 'A/B' }, execOf())
  assert.equal(again.created, false)
  assert.match(again.summary, /已存在/)
  assert.deepEqual(snap(data), before, '幂等 = 不覆盖既有目录内容')
})

test('E15 失败不残留空回收站目录：审批拒绝/目标冲突/非空专题后 .trash 不新增', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  newPaper(data, 'S', 'P')
  const ap = fakeApproval('rejected')
  const { tool } = makeTools(data, { approval: ap.service })
  await catchErr(() => tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf()))
  await catchErr(() => tool.execute({ action: 'move_paper', topic: 'T', name: 'P', to_topic: 'S' }, execOf()))
  await catchErr(() => tool.execute({ action: 'delete_topic', topic: 'T' }, execOf()))
  assert.ok(!existsSync(join(data, '.trash')), '没有任何一次失败可以留下空的回收站目录')
})

/* ═══════════════════════════════════════════════════════════════════════════
   F. 红线 / 回归
   ═══════════════════════════════════════════════════════════════════════════ */

test('F1 无迁移执行路径：action 枚举无 migrate*；tools.ts 不 import 迁移执行；调用后无 migration-logs', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  const { tool } = makeTools(data, { approval: fakeApproval().service, scanner: async () => [] })
  const actions = tool.parameters.properties.action.enum
  for (const banned of ['migrate', 'migrate_rollback', 'migrate-library', 'clear_topic', 'restore']) {
    assert.ok(!actions.includes(banned), `action 枚举绝不能含 ${banned}`)
  }
  const src = readFileSync(join(REPO, 'src', 'tools.ts'), 'utf8')
  // 判据是**真的 import 了什么**（注释里提到 runMigration 不算执行路径；基线注释本来就有这句）。
  const importLine = src.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/migrate\.ts'/)
  assert.ok(importLine, 'tools.ts 必须只从 migrate.ts 取只读能力')
  const imported = importLine[1].split(',').map((x) => x.trim()).filter(Boolean).sort()
  assert.deepEqual(imported, ['formatMigrationReport', 'planMigration'], `工具层只允许只读迁移能力：${imported}`)
  const distSrc = readFileSync(join(dist('tools.js')), 'utf8')
  assert.ok(!/\brunMigration\s*\(|\brollbackMigration\s*\(/.test(distSrc), '编译产物同样不得调用迁移执行函数')
  await tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf())
  assert.ok(!existsSync(join(data, 'migration-logs')), '工具调用绝不写迁移日志')
})

test('F2 migration_report 契约未变：调用前后快照不变、尾句仍是「我不会自动执行」', async () => {
  const { data } = mkLib()
  legacyPaper(data, 'T', 'P')
  const { tools } = makeTools(data, { approval: fakeApproval().service })
  const before = snap(data)
  const out = await tools.migration_report.execute({}, execOf())
  assert.equal(out.ok, true)
  assert.match(out.report, /干跑|迁移/)
  const text = tools.migration_report.output.render({}, out).map((b) => b.text).join('')
  assert.match(text, /我不会自动执行/, '只读工具的尾句是冻结文案')
  assert.match(text, /未改动任何文件/)
  assert.deepEqual(snap(data), before)
  // migration_prompt_choice 仍只有三个枚举值（不因新工具而扩大）
  assert.deepEqual(tools.migration_prompt_choice.parameters.properties.choice.enum, ['later', 'declined', 'recheck'])
})

test('F4 工具不写 sidecar：add_paper 后目录里只有 PDF（转录/学习档案按需生成）', async () => {
  const { data, root } = mkLib()
  mkdirSync(join(data, 'T'), { recursive: true })
  const src = srcPdf(root, 'only.pdf', PDF('only'))
  const { tool } = makeTools(data, { approval: fakeApproval().service })
  await tool.execute({ action: 'add_paper', topic: 'T', source_path: src }, execOf())
  assert.deepEqual(readdirSync(join(data, 'T', 'only')), ['only.pdf'])
})

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test('F5 错误响应无绝对路径：所有拒绝分支的 message/extra 不含 dataDir（只允许 trashRel）', async () => {
  const { data, root } = mkLib()
  newPaper(data, 'T', 'P')
  mkdirSync(join(data, 'S'), { recursive: true })
  newPaper(data, 'T', 'Q')
  const ap = fakeApproval('rejected')
  const { tool } = makeTools(data, { approval: ap.service })
  const calls = [
    { action: 'delete_paper', topic: 'T', name: 'ghost' },
    { action: 'delete_paper', topic: 'T', name: 'P' },                              // 审批拒绝
    { action: 'delete_topic', topic: 'T' },                                          // 非空
    { action: 'add_paper', topic: 'T', source_path: join(root, 'missing.pdf') },      // 源不存在
    { action: 'move_paper', topic: 'T', name: 'Q', to_topic: 'T' },                   // 目标冲突（平铺/同名）
    { action: 'rename_paper', topic: 'T', name: 'Q', new_name: 'X.pdf' },             // 词法
  ]
  for (const args of calls) {
    const err = await catchErr(() => tool.execute(args, execOf()))
    assert.ok(err, `${args.action} 必须失败`)
    const blob = `${err.message} ${JSON.stringify(err.extra ?? {})}`
    assert.ok(!blob.includes(data), `${args.action} 的错误泄露了 dataDir 绝对路径：${blob}`)
    assert.ok(!new RegExp(escapeRe(root)).test(blob), `${args.action} 的错误泄露了临时根路径：${blob}`)
  }
})

test('F6 全局不变量：registerTools 不因缺 get/each2 而崩（R9）；既有工具全部仍注册', () => {
  const { data } = mkLib()
  const tools = {}
  registerTools({ tools: { register: (x) => { tools[x.name] = x } } }, { dataDir: data })
  assert.deepEqual(Object.keys(tools).sort(), [
    'library_manage', 'list_papers', 'migration_prompt_choice', 'migration_report',
    'search_paper', 'study_progress', 'study_update', 'transcribe_pdf',
  ])
})

/* ═══════════════════════════════════════════════════════════════════════════
   G. t4 对抗评审 findings 的修复用例（t6 repair-round-2）
   F1 改名目标三路冲突（含旧布局/孤儿产物）· F2 混合布局 layout-conflict ·
   F3 otherEntries/dirRemoved 如实呈现 · F4 ctx.get 抛错 → approval-unavailable
   ═══════════════════════════════════════════════════════════════════════════ */

const papersOf = async (tools, topic) => (await tools.list_papers.execute({ topic }, execOf())).papers.map((p) => p).sort()

test('G1a[F1] rename 目标被**旧布局**同名文献占用：target-exists、审批前拒绝、listPapers 不被遮蔽（含正向控制）', async () => {
  // 夹具：T/P/（新布局）+ T/Q.pdf（旧布局）⇒ listPapers = [T/P, T/Q]
  // 旧实现只查论文夹目录 ⇒ 放行 P→Q；Q 的平铺文件仍在盘上却被「论文夹优先」遮蔽 ⇒ listPapers 只剩 [T/Q]。
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  legacyPaper(data, 'T', 'Q')
  const ap = fakeApproval()
  const { tool, tools } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const before = snap(data)
  assert.deepEqual(await papersOf(tools, 'T'), ['T/P', 'T/Q'], '夹具：文件夹 P + 旧布局 Q 各一篇')
  const err = await catchErr(() => tool.execute({ action: 'rename_paper', topic: 'T', name: 'P', new_name: 'Q' }, execOf()))
  assert.ok(err, '改成一个已被旧布局文献占用的名字必须被拒')
  assert.equal(err.code, 'target-exists')
  assert.equal(err.status, 409)
  assert.equal(ap.requests.length, 0, '目标冲突在审批前判定（t4-F1：不再让用户点完才发现）')
  assert.deepEqual(snap(data), before, '零副作用')
  assert.deepEqual(await papersOf(tools, 'T'), ['T/P', 'T/Q'], '既有 legacy Q 不得被遮蔽（旧实现这里会变成 [T/Q]）')
  // 正向控制：清掉平铺残留（等价于用户完成迁移）后，同一个改名必须成功 —— 证明不是「永远拒绝」
  rmSync(join(data, 'T', 'Q.pdf'))
  rmSync(join(data, 'T', 'Q.txt'))
  const ok = await tool.execute({ action: 'rename_paper', topic: 'T', name: 'P', new_name: 'Q' }, execOf())
  assert.equal(ok.new_name, 'Q')
  assert.deepEqual(await papersOf(tools, 'T'), ['T/Q'])
})

test('G1b[F1] rename 目标是一个**已存在的论文夹**：target-exists、审批前拒绝、listPapers 不变', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  newPaper(data, 'T', 'Q')
  const ap = fakeApproval()
  const { tool, tools } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const before = snap(data)
  const err = await catchErr(() => tool.execute({ action: 'rename_paper', topic: 'T', name: 'P', new_name: 'Q' }, execOf()))
  assert.equal(err.code, 'target-exists')
  assert.equal(ap.requests.length, 0)
  assert.deepEqual(snap(data), before)
  assert.deepEqual(await papersOf(tools, 'T'), ['T/P', 'T/Q'])
})

test('G1c[F1] rename 目标只剩**孤儿 sidecar**（无目录、无 pdf）：target-exists、审批前拒绝、孤儿原样保留', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  writeFileSync(join(data, 'T', 'Q.txt'), 'orphan sidecar')
  const ap = fakeApproval()
  const { tool, tools } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const before = snap(data)
  const err = await catchErr(() => tool.execute({ action: 'rename_paper', topic: 'T', name: 'P', new_name: 'Q' }, execOf()))
  assert.equal(err.code, 'target-exists', '孤儿产物会让「新 PDF + 别人的旧缓存」混合，必须拒')
  assert.equal(ap.requests.length, 0)
  assert.deepEqual(snap(data), before)
  assert.deepEqual(await papersOf(tools, 'T'), ['T/P'])
  assert.ok(existsSync(join(data, 'T', 'Q.txt')), '孤儿 sidecar 原样保留')
})

/** 「论文夹 + 同 stem 平铺残留」混合态（迁移冲突之后的真实形态）。 */
function mixedPaper(data, topic = 'T', name = 'P') {
  const dir = newPaper(data, topic, name)                       // <T>/<P>/<P>.pdf + <P>.txt
  writeFileSync(join(data, topic, name + '.pdf'), PDF('flat-' + name))
  writeFileSync(join(data, topic, name + '.txt'), 'flat-cache')
  return dir
}

test('G2a[F2] 混合布局 delete_paper：layout-conflict 409、零副作用、不弹审批；不留 legacy 幽灵；迁移完成后可正常删除', async () => {
  const { data } = mkLib()
  const dir = mixedPaper(data)
  const ap = fakeApproval()
  const { tool, tools } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const before = snap(data)
  assert.deepEqual(await papersOf(tools, 'T'), ['T/P'], '夹具：listPapers 只显示论文夹那一半（平铺被遮蔽）')
  const err = await catchErr(() => tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf()))
  assert.ok(err)
  assert.equal(err.code, 'layout-conflict')
  assert.equal(err.status, 409)
  assert.match(err.message, /界面完成迁移/)
  assert.ok(Array.isArray(err.extra.files) && err.extra.files.includes('P.pdf'), `必须点名残留文件：${JSON.stringify(err.extra)}`)
  assert.equal(ap.requests.length, 0, '混合态在审批前就被拒（用户不必为一个不可执行的操作点允许）')
  assert.deepEqual(snap(data), before, '零副作用')
  assert.deepEqual(await papersOf(tools, 'T'), ['T/P'], '不出现 legacy 幽灵身份（旧实现删完会变成 [T/P(legacy)]）')
  // 正向控制：清掉平铺残留（= 用户完成迁移）后，删除成功且旧身份彻底消失
  rmSync(join(data, 'T', 'P.pdf'))
  rmSync(join(data, 'T', 'P.txt'))
  const out = await tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf())
  assert.equal(out.ok, true)
  assert.ok(!existsSync(dir))
  assert.deepEqual(await papersOf(tools, 'T'), [], '删除后 listPapers 不含该篇旧身份')
})

test('G2b[F2] 混合布局 rename_paper：layout-conflict 409；迁移完成后改名成功且旧名不再出现', async () => {
  const { data } = mkLib()
  mixedPaper(data)
  const ap = fakeApproval()
  const { tool, tools } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const before = snap(data)
  const err = await catchErr(() => tool.execute({ action: 'rename_paper', topic: 'T', name: 'P', new_name: 'R' }, execOf()))
  assert.equal(err.code, 'layout-conflict')
  assert.equal(err.status, 409)
  assert.equal(ap.requests.length, 0)
  assert.deepEqual(snap(data), before)
  assert.deepEqual(await papersOf(tools, 'T'), ['T/P'], '不出现「旧名 legacy + 新名」两个身份')
  rmSync(join(data, 'T', 'P.pdf'))
  rmSync(join(data, 'T', 'P.txt'))
  const out = await tool.execute({ action: 'rename_paper', topic: 'T', name: 'P', new_name: 'R' }, execOf())
  assert.equal(out.new_name, 'R')
  assert.deepEqual(await papersOf(tools, 'T'), ['T/R'], 'listPapers 不含旧身份 P')
})

test('G2c[F2] 混合布局 move_paper：layout-conflict 409；迁移完成后移动成功且不在两个专题重复出现', async () => {
  const { data } = mkLib()
  mixedPaper(data)
  mkdirSync(join(data, 'S'), { recursive: true })
  const ap = fakeApproval()
  const { tool, tools } = makeTools(data, { approval: ap.service, scanner: async () => [] })
  const before = snap(data)
  const err = await catchErr(() => tool.execute({ action: 'move_paper', topic: 'T', name: 'P', to_topic: 'S' }, execOf()))
  assert.equal(err.code, 'layout-conflict')
  assert.equal(err.status, 409)
  assert.equal(ap.requests.length, 0)
  assert.deepEqual(snap(data), before)
  assert.deepEqual(await papersOf(tools, 'T'), ['T/P'], '同一篇不得同时出现在源/目标（旧实现会 [S/P, T/P(legacy)]）')
  rmSync(join(data, 'T', 'P.pdf'))
  rmSync(join(data, 'T', 'P.txt'))
  const out = await tool.execute({ action: 'move_paper', topic: 'T', name: 'P', to_topic: 'S' }, execOf())
  assert.equal(out.to_topic, 'S')
  assert.deepEqual(await papersOf(tools, 'T'), [], '源专题不含旧身份')
  assert.deepEqual(await papersOf(tools, 'S'), ['S/P'])
})

test('G3[F3] move_paper 遇未知条目（自放文件/子目录）：otherEntries 字段与摘要都如实点名', async () => {
  const { data } = mkLib()
  const dir = newPaper(data, 'T', 'P')
  writeFileSync(join(dir, 'notes.md'), 'user notes')
  mkdirSync(join(dir, 'fig'), { recursive: true })
  writeFileSync(join(dir, 'fig', 'a.png'), 'png')
  mkdirSync(join(data, 'S'), { recursive: true })
  const { tool } = makeTools(data, { approval: fakeApproval().service, scanner: async () => [] })
  const out = await tool.execute({ action: 'move_paper', topic: 'T', name: 'P', to_topic: 'S' }, execOf())
  assert.deepEqual([...out.otherEntries].sort(), ['fig', 'notes.md'], '非产物条目必须逐个列出（旧实现直接丢弃）')
  assert.match(out.summary, /notes\.md/)
  assert.match(out.summary, /fig/)
  assert.match(out.summary, /另有 2 个非产物条目随目录一起搬走/)
  assert.ok(existsSync(join(data, 'S', 'P', 'notes.md')), '它们确实随目录搬走了')
})

test('G4[F3] delete_paper 的论文夹未删净：dirRemoved=false 且摘要如实提示（不递归删）', async () => {
  const { data } = mkLib()
  const dir = newPaper(data, 'T', 'P')
  writeFileSync(join(dir, 'notes.md'), 'user notes')
  const { tool } = makeTools(data, { approval: fakeApproval().service, scanner: async () => [] })
  const out = await tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf())
  assert.equal(out.dirRemoved, false, '目录里有非产物条目 ⇒ 非递归 rmdir 失败，必须如实回报')
  assert.match(out.summary, /未删净/)
  assert.match(out.summary, /同名子专题/)
  assert.ok(existsSync(join(dir, 'notes.md')), '非产物条目原样保留（工具不递归删除用户文件）')
  // 对照：没有未知条目时 dirRemoved=true
  const { data: d2 } = mkLib()
  newPaper(d2, 'T', 'P')
  const t2 = makeTools(d2, { approval: fakeApproval().service, scanner: async () => [] }).tool
  const out2 = await t2.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf())
  assert.equal(out2.dirRemoved, true)
  assert.ok(!/未删净/.test(out2.summary))
})

test('G6[t3-low] create_topic 目标为同名**普通文件** → 409 target-exists（与 add/move 冲突语义一致），仍在审批外、零副作用', async () => {
  const { data } = mkLib()
  writeFileSync(join(data, 'T'), 'i am a file, not a topic dir')
  const { tool } = makeTools(data, { approval: fakeApproval().service })
  const before = snap(data)
  const err = await catchErr(() => tool.execute({ action: 'create_topic', topic: 'T' }, execOf()))
  assert.ok(err)
  assert.equal(err.code, 'target-exists', `旧实现返回 404 not-found（t3 低危）：${err && err.code}`)
  assert.equal(err.status, 409)
  assert.deepEqual(snap(data), before, '零副作用')
  assert.equal(statSync(join(data, 'T')).isFile(), true, '普通文件绝不被覆盖/删除')
  // 已存在**目录**仍是幂等 created:false（E14 的对照，防止把「已存在的专题」误判成冲突）
  mkdirSync(join(data, 'D'), { recursive: true })
  const ok = await tool.execute({ action: 'create_topic', topic: 'D' }, execOf())
  assert.equal(ok.created, false)
})

test('G5[F4] ctx.get("approval") 抛错 → approval-unavailable（有机器码/前缀），零副作用', async () => {
  const { data } = mkLib()
  newPaper(data, 'T', 'P')
  // scanner 正常，确保走到审批门（否则会先因 session-unknown 拒绝）
  const { tool } = makeTools(data, { approval: undefined, getThrows: true, scanner: async () => [] })
  const before = snap(data)
  const err = await catchErr(() => tool.execute({ action: 'delete_paper', topic: 'T', name: 'P' }, execOf()))
  assert.ok(err, '必须失败')
  assert.ok(err instanceof ManageError, `必须是带机器码的 ManageError（旧实现会冒泡裸 Error）：${err && err.stack}`)
  assert.equal(err.code, 'approval-unavailable')
  assert.equal(err.status, 503)
  assert.match(err.message, /^\[library_manage:approval-unavailable\]/)
  assert.match(err.message, /未做任何改动|nothing changed/)
  assert.deepEqual(snap(data), before)
  assert.ok(!existsSync(join(data, '.trash')))
})

test('G7[R-F3] create_topic 的祖先段是普通文件 → 409 target-exists、零副作用（与目标自身同名文件同语义）', async () => {
  // 线上复现形态：`<库根>/某个 .md` 是普通文件，agent 把它当专题再往下建子专题。
  // 旧实现：祖先循环里 resolveTopicDir 抛 404 `not-found`（「专题不存在」）；修后与「目标自身同名文件」统一 409。
  const { data } = mkLib()
  writeFileSync(join(data, 'ParentFile'), 'i am a file, not a topic dir')
  const ap = fakeApproval()
  const { tool } = makeTools(data, { approval: ap.service })
  const before = snap(data)
  for (const topic of ['ParentFile/Sub', 'ParentFile/a/b']) {
    const err = await catchErr(() => tool.execute({ action: 'create_topic', topic }, execOf()))
    assert.ok(err, `${topic} 必须被拒`)
    assert.equal(err.code, 'target-exists', `${topic}: ${err.code} ${err.message}`)
    assert.equal(err.status, 409)
    assert.match(err.message, /^\[library_manage:target-exists\] /)
    assert.match(err.message, /ParentFile/, '错误文案要点名被占用的路径段，便于用户定位')
    assert.deepEqual(snap(data), before, '零副作用：失败不创建任何目录/文件')
  }
  assert.equal(statSync(join(data, 'ParentFile')).isFile(), true, '普通文件原样保留（不覆盖/不删除）')
  // 对照：真目录祖先仍可一次建多级子专题（既有能力不受影响）
  mkdirSync(join(data, 'RealParent'), { recursive: true })
  const ok = await tool.execute({ action: 'create_topic', topic: 'RealParent/Child' }, execOf())
  assert.equal(ok.created, true)
  assert.ok(existsSync(join(data, 'RealParent', 'Child')))
})
