// .probe/t4/mutations.mjs —— t4 评审**自造**变异测试：注入必红、还原必绿、diff clean（逐条机器可复核）。
//
// 与实现方的 test/mutation-probe.mjs 独立：这里的每条变异都有**我自己**的判定器（既有契约用例 or
// 我自己写的 .probe/t4/probes.mjs 探针），并在**沙箱副本**里执行 —— 绝不改动被评审的检出。
//
// 用法规约：
//   · 沙箱 = .probe/t4/sandbox（从检出复制，排除 node_modules/dist/.git/.probe；node_modules 用软链）
//   · 每次注入 → tsc 重建沙箱 dist → 跑判定器 → 期望非 0（红）
//   · 还原 → tsc → 再跑 → 期望 0（绿）
//   · diff clean = 还原后的文件 `git hash-object` 与检出 HEAD 的 blob 完全一致
//
// 用法：node .probe/t4/mutations.mjs [--only M1]

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKTREE = join(HERE, '..', '..')
const SB = join(WORKTREE, ".probe", "t4", "sandbox")
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? process.argv[i + 1] : null })()

const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, DSH_HOME: join(HERE, 'home') } })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}
const lastLines = (s, n = 6) => s.trim().split('\n').slice(-n).join(' | ')

function syncSandbox() {
  rmSync(SB, { recursive: true, force: true })
  mkdirSync(SB, { recursive: true })
  const skip = new Set(['node_modules', 'dist', '.git', '.probe'])
  for (const e of readdirSync(WORKTREE)) {
    if (skip.has(e)) continue
    cpSync(join(WORKTREE, e), join(SB, e), { recursive: true })
  }
  symlinkSync(join(WORKTREE, 'node_modules'), join(SB, 'node_modules'), 'dir')
  mkdirSync(join(SB, '.probe', 't4'), { recursive: true })
  cpSync(join(HERE, 'probes.mjs'), join(SB, '.probe', 't4', 'probes.mjs'))
  const b = run(join(SB, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], SB)
  if (b.status !== 0) { console.error('沙箱构建失败：\n' + b.out); process.exit(2) }
  const p = run(process.execPath, ['.probe/t4/probes.mjs'], SB)
  if (p.status !== 0) { console.error('沙箱里的探针基线不是全绿，拒绝继续：\n' + lastLines(p.out, 30)); process.exit(2) }
}

/** 判定器：'test' = 既有契约用例；'probe' = 我自己的探针。返回 {status, out}。 */
function detect(spec) {
  if (spec.kind === 'test') {
    return run(process.execPath, ['--test', '--test-timeout=60000', `--test-name-pattern=${spec.pattern}`, 'test/library-manage-tools.test.mjs'], SB)
  }
  return run(process.execPath, ['.probe/t4/probes.mjs', '--only', spec.probe], SB)
}

const MUTATIONS = [
  {
    id: 'M1', why: '审批门 fail-open：把「只认 allowed-once」的判定短路（rejected/cancelled 也会执行）',
    file: 'src/tools.ts',
    from: "  if (outcome !== 'allowed-once') {",
    to: '  if (false) {',
    detect: { kind: 'test', pattern: 'B1' },
  },
  {
    id: 'M2', why: '批准后、写盘前不再复查取消（挂起期间被 abort 仍会执行）',
    file: 'src/tools.ts',
    from: "  // 批准之后、第一次写盘之前再查一次取消（取消 = 零副作用）\n  if (signalAborted(exec)) throw approvalError(lang, 'cancelled', action)",
    to: "  // 批准之后、第一次写盘之前再查一次取消（取消 = 零副作用）\n  if (false) throw approvalError(lang, 'cancelled', action)",
    detect: { kind: 'probe', probe: 'A5' },
  },
  {
    id: 'M3', why: '收录落盘不再「不覆盖」：硬链接换成同目录 rename（竞态窗口会覆盖别人刚写的同名文件）',
    file: 'src/library-manage.ts',
    from: '      linkImpl(tmpPath, finalPath)',
    to: '      renameImpl(tmpPath, finalPath)',
    detect: { kind: 'probe', probe: 'C6' },
  },
  {
    id: 'M4', why: '移动不再拒绝旧布局（等于让工具偷偷执行那篇的迁移；严重时会把整个专题目录改名进论文夹）',
    file: 'src/library-manage.ts',
    from: "  if (plan.layout === 'legacy') {",
    to: '  if (false) {',
    detect: { kind: 'probe', probe: 'B5' },
  },
  {
    id: 'M5', why: '会话状态不可知时 fail-open（scanner 未注入/抛错被当成「0 个运行中会话」）',
    file: 'src/library-guards.ts',
    from: "    if (!scanner) return { total: 0, running: 0, unknown: true }",
    to: '    if (!scanner) return { total: 0, running: 0, unknown: false }',
    detect: { kind: 'test', pattern: 'D5' },
  },
]

