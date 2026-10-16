// Read-only, lazy paper status probes. Never resolveDataDir or execute workflows.
import { lstatSync, readFileSync, accessSync, constants, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { detectMigrationNeed, migrationScanDetails, type MigrationNeed } from './migrate-prompt.ts'

export type Completion = 'complete' | 'incomplete' | 'unknown'
export interface PaperStatus { topic: string; name: string; translation: Completion; mineru: Completion; migration: Completion }
type Probe = { state: Completion; size: number }
// lstat every path component: no linked directory or file may supply completion evidence.
function probe(root: string, path: string): Probe {
  try {
    let current = root
    const rootStat = lstatSync(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { state: 'unknown', size: 0 }
    const parts = path.slice(root.length + 1).split(/[\\/]/)
    for (const [i, part] of parts.entries()) {
      if (!part || part === '..' || part === '.') return { state: 'unknown', size: 0 }
      current = join(current, part)
      const st = lstatSync(current)
      if (st.isSymbolicLink() || (i < parts.length - 1 ? !st.isDirectory() : !st.isFile())) return { state: 'unknown', size: 0 }
      if (i === parts.length - 1) { const realRoot = realpathSync(root); const realFile = realpathSync(current); if (!realFile.startsWith(realRoot + (process.platform === 'win32' ? '\\' : '/'))) return { state: 'unknown', size: 0 }; accessSync(current, constants.R_OK); return { state: st.size > 0 ? 'complete' : 'incomplete', size: st.size } }
    }
  } catch (e) { return { state: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'incomplete' : 'unknown', size: 0 } }
  return { state: 'unknown', size: 0 }
}
export function classifyTranslationStatus(states: Completion[]): Completion {
  return states.includes('unknown') ? 'unknown' : states.every(s => s === 'complete') ? 'complete' : 'incomplete'
}
export function classifyMigrationStatus(hasHit: boolean, folder: boolean, certain: boolean): Completion {
  return !certain ? 'unknown' : hasHit ? 'incomplete' : folder ? 'complete' : 'unknown'
}
function json(root: string, path: string): { state: Completion; value?: any } {
  const p = probe(root, path)
  if (p.state !== 'complete') return { state: p.state }
  if (p.size > 1024 * 1024) return { state: 'unknown' }
  try { return { state: 'complete', value: JSON.parse(readFileSync(path, 'utf8')) } } catch { return { state: 'unknown' } }
}
export function classifyMineruStatus(meta: any, pages: any, text: Probe, artifacts: Completion[]): Completion {
  if (!meta || typeof meta !== 'object') return 'unknown'
  if (meta.producer === 'pdfjs' || meta.producer === 'legacy') return 'incomplete'
  if (!['mineru-local', 'mineru-cloud'].includes(meta.producer)) return 'unknown'
  if (text.state === 'unknown' || artifacts.includes('unknown')) return 'unknown'
  if (text.state === 'incomplete' || artifacts.includes('incomplete')) return 'incomplete'
  if (!Number.isInteger(meta.text?.bytes) || meta.text.bytes <= 0 || meta.text.bytes !== text.size || !Number.isInteger(meta.text?.chars) || meta.text.chars < 1000) return 'unknown'
  if (text.size < 1000) return 'incomplete'
  const spans = pages?.pages
  if (!Number.isInteger(pages?.pageCount) || pages.pageCount < 1 || !Array.isArray(spans) || spans.length === 0) return 'unknown'
  let end = 0
  for (const p of spans) {
    if (!p || typeof p !== 'object' || !Number.isInteger(p.page) || p.page < 1 || p.page > pages.pageCount || !Number.isInteger(p.start) || !Number.isInteger(p.end) || p.start < end || p.end < p.start || p.end > meta.text.chars) return 'unknown'
    end = p.end
  }
  return 'complete'
}
function readStatus(root: string, row: { topic: string; name: string; folder: boolean }, need: MigrationNeed, hit: boolean): PaperStatus {
  const base = join(root, row.topic, ...(row.folder ? [row.name] : []), row.name)
  const pdf = probe(root, base + '.pdf')
  let translation: Completion = 'unknown', mineru: Completion = 'unknown'
  if (pdf.state === 'complete') {
    translation = classifyTranslationStatus(['-zh.pdf', '-dual.pdf'].map(s => probe(root, base + s).state))
    const meta = json(root, base + '.transcript.json')
    if (meta.state !== 'complete') mineru = meta.state
    else {
      const pages = json(root, base + '.pages.json')
      mineru = pages.state !== 'complete' ? pages.state : classifyMineruStatus(meta.value, pages.value, probe(root, base + '.txt'), ['.mineru.md', '.mineru.json'].map(s => probe(root, base + s).state))
    }
  }
  return { topic: row.topic, name: row.name, translation, mineru, migration: classifyMigrationStatus(hit, row.folder, need.certain && pdf.state === 'complete') }
}
export function readPaperStatuses(dataDir: string, opts: { offset?: number; limit?: number; force?: boolean } = {}) {
  const offset = opts.offset ?? 0, limit = opts.limit ?? 100
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid status pagination')
  const root = resolve(dataDir)
  const need = detectMigrationNeed(root, opts.force ? { force: true } : {})
  const details = migrationScanDetails(need)
  const rows = [...details.papers].sort((a, b) => a.topic.localeCompare(b.topic) || a.name.localeCompare(b.name))
  const hits = new Set(details.hits.map(h => JSON.stringify([h.dir, h.stem])))
  const papers = rows.slice(offset, offset + limit).map(row => readStatus(root, row, need, hits.has(JSON.stringify([row.topic, row.name]))))
  return { ok: true, scannedAt: need.scannedAt, snapshotId: createHash('sha256').update(need.dataDirId + need.scannedAt + JSON.stringify(rows)).digest('hex').slice(0, 20), need, papers, total: rows.length, offset, nextOffset: offset + limit < rows.length ? offset + limit : null, complete: need.certain, unreadable: need.unreadable.map(u => ({ topic: u.dir, cause: u.cause })) }
}
