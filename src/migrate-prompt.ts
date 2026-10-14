// migrate-prompt.ts — 「未迁移提示」的判据 + 发问门 + 全局偏好（冻结方案 docs/migrate-prompt-plan.md §1/§2.3/§3.5）。
//
// 三件事，各自独立可测：
//   ① **判据**：实际扫目录（readdir + 比 size，**不读文件内容**）算出「还有几篇论文的产物留在平铺位置」，
//      并如实表达「标记说迁移过、磁盘上还有平铺」与「没有标记、磁盘已是新布局」这两种不一致。
//   ② **发问门**：纯函数决定 ask/info/silent；`ask` 一旦给出就写 `choice='asked'` + 指纹 ⇒ 同一指纹绝不再问。
//   ③ **全局偏好**：$DSH_HOME/.dsh-paper-reader/migration-prompt.json（**库外**：放进 dataDir 会被判据/迁移
//      当成 orphan/hidden 参与列表与迁移，同 src/migrate.ts:10-11 的理由）。
//
// 三条与方案逐字对齐的红线（改回缺陷态必须让用例变红）：
//   · **绝不自动迁移**：本模块只有 readdir/stat/existsSync 与「写偏好文件」两类调用，没有任何 runMigration 路径；
//     执行永远只在 HTTP `confirm:'migrate-library'`（src/host.ts）或 CLI `--yes` 后面。
//   · **不许每次都问**：ask 的写盘发生在**服务端**（§2.3），不依赖 agent 自觉，也不依赖前端。
//   · **只读/无权限时不误报**：`certain=false`（子树读不进去或扫描超预算）⇒ 只给无篇数的中性说明、不发问、不写偏好；
//     库不存在按 `empty` 处理并立即返回（**绝不**调用 `resolveDataDir()`——它会 mkdirSync，src/library.ts:58-62）。
//
// 与权威报告的边界（必须写进代码注释与文案）：本判据是 **size 级**的（不 hash 文件内容），
// `GET /api/library/migrate-plan`（planMigration，含 sha256）才是权威。探针实测两者在 12 个夹具上
// 分类与 stale 集合**零差异**（.probe/migrate-prompt/，方案 §0.3）；文案只给篇数、不展开 residue/conflict 细节。

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { dshHome, isPaperDir, isPaperPDF } from './library.ts'
import { matchArtifactName } from './library-manage.ts'
import { DONE_MARKER, PARTIAL_MARKER, paperDirNameProblem } from './migrate.ts'

/** 论文还有平铺产物的四种形态（方案 §1.1 第 5 条）。 */
export type MigrationClass = 'flat' | 'residue' | 'conflict' | 'quarantine'

/** 未迁移态的状态机取值（方案 §1.1 / §1.2）。 */
export type MigrationState =
  | 'unmigrated'      // 有平铺论文（无同名文件夹）
  | 'residue'         // 文件夹已赢，平铺副本还在（只差清源）
  | 'partial'         // 上次写了 .partial（有跳过项），且仍有可迁移的平铺论文
  | 'marker-mismatch' // 有 .done/.partial 标记，但实际仍有平铺产物（用户手动动过文件）
  | 'needs-manual'    // 只剩 conflict / quarantine：迁移也修不了，须人工
  | 'migrated'        // 实际扫描无平铺产物（无论有无标记）
  | 'empty'           // 库里还没有论文
  | 'unknown'         // 读不进去 / 扫描预算超限 ⇒ 无法判定（不得猜）

export interface MigrationNeed {
  dataDir: string
  /** **库身份**（库根 realpath）：与「库形态指纹」是两个正交的轴 —— 见 decideMigrationPrompt 的说明。
      t6 队长裁定 (b)：换库（根不同）必须重新问一次；同一库内改名/增删只看 fingerprint。 */
  dataDirId: string
  scannedAt: string
  state: MigrationState
  /** ★ 文案里的「还有 N 篇」（**不是** plan.totals.papers——它在 conflict/quarantine 下会少算成 0） */
  papers: number
  /** 这些论文留在平铺位置的产物文件数 */
  files: number
  byClass: Record<MigrationClass, number>
  /** flat + residue（迁移真正能收口的篇数） */
  migratable: number
  orphans: number
  paperDirs: number
  unreadable: Array<{ dir: string; cause: string }>
  /** unreadable.length === 0 && 未超扫描预算 */
  certain: boolean
  markers: { done: boolean; partial: boolean }
  /** 标记与实际的**关系**（如实表达用，方案 §1.3） */
  markerSync: 'none' | 'conflict' | 'stale'
  /** sha256(path|class … + unreadable 计数) 前 12 位；**必须含分类**（只 hash 路径会让 F5→F6 恶化不再提示） */
  fingerprint: string
}