console.log('[sandbox] 同步副本 + 基线构建 + 探针全绿检查 …')
syncSandbox()
console.log('[sandbox] 就绪')

const rows = []
for (const m of MUTATIONS) {
  if (ONLY && m.id !== ONLY) continue
  const abs = join(SB, m.file)
  const pristine = readFileSync(abs, 'utf8')
  const hits = pristine.split(m.from).length - 1
  if (hits !== 1) {
    rows.push({ id: m.id, ok: false, note: `锚点命中 ${hits} 次（期望 1）——变异未注入，判定无效` })
    continue
  }
  // ① 注入
  writeFileSync(abs, pristine.replace(m.from, m.to))
  let build = run(join(SB, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], SB)
  if (build.status !== 0) { rows.push({ id: m.id, ok: false, note: '注入后构建失败：' + lastLines(build.out) }); writeFileSync(abs, pristine); continue }
  const red = detect(m.detect)
  // ② 还原
  writeFileSync(abs, pristine)
  build = run(join(SB, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], SB)
  if (build.status !== 0) { rows.push({ id: m.id, ok: false, note: '还原后构建失败：' + lastLines(build.out) }); continue }
  const green = detect(m.detect)
  // ③ diff clean：还原后的文件内容必须与检出 HEAD 的 blob 逐字节一致
  const headHash = spawnSync('git', ['-C', WORKTREE, 'rev-parse', `HEAD:${m.file}`], { encoding: 'utf8' }).stdout.trim()
  const fileHash = spawnSync('git', ['-C', WORKTREE, 'hash-object', '--', abs], { encoding: 'utf8' }).stdout.trim()
  rows.push({
    id: m.id,
    ok: red.status !== 0 && green.status === 0 && headHash === fileHash,
    redExit: red.status, greenExit: green.status, hashMatch: headHash === fileHash,
    note: `${m.why}\n     注入: exit=${red.status} ${red.status === 0 ? '!! 没变红（判定器空转）' : 'RED ✓'} · 还原: exit=${green.status} ${green.status === 0 ? 'GREEN ✓' : '!! 还原后仍红'} · blob ${fileHash.slice(0, 12)}/${headHash.slice(0, 12)}`,
    redTail: red.status === 0 ? '' : lastLines(red.out, 3),
    greenTail: green.status !== 0 ? lastLines(green.out, 3) : '',
    detector: m.detect.kind === 'test' ? `test pattern=${m.detect.pattern}` : `probe ${m.detect.probe}`,
  })
}

for (const r of rows) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.id} [${r.detector ?? '?'}] ${r.note}${r.redTail ? '\n       红: ' + r.redTail : ''}${r.greenTail ? '\n       绿: ' + r.greenTail : ''}`)
const bad = rows.filter((r) => !r.ok)
console.log(`\n== ${rows.length - bad.length}/${rows.length} 变异符合「注入必红 / 还原必绿 / diff clean」 ==`)
process.exit(bad.length === 0 ? 0 : 1)
