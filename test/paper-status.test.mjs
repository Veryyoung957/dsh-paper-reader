import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readPaperStatuses, classifyMineruStatus, classifyTranslationStatus, classifyMigrationStatus } from '../dist/library-status.js'
import { detectMigrationNeed, invalidateMigrationPromptCache, migrationScanStats } from '../dist/migrate-prompt.js'
function fixture(fn) {
  const root = fs.mkdtempSync(join(tmpdir(), 'dpr-status-'))
  const put = (name, content = 'pdf') => { const path = join(root, name); fs.mkdirSync(join(path, '..'), { recursive: true }); fs.writeFileSync(path, content) }
  try { fn(root, put) } finally { fs.rmSync(root, { recursive: true, force: true }) }
}
function mineru(put, base, producer = 'mineru-local') {
  put(base + '.txt', 'x'.repeat(1200))
  put(base + '.transcript.json', JSON.stringify({ producer, text: { bytes: 1200, chars: 1200 } }))
  put(base + '.pages.json', JSON.stringify({ pageCount: 1, pages: [{ page: 1, start: 0, end: 1200 }] }))
  put(base + '.mineru.md', 'markdown'); put(base + '.mineru.json', '{}')
}
test('status axes: both translations; committed local/cloud MinerU; pdfjs/cache are not completion', () => fixture((root, put) => {
  put('A/P/P.pdf'); put('A/P/P-zh.pdf'); mineru(put, 'A/P/P')
  let row = readPaperStatuses(root, { force: true }).papers[0]
  assert.deepEqual(row, { topic: 'A', name: 'P', translation: 'incomplete', mineru: 'complete', migration: 'complete' })
  put('A/P/P-dual.pdf'); row = readPaperStatuses(root).papers[0]; assert.equal(row.translation, 'complete')
  mineru(put, 'A/P/P', 'mineru-cloud'); assert.equal(readPaperStatuses(root).papers[0].mineru, 'complete')
  mineru(put, 'A/P/P', 'pdfjs'); assert.equal(readPaperStatuses(root).papers[0].mineru, 'incomplete')
  mineru(put, 'A/P/P', 'cache'); assert.equal(readPaperStatuses(root).papers[0].mineru, 'unknown')
  fs.unlinkSync(join(root, 'A/P/P.transcript.json')); assert.equal(readPaperStatuses(root).papers[0].mineru, 'incomplete')
}))
test('status unknown never becomes complete: corrupted/oversize JSON, byte mismatch, links, inaccessible artifacts', () => fixture((root, put) => {
  put('A/P/P.pdf'); mineru(put, 'A/P/P')
  for (const value of ['{', JSON.stringify({ producer: 'mineru-cloud', text: { bytes: 99, chars: 1200 } }), ' '.repeat(1024 * 1024 + 1)]) {
    put('A/P/P.transcript.json', value); assert.equal(readPaperStatuses(root, { force: true }).papers[0].mineru, 'unknown')
  }
  mineru(put, 'A/P/P'); fs.unlinkSync(join(root, 'A/P/P.mineru.md')); assert.equal(readPaperStatuses(root).papers[0].mineru, 'incomplete')
  mineru(put, 'A/P/P'); put('A/P/P-zh.pdf'); fs.symlinkSync(join(root, 'A/P/P.pdf'), join(root, 'A/P/P-dual.pdf'), 'file')
  assert.equal(readPaperStatuses(root).papers[0].translation, 'unknown')
  const original = fs.accessSync
  try {
    fs.accessSync = (path, ...args) => { if (String(path).endsWith('.txt')) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return original(path, ...args) }
    syncBuiltinESMExports(); assert.equal(readPaperStatuses(root).papers[0].mineru, 'unknown')
  } finally { fs.accessSync = original; syncBuiltinESMExports() }
}))
test('same scan need/hits includes residue/conflict/quarantine, hidden, root flat and folder authority', () => fixture((root, put) => {
  put('Root.pdf'); put('A/.Hidden.pdf'); put('A/P/P.pdf', 'new'); put('A/P.pdf', 'old'); put('A/P-zh.pdf'); put('A/P-dual.pdf')
  put('A/' + 'x'.repeat(101) + '.pdf'); put('B/P/P.pdf')
  const s = readPaperStatuses(root, { force: true })
  assert.equal(s.need.papers, 4); assert.equal(s.need.byClass.conflict, 1); assert.equal(s.need.byClass.quarantine, 1)
  assert.equal(s.total, 5); assert.ok(s.papers.some(p => p.topic === '' && p.name === 'Root'))
  assert.equal(s.papers.find(p => p.topic === 'A' && p.name === 'P').translation, 'incomplete', 'never mix old flat artifacts with folder PDF')
  assert.equal(s.papers.find(p => p.topic === 'A' && p.name === 'P').migration, 'incomplete')
  assert.equal(s.papers.find(p => p.topic === 'B').migration, 'complete')
  assert.equal(detectMigrationNeed(root), s.need, 'banner and panel share exact need instance')
}))
test('read-only pagination, TTL, invalidation and missing root do not mkdir or mutate files', () => fixture((root, put) => {
  for (let i = 0; i < 105; i++) put('A/P' + String(i).padStart(3, '0') + '.pdf')
  const before = fs.readdirSync(join(root, 'A'))
  const n = migrationScanStats.scans
  const first = readPaperStatuses(root, { force: true }); const second = readPaperStatuses(root, { offset: 100 })
  assert.equal(first.papers.length, 100); assert.equal(first.nextOffset, 100); assert.equal(second.papers.length, 5)
  assert.equal(first.snapshotId, second.snapshotId); assert.equal(migrationScanStats.scans, n + 1)
  assert.deepEqual(fs.readdirSync(join(root, 'A')), before)
  invalidateMigrationPromptCache(root); readPaperStatuses(root); assert.equal(migrationScanStats.scans, n + 2)
  for (const opts of [{ offset: -1 }, { limit: 101 }, { limit: 0 }, { offset: .5 }]) assert.throws(() => readPaperStatuses(root, opts), RangeError)
  const missing = join(root, 'missing'); assert.equal(readPaperStatuses(missing).total, 0); assert.equal(fs.existsSync(missing), false)
}))
test('root/subtree permission faults and budget report incomplete enumeration, never empty-success', () => fixture((root, put) => {
  put('A/P/P.pdf'); put('B/Q/Q.pdf')
  const original = fs.readdirSync
  try {
    fs.readdirSync = (path, ...args) => { if (String(path) === join(root, 'B')) throw Object.assign(new Error('denied'), { code: 'EPERM' }); return original(path, ...args) }
    syncBuiltinESMExports()
    const result = readPaperStatuses(root, { force: true }); assert.equal(result.complete, false); assert.equal(result.need.certain, false)
    assert.ok(result.unreadable.some(u => u.topic === 'B')); assert.equal(result.papers[0].migration, 'unknown')
    fs.readdirSync = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }; syncBuiltinESMExports()
    const bad = readPaperStatuses(root, { force: true }); assert.equal(bad.complete, false); assert.equal(bad.need.state, 'unknown')
  } finally { fs.readdirSync = original; syncBuiltinESMExports() }
  const originalAgain = fs.readdirSync
  try {
    fs.readdirSync = (path, ...args) => String(path) === root ? Array.from({ length: 20001 }, (_, i) => ({ name: String(i), isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false })) : originalAgain(path, ...args)
    syncBuiltinESMExports(); assert.equal(readPaperStatuses(root, { force: true }).complete, false)
  } finally { fs.readdirSync = originalAgain; syncBuiltinESMExports() }
}))
test('pure classifiers keep unknown distinct and validate page offsets', () => {
  assert.equal(classifyTranslationStatus(['complete', 'unknown']), 'unknown')
  assert.equal(classifyMigrationStatus(false, true, false), 'unknown')
  assert.equal(classifyMineruStatus({ producer: 'mineru-local', text: { chars: 1200, bytes: 1200 } }, { pageCount: 1, pages: [{ page: 1, start: 1, end: 2000 }] }, { state: 'complete', size: 1200 }, ['complete']), 'unknown')
})