/** 扫描预算（readdir 条目计数）：超限 ⇒ certain=false、state=unknown（宁可说「不知道」也不给错数字）。 */
export const MAX_SCAN_ENTRIES = 20000
/** 进程内缓存 TTL（方案 §1.4；`list_papers` 会被频繁调用）。 */
export const DEFAULT_PROMPT_TTL_MS = 60_000

const CLASSES: MigrationClass[] = ['flat', 'residue', 'conflict', 'quarantine']

/* ═══════════════════════════════════════════════════════════════════════════
   ① 判据：实际扫目录
   ═══════════════════════════════════════════════════════════════════════════ */

interface FlatHit { dir: string; stem: string; files: string[]; cls: MigrationClass }

function sizeOf(file: string): number {
  try { return statSync(file).size } catch { return -1 }
}

function emptyNeed(root: string, state: MigrationState): MigrationNeed {
  return {
    dataDir: root,
    dataDirId: dataDirIdOf(root),
    scannedAt: new Date().toISOString(),
    state,
    papers: 0,
    files: 0,
    byClass: { flat: 0, residue: 0, conflict: 0, quarantine: 0 },
    migratable: 0,
    orphans: 0,
    paperDirs: 0,
    unreadable: [],
    certain: state !== 'unknown',
    markers: { done: false, partial: false },
    markerSync: 'none',
    fingerprint: fingerprintOf([], 0),
  }
}

/**
 * 库身份 = 库根的 realpath（拿不到时退回 resolve）。用它而**不是**专题名：
 * 专题/论文改名不改变身份，换一个库（另一份 data 目录）则必然不同。
 */
function dataDirIdOf(root: string): string {
  try { return realpathSync(root) } catch { return resolve(root) }
}

function fingerprintOf(hits: FlatHit[], unreadableCount: number): string {
  const lines = hits.map((hh) => `${hh.dir ? `${hh.dir}/` : ''}${hh.stem}|${hh.cls}`).sort()
  return createHash('sha256').update(`${lines.join('\n')}\nunreadable:${unreadableCount}`).digest('hex').slice(0, 12)
}

/**
 * 递归扫描（论文目录**不递归**，与 planMigration 同口径）：命中论文目录即登记 stem 并停止下潜，
 * 否则继续（跳过 `.` 开头的非论文目录，同 listPapers）。readdir 抛错 ⇒ 记 unreadable 并**继续**其它子树。
 */
function scanOnce(root: string): MigrationNeed {
  const hits: FlatHit[] = []
  const unreadable: Array<{ dir: string; cause: string }> = []
  let orphans = 0
  let paperDirs = 0
  let entryCount = 0
  let budgetExceeded = false

  const walk = (rel: string): void => {
    if (budgetExceeded) return
    const dir = rel ? join(root, rel) : root
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      // 根也用 `.` 表示（与 planMigration R2-2 同款：漏掉根 ⇒ 「读不进去」被静默当成「库里什么都没有」）
      unreadable.push({ dir: rel || '.', cause: (err as NodeJS.ErrnoException).code ?? 'unknown' })
      return
    }
    entryCount += entries.length
    if (entryCount > MAX_SCAN_ENTRIES) { budgetExceeded = true; return }

    // 第一步：本层的 stem 有两个来源（并集，与 planMigration 的 byStem 逐条一致）——
    //   ① 平铺的 `<名>.pdf`（含前导点的隐藏论文；pdf2zh 的 -en/-zh/-dual 不算文献）⇒ flatStems
    //   ② 已存在的论文文件夹 `<名>/`（文件夹赢：同名平铺 pdf 不再单独成篇）⇒ folderStems
    // 两者必须分开记：分类要区分「只差清源的残留（有文件夹）」与「还没建文件夹的平铺」。
    const folderStems = new Set<string>()
    const flatStems = new Set<string>()
    const taken = new Set<string>()          // 本层已存在的名字（判「目标名被文件/子专题目录占据」用）
    const subdirs: string[] = []
    for (const e of entries) {
      taken.add(e.name)
      if (e.isDirectory()) {
        const child = join(dir, e.name)
        if (isPaperDir(child)) { paperDirs++; folderStems.add(e.name); continue }
        if (e.name.startsWith('.')) continue
        subdirs.push(e.name)
        continue
      }
      if (isPaperPDF(e.name)) flatStems.add(e.name.slice(0, -4))
    }

    // 第二步：把本层的**非目录**条目挂到命中的 stem 上（精确后缀族匹配，刻意不用 startsWith）
    const byStem = new Map<string, string[]>()
    for (const stem of [...folderStems, ...flatStems]) byStem.set(stem, [])
    for (const e of entries) {
      if (e.isDirectory()) continue
      let matched = false
      for (const stem of byStem.keys()) {
        if (matchArtifactName(stem, e.name)) { byStem.get(stem)!.push(e.name); matched = true; break }
      }
      if (matched) continue
      // 没匹配上任何论文 stem 的隐藏名（.DS_Store 等）不算孤儿；其余原地不动、只报告
      if (!e.name.startsWith('.')) orphans++
    }

    // 第三步：分类（方案 §1.1 第 5 条）
    for (const [stem, files] of byStem) {
      if (files.length === 0) continue          // 只有文件夹、没有平铺残留 ⇒ 这篇已经收口了
      let cls: MigrationClass
      if (paperDirNameProblem(stem)) {
        // 只有这个函数能判定的形态（过长/含分隔符/`.`/`..`）：文件系统上看不出「迁移也建不出目录」
        cls = 'quarantine'
      } else if (folderStems.has(stem)) {
        // 文件夹赢了：逐个比同名文件的 size（不 hash）。缺失或不同 ⇒ conflict（迁移会跳过该篇，绝不覆盖）
        const folderDir = join(dir, stem)
        cls = files.every((f) => sizeOf(join(folderDir, f)) === sizeOf(join(dir, f))) ? 'residue' : 'conflict'
      } else if (taken.has(stem)) {
        // 同名条目存在但**不是**论文文件夹（被普通文件或子专题目录占据）⇒ planMigration 会报 conflict
        cls = 'conflict'
      } else {
        cls = 'flat'
      }
      hits.push({ dir: rel, stem, files, cls })
    }

    for (const name of subdirs) walk(rel ? `${rel}/${name}` : name)
  }
  walk('')

  const byClass: Record<MigrationClass, number> = { flat: 0, residue: 0, conflict: 0, quarantine: 0 }
  let files = 0
  for (const hh of hits) { byClass[hh.cls]++; files += hh.files.length }
  const papers = hits.length
  const migratable = byClass.flat + byClass.residue
  const certain = unreadable.length === 0 && !budgetExceeded
  const markers = { done: existsSync(join(root, DONE_MARKER)), partial: existsSync(join(root, PARTIAL_MARKER)) }
  const markerSync: MigrationNeed['markerSync'] =
    papers > 0 && (markers.done || markers.partial) ? 'conflict'
      : papers === 0 && markers.partial && !markers.done ? 'stale'
        : 'none'

  let state: MigrationState
  if (!certain) state = 'unknown'
  else if (papers > 0) {
    if (byClass.flat > 0 && markers.done) state = 'marker-mismatch'
    else if (byClass.flat > 0 && markers.partial) state = 'partial'
    else if (byClass.flat > 0) state = 'unmigrated'
    else if (migratable > 0) state = 'residue'
    else state = 'needs-manual'
  } else state = paperDirs > 0 ? 'migrated' : 'empty'
  // 注（t6 低危 F6）：**空库 + 陈旧 .done** 过去会被判 'migrated' ⇒ 界面显示「已是新布局」（对一个
  // 一篇论文都没有的库下布局结论 = 误报）。现在 papers===0 且 paperDirs===0 ⇒ 'empty'，标记只进
  // markerSync（如实表达分歧），不再单独构成「已迁移」的证据。

  return {
    dataDir: root,
    dataDirId: dataDirIdOf(root),
    scannedAt: new Date().toISOString(),
    state,
    papers,
    files,
    byClass,
    migratable,
    orphans,
    paperDirs,
    unreadable,
    certain,
    markers,
    markerSync,
    fingerprint: fingerprintOf(hits, unreadable.length),
  }
}

/* ── 进程内缓存（方案 §1.4）：TTL + 显式失效 + 扫描计数（用例据此断言「第二次不再扫」） ── */
const cache = new Map<string, { at: number; need: MigrationNeed }>()
/** 判据真正执行扫描的次数（测试/诊断用；缓存命中不计数）。 */
export const migrationScanStats = { scans: 0 }

function ttlMs(): number {
  const raw = process.env['DPR_MIGRATE_PROMPT_TTL_MS']
  if (raw === undefined || raw.trim() === '') return DEFAULT_PROMPT_TTL_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PROMPT_TTL_MS
}

/** 失效点：迁移/回滚成功、上传/删除/改名/新建专题/清空专题、以及「重新检查」。 */
export function invalidateMigrationPromptCache(dataDir?: string): void {
  if (dataDir === undefined) cache.clear()
  else cache.delete(resolve(dataDir))
}

/**
 * 判据入口。**绝不抛**：任何意外异常都降级为 `unknown` + `certain:false`（不发问、不写偏好）。
 * `force` = 绕过缓存（＝「重新检查」）。`hash` 保留但**不参与**判定（本判据刻意只比 size，见文件头）。
 */
export function detectMigrationNeed(dataDir: string, opts: { force?: boolean; hash?: boolean } = {}): MigrationNeed {
  const root = resolve(dataDir)
  if (!opts.force) {
    const hit = cache.get(root)
    if (hit && Date.now() - hit.at < ttlMs()) return hit.need
  }
  let need: MigrationNeed
  try {
    // 不存在 ⇒ empty 并立即返回（**绝不** mkdir：红线④）
    need = existsSync(root) ? scanOnce(root) : emptyNeed(root, 'empty')
  } catch {
    const fallback = emptyNeed(root, 'unknown')
    need = { ...fallback, certain: false, unreadable: [{ dir: '.', cause: 'scan-failed' }] }
  }
  migrationScanStats.scans++
  cache.set(root, { at: Date.now(), need })
  return need
}

/* ═══════════════════════════════════════════════════════════════════════════
   ② 全局偏好（服务端权威；库外文件；对话侧与界面侧共用同一份记忆）
   ═══════════════════════════════════════════════════════════════════════════ */

export type PromptChoice = 'idle' | 'asked' | 'later' | 'declined'

export interface PromptState {
  v: 1
  key: 'migratePrompt.v1'
  choice: PromptChoice
  at: string | null
  by: 'tool' | 'ui' | null
  declaredPapers: number | null
  fingerprint: string | null
  /** 记下「这条回答是针对哪个库的」（库根 realpath）：换库 ⇒ 重新问一次（t6 队长裁定 (b)） */
  dataDir: string | null
  pluginVersion: string
}

const PROMPT_KEY = 'migratePrompt.v1'
const PLUGIN_VERSION = '1.6.0'
const CHOICES: PromptChoice[] = ['idle', 'asked', 'later', 'declined']

export function migrationPromptStatePath(): string {
  const override = process.env['DPR_MIGRATE_PROMPT_STATE']?.trim()
  return override || join(dshHome(), '.dsh-paper-reader', 'migration-prompt.json')
}

export function idlePromptState(): PromptState {
  return { v: 1, key: PROMPT_KEY, choice: 'idle', at: null, by: null, declaredPapers: null, fingerprint: null, dataDir: null, pluginVersion: PLUGIN_VERSION }
}

/** 任何字段非法 / 文件缺失 / JSON 坏 ⇒ 回落 idle（最坏结果是多问一次，不致命）。 */
function normalizeState(raw: unknown): PromptState {
  const base = idlePromptState()
  if (!raw || typeof raw !== 'object') return base
  const r = raw as Record<string, unknown>
  if (r['key'] !== PROMPT_KEY) return base
  if (!CHOICES.includes(r['choice'] as PromptChoice)) return base
  const by = r['by'] === 'tool' || r['by'] === 'ui' ? r['by'] : null
  const declared = typeof r['declaredPapers'] === 'number' && Number.isFinite(r['declaredPapers']) ? r['declaredPapers'] : null
  return {
    v: 1,
    key: PROMPT_KEY,
    choice: r['choice'] as PromptChoice,
    at: typeof r['at'] === 'string' ? r['at'] : null,
    by,
    declaredPapers: declared,
    fingerprint: typeof r['fingerprint'] === 'string' ? r['fingerprint'] : null,
    dataDir: typeof r['dataDir'] === 'string' && r['dataDir'] ? r['dataDir'] : null,
    pluginVersion: typeof r['pluginVersion'] === 'string' ? r['pluginVersion'] : PLUGIN_VERSION,
  }
}

/** 写盘失败（$DSH_HOME 只读）时的进程内记忆：本次仍要保证「同一指纹不再问」。 */
const memoryFallback = new Map<string, PromptState>()

export function readPromptState(): PromptState {
  const path = migrationPromptStatePath()
  try {
    return normalizeState(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return memoryFallback.get(path) ?? idlePromptState()
  }
}

/**
 * 原子写（tmp + rename，沿用 src/embed.ts / src/transcribe.ts 的语义；权限 0o600）。
 * 返回 `ok:false` 表示只写进了进程内记忆（**不**向用户报错——这不是用户能修的错）。
 */
export function writePromptState(patch: Partial<Omit<PromptState, 'v' | 'key'>> & { choice: PromptChoice }): { ok: boolean; state: PromptState } {
  const path = migrationPromptStatePath()
  const state: PromptState = { ...readPromptState(), ...patch, v: 1, key: PROMPT_KEY }
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, path)
    memoryFallback.delete(path)
    return { ok: true, state }
  } catch {
    memoryFallback.set(path, state)
    return { ok: false, state }
  }
}

/** 「重新检查」：清掉之前的回答（DELETE 路由 / 设置面板按钮）。 */
export function resetPromptState(): PromptState {
  const path = migrationPromptStatePath()
  try { rmSync(path, { force: true }) } catch { /* 不存在 / 权限：无所谓，回落 idle 即可 */ }
  memoryFallback.delete(path)
  return idlePromptState()
}

/** 供 UI/测试用的公开形状（只暴露状态本身，不泄路径）。 */
export function promptStatePayload(state: PromptState): {
  choice: PromptChoice; at: string | null; by: 'tool' | 'ui' | null; declaredPapers: number | null
  fingerprint: string | null; dataDir: string | null
} {
  return {
    choice: state.choice, at: state.at, by: state.by, declaredPapers: state.declaredPapers,
    fingerprint: state.fingerprint, dataDir: state.dataDir,
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   ③ 发问门 + 冻结文案
   ═══════════════════════════════════════════════════════════════════════════ */

export type PromptLevel = 'ask' | 'info' | 'silent'
export type PromptLang = 'zh' | 'en'

export interface PromptDecision {
  level: PromptLevel
  reason: string
  text: string
  askHint: string | null
}

const ASK_STATES: MigrationState[] = ['unmigrated', 'residue', 'partial', 'marker-mismatch']

/** 文案语言：工具返回默认 zh（本插件工具输出全中文）；可用 DPR_MIGRATE_PROMPT_LANG=en 切英文。 */
function langOf(opts?: { lang?: PromptLang }): PromptLang {
  if (opts?.lang) return opts.lang
  return process.env['DPR_MIGRATE_PROMPT_LANG']?.trim() === 'en' ? 'en' : 'zh'
}

/** §2.2 的 ask 文案（逐字冻结；`{n}/{f}` 用实际数字替换）。 */
function askText(need: MigrationNeed, lang: PromptLang): string {
  const n = need.papers
  const f = need.files
  const note = markerNote(need, lang)
  const tail = note ? `\n${note}` : ''
  if (lang === 'en') {
    return `[Layout notice] Your library still uses the old flat layout: ${n} paper(s) are not in their own folders yet (${f} files).\n`
      + `The old layout keeps working — listing/opening/searching/deleting/renaming are unaffected; this notice blocks nothing.\n`
      + `Migrate to the new "one folder per paper" layout?\n`
      + ` · First a read-only dry-run report (no file is changed), then you decide;\n`
      + ` · Actual execution only happens in the reader/settings panel — I have no execution path and will never migrate automatically;\n`
      + ` · Say "not now" and I won't ask again; you can re-check later under Settings → Paper Reader → Re-check.\n`
      + `I can call migration_report (read-only) for details.${tail}`
  }
  return `【布局提示】文献库还是旧（平铺）布局：还有 ${n} 篇论文的产物散落在专题目录里（共 ${f} 个文件）。\n`
    + `旧布局照常可用——列表/打开/检索/删除/改名都不受影响，这条提示不阻塞任何操作。\n`
    + `要不要迁移到新布局「按论文分文件夹」？\n`
    + ` · 先出只读干跑报告（不改任何文件），你看完报告再决定；\n`
    + ` · 真正的执行只能在阅读器/设置面板里做，我这边没有执行入口，**绝不会自动迁移**；\n`
    + ` · 不想迁就回「不用」，之后不再主动问；改主意可在「设置 → 论文伴读 → 重新检查」。\n`
    + `要看详情可以让我调用 migration_report（只读）。${tail}`
}

/**
 * §1.3「标记与实际不符」的备注句（接在 ask 文案末尾，不单独成 level）。
 * 判据用**实际扫描**（papers>0）而不是 state：residue+`.partial` 也是「标记说完成、磁盘还有平铺」这一类。
 */
function markerNote(need: MigrationNeed, lang: PromptLang): string {
  const n = need.papers
  if (n > 0 && need.markers.done) {
    return lang === 'en'
      ? `Note: a "done" marker exists, but ${n} paper(s) are still flat on disk — the marker disagrees with the files (you may have moved things by hand). The actual scan wins.`
      : `注意：检测到「已完成」标记，但目录里确实还有 ${n} 篇处于旧布局——标记与磁盘不一致（可能你手动动过文件）。以实际扫描为准。`
  }
  if (n > 0 && need.markers.partial) {
    return lang === 'en'
      ? `A "partially done" marker is present (last run skipped items) and ${n} paper(s) are still flat: handle those skipped items first, then run the migration again.`
      : `检测到「部分完成」标记（上次有跳过项），且仍有 ${n} 篇处于旧布局：需要先处理上次的跳过项，再跑迁移。`
  }
  return ''
}

function infoText(need: MigrationNeed, reason: string, lang: PromptLang): string {
  if (reason === 'needs-manual') {
    const n = need.papers
    return lang === 'en'
      ? `[Layout notice] ${n} paper(s) need manual review: a same-named folder holds different content, so migration will skip them (see the report).`
      : `【布局提示】有 ${n} 篇需要人工确认：同名文件夹里已有不同内容的文件，迁移会跳过该篇（详见迁移报告）。`
  }
  if (reason === 'unreadable') {
    const n = need.unreadable.length || 1
    return lang === 'en'
      ? `[Layout notice] ${n} subtree(s) are unreadable (permissions); cannot tell whether migration is needed — no count is shown to avoid a wrong claim.`
      : `【布局提示】有 ${n} 棵子树读不进去（权限），暂时无法判断是否还有未迁移的论文——不显示篇数以免误导。`
  }
  if (reason === 'budget') {
    // 扫描预算超限（§2.5 失败回退表）：库很大没扫完 ⇒ 同样不给篇数
    return lang === 'en'
      ? `[Layout notice] The library is large and this scan stopped early (over ${MAX_SCAN_ENTRIES} directory entries); cannot tell whether migration is needed — no count is shown to avoid a wrong claim.`
      : `【布局提示】文献库很大，这次没扫完（超过 ${MAX_SCAN_ENTRIES} 个目录项），暂时无法判断是否还有未迁移的论文——不显示篇数以免误导。`
  }
  // 注：`.partial` 残留但实际已无平铺（markerSync='stale'）按 §1.2 归 `migrated` ⇒ silent。
  // 「只备注不报警」由 need.markerSync 字段如实表达（界面/报告可据此显示，不塞进工具结果）。
  return ''   // already-asked / later / declined / migrated / empty / disabled：不往结果里塞噪音
}

/** §2.3 的 ask_hint（只在 level==='ask' 时出现；info/silent 时为 null）。 */
function askHint(need: MigrationNeed, lang: PromptLang): string {
  const n = need.papers
  if (lang === 'en') {
    return `If the user is asking about the library right now, ask in one sentence: "The library is still on the flat layout — ${n} paper(s) are not in their own folders; migrate now? I'll show you a read-only report first." Do not ask twice; if the user says no, call migration_prompt_choice(choice:'later') or 'declined'.`
  }
  return `若用户这次问的正是文献库，用一句话问：「库还是旧布局，还有 ${n} 篇没归到文件夹里，要不要现在迁移？迁移前会先给你一份只读报告。」不要重复问；用户答「不用」就调用 migration_prompt_choice(choice:'later') 或 'declined'。`
}

/**
 * 纯函数发问门（§1.2 表）：不发盘、不发问副作用，便于单测与「UI 首帧渲染后再回写 asked」的两段式。
 * 逃生开关 `DPR_MIGRATE_PROMPT=off` ⇒ 直接 silent（运维/排障用）。
 */
export function decideMigrationPrompt(need: MigrationNeed, state: PromptState, opts: { lang?: PromptLang } = {}): PromptDecision {
  const lang = langOf(opts)
  if (process.env['DPR_MIGRATE_PROMPT']?.trim() === 'off') return { level: 'silent', reason: 'disabled', text: '', askHint: null }
  if (need.state === 'migrated' || need.state === 'empty') return { level: 'silent', reason: need.state, text: '', askHint: null }
  if (need.state === 'unknown') {
    // §2.5 失败回退表第 1 行：**根**都读不进去（或判据抛错）⇒ 连「库里有没有论文」都不知道，
    // 干脆完全不出声（绝不编造「可能需要迁移」）；此时 migration.error='scan-failed' 只作诊断字段。
    // §1.2/§1.3：只是**子**树读不进去（F7 那种）⇒ 给无篇数的中性说明、不发问、不写偏好。
    if (need.unreadable.some((u) => u.dir === '.')) return { level: 'silent', reason: 'scan-failed', text: '', askHint: null }
    const reason = need.unreadable.length > 0 ? 'unreadable' : 'budget'
    return { level: 'info', reason, text: infoText(need, reason, lang), askHint: null }
  }
  if (need.state === 'needs-manual') {
    // 「需人工」不发问，但「标记说迁移过、磁盘还有平铺」这件事必须如实带出来（§1.3 的备注句）
    const note = markerNote(need, lang)
    const text = infoText(need, 'needs-manual', lang)
    return { level: 'info', reason: 'needs-manual', text: note ? `${text}\n${note}` : text, askHint: null }
  }
  // 到这里一定是 ask 类状态（unmigrated/residue/partial/marker-mismatch，migratable>0）
  // 「这条回答还算不算数」要同时看**两个正交的轴**（t6 队长裁定 (b)）：
  //   · 库身份（dataDirId，库根 realpath）：不同库 ⇒ 上一次的回答与这个库无关 ⇒ 必须重新问
  //     （不这样做时「同形状的另一个库」会被当成「已经问过」⇒ 静默漏提示，而漏提示比多问一次差）；
  //   · 库形态指纹（fingerprint，含分类）：同一库内篇数/分类变化 ⇒ 带新数字再问一次。
  // 老状态文件没记库身份（dataDir=null）⇒ 视为「不同库」，最多多问一次。
  const sameLibrary = state.dataDir !== null && state.dataDir === need.dataDirId
  if (state.choice === 'declined' && sameLibrary) {
    // declined 是吸态：**在同一个库内**任何检测（含新论文出现）都只降级为 info，
    // 只有显式「重新检查」/换库才回 idle 语义。
    return { level: 'info', reason: 'declined', text: '', askHint: null }
  }
  if ((state.choice === 'asked' || state.choice === 'later') && sameLibrary) {
    if (state.fingerprint && state.fingerprint === need.fingerprint) {
      return { level: 'info', reason: state.choice === 'later' ? 'later' : 'already-asked', text: '', askHint: null }
    }
    // 指纹变了（情况变了：篇数/分类/不可读集合）⇒ 带新数字再问一次
  }
  return { level: 'ask', reason: need.state, text: askText(need, lang), askHint: askHint(need, lang) }
}

export interface TakenPrompt extends PromptDecision {
  /** 本次是否真的把 choice 写成了 asked（服务端的「只问一次」保证） */
  asked: boolean
  state: PromptState
}

/**
 * 决策 + 「ask 即写 asked」（§2.3 的服务端保证，不依赖 agent 自觉）。
 * 写盘失败 → 进程内记忆兜底（本次仍返回 ask；不向用户报错）。
 */
export function takeMigrationPrompt(need: MigrationNeed, opts: { lang?: PromptLang; by?: 'tool' | 'ui' } = {}): TakenPrompt {
  const state = readPromptState()
  const decision = decideMigrationPrompt(need, state, opts)
  if (decision.level !== 'ask') return { ...decision, asked: false, state }
  const written = writePromptState({
    choice: 'asked',
    at: new Date().toISOString(),
    by: opts.by ?? 'tool',
    declaredPapers: need.papers,
    fingerprint: need.fingerprint,
    dataDir: need.dataDirId,
  })
  return { ...decision, asked: true, state: written.state }
}
