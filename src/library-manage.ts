// library-manage.ts — 文献库的破坏性操作（删除 / 重命名）与配套的安全校验。
//
// 契约：docs/reader-ux-requirements.md §2。要点：
//   · 写路径**只接受** topic + name（不接受 path），逐条做路径穿越防护；
//   · 删除 = 精确 stem 匹配的产物清单，**移入 `<dataDir>/.trash/`**（可恢复），
//     移动失败绝不回退 unlink，`.pdf` 最后移（失败时文献仍在库里可见可用）；
//   · 删除专题只允许空目录，非递归语义（rmdir），隐藏条目进回收站而不是销毁；
//   · 重命名先校验全部前提再动手，中途失败 best-effort 回滚。
//
// 本模块不依赖 Cordis，可直接被测试 import（dist/library-manage.js）。

import {
  closeSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync,
  renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
// 共享的**边界原语**（上游 #4 的路径穿越修复，逐字保留在 library.ts）：
// validateEntryName / validateEntryBoundary / realDataDir / assertInside。
// 注意口径（评审 F-F）：组合层**两套并存**——生产写路径用本模块的 resolveTopicDirChecked
// （在其上更严），#4 的 resolveSafeTopic 组合层只被 library.ts 的适配器（上游测试用）调用。
// 本模块**消费**它，不再自己重复一套词法/realpath 校验；我们的加严叠在其上（见下）。
import {
  MAX_TOPIC_DEPTH,
  MAX_TOPIC_PATH,
  MAX_TOPIC_SEG,
  encodedEscapeError,
  assertInside as assertInsideShared,
  isPaperDir,
  isPaperPDF,
  listPapers,
  normalizeTopicPath,
  paperDir,
  realDataDir as realDataDirShared,
  validateEntryBoundary as validateBoundaryShared,
  validateEntryName,
} from './library.ts'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'

// ── 错误 ─────────────────────────────────────────────────────────────────────

export type ManageCode =
  | 'bad-name'
  | 'bad-request'
  | 'not-found'
  | 'escape-rejected'
  | 'target-exists'
  | 'confirm-mismatch'
  | 'topic-not-empty'
  | 'session-running'
  | 'translation-busy'
  | 'trash-move-failed'
  | 'rename-partial'
  // 上游评审必修 3：Windows 的 EBUSY/EPERM（文件被阅读器/杀软/索引/同步盘占用）是高频道，
  // 必须给「文件被占用，关闭后重试」的 409（上游 fsError 的语义），而不是笼统的 500。
  | 'file-busy'
  // 契约 §5 R5 的并发互斥机器码字面为 `in-progress`；实现统一用更简洁的 `busy`（语义一致），
  // 已在 host.ts 的 withInflight 注释与前端 errText 对齐。见 src/host.ts。
  | 'busy'
  // ── agent 文献整理工具（docs/library-manage-tools-plan.md §3.2.1）─────────────
  // 收录（add_paper）的源文件边界：源是用户显式给的本地文件，不是库内路径。
  | 'source-not-found'
  | 'source-invalid'
  | 'source-not-pdf'
  | 'source-empty'
  // 移动（move_paper）：旧布局一律拒绝（迁移只能在界面执行，对话侧没有迁移执行路径）。
  | 'legacy-layout'
  // 收录/移动/建专题的写入中途失败（已回滚或部分残留，extra 说明）。
  | 'add-partial'
  | 'move-partial'
  // 伴读会话状态不可知：host 原本用裸 json 输出，工具层需要机器码，故统一进闭集。
  | 'session-unknown'
  // 「论文夹 + 同 stem 平铺残留」混合态（迁移冲突后的真实形态）：破坏性动作必须拒绝，
  // 否则只处理一半却报告成功，会让同一篇重复出现或被静默遮蔽（t4 评审 F2）。
  | 'layout-conflict'
  // 审批（ctx.approval.request）四态里除 allowed-once 之外的三态（fail closed）。
  | 'approval-rejected'
  | 'approval-cancelled'
  | 'approval-unavailable'

/** HTTP 状态与机器可读 code 双携带；`extra` 会并入响应体（前端只认 code，不匹配中文）。 */
export class ManageError extends Error {
  readonly code: ManageCode
  readonly status: number
  readonly extra: Record<string, unknown>
  constructor(code: ManageCode, status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ManageError'
    this.code = code
    this.status = status
    this.extra = extra
  }
}

export function isManageError(e: unknown): e is ManageError {
  return e instanceof ManageError
}

// ── 名称校验 ────────────────────────────────────────────────────────────────

/** 回收站目录名（保留名；`listTopics` 因隐藏而跳过它，因此不会显示成专题）。 */
export const TRASH_DIR = '.trash'

/**
 * 命名规范类校验（创建 / 改名-to 用）——**复用上游 #4 的 `validateEntryName`**，
 * 只把 `string | null` 的形状映射成我们的 `ManageError('bad-name', 400, 文案)`；
 * 文案沿用 #4 原句（上游用例按正则断言：/名字过长/、/名字不能包含控制字符/…）。
 * 语义与 #4 完全一致：trim 后使用（`'  T  '` 落到 `T`）、长度 ≤ 120、拒绝全部 C0 控制字符
 * 与 DEL、拒绝前导点、拒绝 `/ \ ..`。
 */
export function validateName(raw: unknown, label: 'topic' | 'paper'): string {
  const what = label === 'topic' ? '专题名' : '文献名'
  if (typeof raw !== 'string') throw new ManageError('bad-name', 400, `${what}不能为空`)
  const err = validateEntryName(raw)
  if (err) throw new ManageError('bad-name', 400, err)
  return raw.trim()
}

/**
 * 边界类校验（删除 / 改名-from / 已存在条目用）——**复用上游 #4 的 `validateEntryBoundary`**
 * （空、`/ \`、`..`、NUL），并叠上我们的两条加严：`.trash` 是保留名、`basename` 必须一致。
 *
 * 与 `validateName`（命名规范类：长度、前导点、非 NUL 控制字符）的分工是 PR-1 的分层原则：
 * 命名规范只在**创建/改名**时强制（那是用户在新起一个名字）；删除/改名-from 作用于
 * **已存在**的条目，若也按命名规范卡，「创建时宽松、事后规范收紧」或历史遗留的名字
 * （前导点、超长、`\x01`）就会变成删不掉的孤儿。反之，upload 能落盘的名字都必须能删。
 *
 * 原样返回 raw（**不 trim**），与创建侧的 trim 语义分开：按字面名匹配磁盘条目。
 */
export function validateEntryBoundary(raw: unknown, label: 'topic' | 'paper'): string {
  const what = label === 'topic' ? '专题名' : '文献名'
  if (typeof raw !== 'string' || raw.length === 0) throw new ManageError('bad-name', 400, `${what}不能为空`)
  const err = validateBoundaryShared(raw)
  if (err) throw new ManageError('bad-name', 400, err)
  if (basename(raw) !== raw) throw new ManageError('bad-name', 400, `${what}非法`)
  // `.` / `..` 不是任何条目的名字（上游边界类只挡 `..`，`basename` 归一后是 `.` 的形态也一并挡掉；
  // 这是我们的加严——realpath 层随后还会拒 target === root，两道都在）。
  if (basename(raw) === '.' || basename(raw) === '..') throw new ManageError('bad-name', 400, `${what}非法`)
  // 回收站是插件自己的保留目录（listTopics 因隐藏而跳过它，用户也创建不了）：
  // 不允许把它当专题删掉/改名，否则回收站里的可恢复文件会被误销毁。
  if (raw === TRASH_DIR) throw new ManageError('bad-name', 400, `${what}是保留名，不能操作`)
  return raw
}

/**
 * 新建/收录的**论文名**规范（agent 文献整理工具新增；docs/library-manage-tools-plan.md §3.2.2）：
 * 命名规范类 + 两条针对文献库语义的加严：
 *   · 不带 `.pdf` 后缀（否则会生成 `<X.pdf>/<X.pdf>.pdf` 的嵌套怪名）；
 *   · 不以 `-en/-zh/-dual` 结尾（`isPaperPDF` 会把它们当译文变体 ⇒ 收录后从库里「消失」）。
 * 这是**纯重构**：把 `validateNewPaperName` 里已有的两条规则搬出来，供 add_paper 复用。
 */
export function validatePaperName(raw: unknown): string {
  const name = validateName(raw, 'paper')
  if (name.toLowerCase().endsWith('.pdf')) {
    throw new ManageError('bad-name', 400, '文献名不带 .pdf 后缀')
  }
  // ⚠️ 与冻结方案 §3.2.2 的一处**有据偏离**：方案写的是 `/-en$|-zh$|-dual$/i`（大小写不敏感），
  // 但库内既有契约是**大小写敏感**的——`isPaperPDF` 用大小写敏感比较（`src/library.ts`），
  // 因此大写 `-ZH` 既不是变体、也不会被隐藏；`test/reader-ux-verification.test.mjs` 的 VB9/S12
  // 明确钉住「大写 -ZH 改名允许、改名后文献仍在库里」。改成 `/i` 会把这条既有契约变成 400，
  // 属实的回归。故这里**保持**原实现的敏感正则（与 `isPaperPDF` 同一口径），并在 C8 用例中钉住。
  if (/-en$|-zh$|-dual$/.test(name)) {
    throw new ManageError('bad-name', 400, '文献名不能以 -en/-zh/-dual 结尾（会被当作译文变体而从库中隐藏）')
  }
  return name
}

/** 文献改名目标名：`validatePaperName` + 拒绝与原名称相同（改名路由的既有语义）。 */
export function validateNewPaperName(raw: unknown, current: string): string {
  const name = validatePaperName(raw)
  if (name === current) throw new ManageError('bad-request', 400, '新名称与原名称相同')
  return name
}

// ── 路径解析与穿越防护 ───────────────────────────────────────────────────────

/**
 * target 必须落在 root 内（严格子路径），否则视为越界。
 * **复用上游 #4 的 `assertInside`**（带 sep 边界的严格前缀比较），并在其上叠我们的一条加严：
 * 上游允许 `target === root`（`target !== root && !startsWith`），我们**拒绝**——对
 * deleteTopic/rename 这类破坏性操作，把「库根目录本身」当专题名操作必须挡掉
 * （既有用例钉住：reader-ux-verification 的 VB5 ⑤）。
 */
export function assertInside(root: string, target: string): void {
  try {
    assertInsideShared(root, target)                     // 上游 #4 的严格子路径包含
  } catch {
    // 上游抛的是不带 .code 的普通 Error → 统一映射成带机器码的 ManageError（host 的错误通道认 code）
    throw new ManageError('escape-rejected', 400, '路径越界，已拒绝')
  }
  if (target === root) throw new ManageError('escape-rejected', 400, '路径越界，已拒绝')
}

/** 文献库根目录的真实路径（必须存在）——复用 #4 的 realpath 规范化，错误映射成我们的 404。 */
export function realDataDir(dataDir: string): string {
  try {
    return realDataDirShared(dataDir)
  } catch {
    throw new ManageError('not-found', 404, '文献库目录不存在')
  }
}

/**
 * 专题**路径**校验（方案 §B2.2 冻结）：topic 从「单段名」升级为「相对路径」（`A` / `A/B` / `A/B/C`）。
 * 规则：非空、≤ MAX_TOPIC_PATH(200)、段数 ≤ MAX_TOPIC_DEPTH(16)、**逐段**复用既有校验
 * （命名规范类 / 边界类）、每段 ≤ MAX_TOPIC_SEG(100)，返回规范化后的 `A/B` 形式。
 * **红线**：绝不改成「放宽 validateName 里那条 `/` 正则」——切段逐段校验是放开 `/` 的唯一安全方式。
 */
export function validateTopicPath(raw: unknown, boundaryOnly = false): string {
  const what = '专题名'
  if (typeof raw !== 'string') throw new ManageError('bad-name', 400, `${what}不能为空`)
  const trimmed = raw.trim()
  if (!trimmed) throw new ManageError('bad-name', 400, '名字不能为空')
  // F4 负向：编码变形（`%2E%2E%2F`）解码后才是分隔符/上跳 ⇒ 一律拒（合法含 `%` 的名字不受影响）
  const enc = encodedEscapeError(trimmed)
  if (enc) throw new ManageError('bad-name', 400, enc)
  if (trimmed.length > MAX_TOPIC_PATH) throw new ManageError('bad-name', 400, `名字过长（专题路径最多 ${MAX_TOPIC_PATH} 个字符）`)
  const segs = trimmed.split('/')
  if (segs.length > MAX_TOPIC_DEPTH) throw new ManageError('bad-name', 400, `路径越界：专题层级过深（最多 ${MAX_TOPIC_DEPTH} 层）`)
  for (const seg of segs) {
    // ⚠️ 必须用**本模块**的逐段校验器：它们在共享原语之上叠了加严（`.trash` 是保留名、
    // `basename(raw)===raw`、`.`/`..` 形态）。用 library.ts 的裸原语会让 `.trash` 变成可改名/可删的
    // 「专题」——那条是回收站，改名/删除它会毁掉用户的可恢复数据（VB4/P3 实测）。
    if (boundaryOnly) validateEntryBoundary(seg, 'topic')
    else validateName(seg, 'topic')
    if (seg.trim().length > MAX_TOPIC_SEG) throw new ManageError('bad-name', 400, `名字过长（每层最多 ${MAX_TOPIC_SEG} 个字符）`)
  }
  return segs.map((s) => s.trim()).join('/')
}

/** 解析专题目录的公共实现：`boundaryOnly` 选择词法校验的强度（见 validateEntryBoundary）。 */
function resolveTopicDirChecked(dataDir: string, topic: unknown, boundaryOnly: boolean): string {
  const name = validateTopicPath(topic, boundaryOnly)
  const root = realDataDir(dataDir)
  const dir = join(root, ...name.split('/'))
  let st
  try {
    st = lstatSync(dir)
  } catch {
    throw new ManageError('not-found', 404, `专题不存在：${name}`)
  }
  if (st.isSymbolicLink()) throw new ManageError('escape-rejected', 400, `路径越界：专题目录是符号链接，已拒绝：${name}`)
  if (!st.isDirectory()) throw new ManageError('not-found', 404, `专题不存在：${name}`)
  // 父链任一段是符号链接 ⇒ realpath 会解析出不同的路径 ⇒ 这里被拒（realpath + 符号链接 + assertInside 三层保留）
  const real = realpathSync(dir)
  if (real !== dir) throw new ManageError('escape-rejected', 400, `路径越界：专题目录真实路径异常，已拒绝：${name}`)
  assertInside(root, real)
  return real
}

/**
 * 解析**论文目录** `<topicDir>/<论文名>/`（方案 §B1.1 新布局）：论文名走命名/边界校验，
 * 目录必须存在、必须是真的目录（符号链接拒），且 realpath 落在库内。
 */
export function resolvePaperDirChecked(dataDir: string, topic: unknown, name: unknown, boundaryOnly: boolean): string {
  const topicPath = validateTopicPath(topic, boundaryOnly)
  const paperName = boundaryOnly ? validateEntryBoundary(name, 'paper') : validateName(name, 'paper')
  const topicDir = resolveTopicDirChecked(dataDir, topicPath, boundaryOnly)
  const dir = join(topicDir, paperName)
  let st: ReturnType<typeof lstatSync> | null = null
  try {
    st = lstatSync(dir)
  } catch {
    st = null
  }
  if (st) {
    if (st.isSymbolicLink()) throw new ManageError('escape-rejected', 400, `路径越界：论文目录是符号链接，已拒绝：${paperName}`)
    if (!st.isDirectory()) throw new ManageError('not-found', 404, `文献不存在：${paperName}.pdf`)
    const real = realpathSync(dir)
    if (real !== dir) throw new ManageError('escape-rejected', 400, `路径越界：论文目录真实路径异常，已拒绝：${paperName}`)
    assertInside(realDataDir(dataDir), real)
    return real
  }
  // 旧布局（未迁移）：平铺的 `<名>.pdf` 就在专题目录里 ⇒ 该篇的「产物目录」= 专题目录本身。
  // 确定性优先级：论文文件夹存在时永远走上面那条（文件夹赢），这里只在没有文件夹时生效。
  let pst: ReturnType<typeof lstatSync> | null = null
  try {
    pst = lstatSync(join(topicDir, paperName + '.pdf'))
  } catch {
    pst = null
  }
  if (pst && pst.isFile()) return topicDir
  throw new ManageError('not-found', 404, `文献不存在：${paperName}.pdf`)
}

/** 该篇是不是「旧布局（未迁移）」——决定删除要不要收口论文文件夹。 */
export function isLegacyPaper(topicDir: string, paperName: string): boolean {
  return !existsSync(join(topicDir, paperName)) && existsSync(join(topicDir, paperName + '.pdf'))
}

/** 写入路径用的论文目录解析（论文目录必须已由上传/迁移建好）。 */
export function resolvePaperDir(dataDir: string, topic: unknown, name: unknown): string {
  return resolvePaperDirChecked(dataDir, topic, name, false)
}

/** 删除路径用的论文目录解析（历史遗留的不规范论文名也必须能删）。 */
export function resolveExistingPaperDir(dataDir: string, topic: unknown, name: unknown): string {
  return resolvePaperDirChecked(dataDir, topic, name, true)
}

/** 某论文目录在回收站里的相对路径（保留原始相对路径，避免跨论文同名 sidecar 撞名）。 */
function trashRelFor(topicDir: string, paperDirAbs: string): string {
  const rel = relative(topicDir, paperDirAbs)
  return rel && !rel.startsWith('..') ? rel : basename(paperDirAbs)
}

/** 解析专题目录（写入路径用）：必须存在、必须是真目录（不是符号链接）、必须落在 dataDir 内。 */
export function resolveTopicDir(dataDir: string, topic: unknown): string {
  return resolveTopicDirChecked(dataDir, topic, false)
}

/** 解析**已存在**的专题目录（删除 / 改名-from 用）：只做边界类校验，历史遗留的
 *  不规范名（前导点、超长、控制字符）同样能操作，避免「删不掉的孤儿」。 */
export function resolveExistingTopicDir(dataDir: string, topic: unknown): string {
  return resolveTopicDirChecked(dataDir, topic, true)
}

// ── 产物清单（精确 stem 匹配） ────────────────────────────────────────────────

// `.study.json` = 论文伴读的学习档案（阅读计划 / 检验成绩，src/study.ts 写在文献旁边；preset 的
// study_update 工具会真的写它）。上游 v1.3.0 的 PAPER_SIDECARS 覆盖了它、release note 也写明
// 「转录 / 译文 / 学习档案连带搬家」；整合时上游实现被我们的加固版整段替换，该后缀随之丢失
// （t4 评审 F1）。少它的后果：① 改名后档案仍挂旧名 → readStudy 找不到，用户以为进度全丢；
// ② 删除时不进回收站、moved/skipped 都不报告；③ 残留条目既不是文献也不是专题，任何 API 都
// 清不掉，永久阻塞删专题（409 topic-not-empty）。本次归位：改名连带、删除移入回收站。
export const PAPER_STEM_SUFFIXES = ['.pdf', '.txt', '.pages.json', '.transcript.json', '.mineru.md', '.mineru.json', '.embeddings.json', '.study.json'] as const
export const PDF2ZH_VARIANT_SUFFIXES = ['-en', '-zh', '-dual'] as const
/** atomicTempPath(): `${path}.tmp-${pid}-${uuid.slice(0,8)}`（src/transcribe.ts）。 */
const TMP_RE = /\.tmp-\d+-[0-9a-f]{8}$/

export type ArtifactKind = 'pdf' | 'cache' | 'mineru' | 'embed' | 'study' | 'variant' | 'tmp'

export interface ManagedFile {
  /** 文件名（不含目录） */
  name: string
  kind: ArtifactKind
  bytes: number
  /** 是否为符号链接（是则只移动链接本身） */
  symlink: boolean
}

/**
 * 精确匹配：`<paperName><已知后缀>` 或 `<paperName>-en|-zh|-dual.pdf` 或上述 + `.tmp-…`。
 * 刻意**不用** startsWith —— 删 `Attention` 绝不能连带删 `Attention Is All You Need.pdf`。
 */
export function matchArtifactName(paperName: string, entry: string): boolean {
  let base = entry
  const m = TMP_RE.exec(entry)
  if (m) base = entry.slice(0, m.index)
  for (const s of PAPER_STEM_SUFFIXES) if (base === paperName + s) return true
  for (const v of PDF2ZH_VARIANT_SUFFIXES) if (base === paperName + v + '.pdf') return true
  return false
}

function kindOf(paperName: string, entry: string): ArtifactKind {
  const isTmp = TMP_RE.test(entry)
  let base = entry
  if (isTmp) base = entry.slice(0, TMP_RE.exec(entry)!.index)
  if (base === paperName + '.pdf') return isTmp ? 'tmp' : 'pdf'
  for (const v of PDF2ZH_VARIANT_SUFFIXES) if (base === paperName + v + '.pdf') return isTmp ? 'tmp' : 'variant'
  if (base === paperName + '.mineru.json' || base === paperName + '.mineru.md') return isTmp ? 'tmp' : 'mineru'
  if (base === paperName + '.embeddings.json') return isTmp ? 'tmp' : 'embed'
  if (base === paperName + '.study.json') return isTmp ? 'tmp' : 'study'
  return isTmp ? 'tmp' : 'cache'
}

/** 枚举某文献在专题目录里的产物（只看文件；目录一律忽略）。 */
export function listArtifacts(topicDir: string, paperName: string): ManagedFile[] {
  const out: ManagedFile[] = []
  for (const e of readdirSync(topicDir, { withFileTypes: true })) {
    if (e.isDirectory()) continue
    if (!matchArtifactName(paperName, e.name)) continue
    const p = join(topicDir, e.name)
    let st
    try {
      st = lstatSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) continue
    out.push({ name: e.name, kind: kindOf(paperName, e.name), bytes: st.size, symlink: st.isSymbolicLink() })
  }
  // 阅读序稳定输出：先变体/缓存，`.pdf` 最后（删除与重命名都靠这个顺序；study 也要排在 .pdf 前）
  const order: ArtifactKind[] = ['variant', 'mineru', 'embed', 'study', 'cache', 'tmp', 'pdf']
  return out.sort((a, b) => (order.indexOf(a.kind) - order.indexOf(b.kind)) || a.name.localeCompare(b.name))
}

/** 校验每个目标文件都不越界（符号链接只校验链接自身所在目录）。 */
export function assertArtifactsContained(dataDir: string, topicDir: string, files: ManagedFile[]): void {
  const root = realDataDir(dataDir)
  const realTopic = realpathSync(topicDir)
  if (realTopic !== resolve(topicDir)) throw new ManageError('escape-rejected', 400, '专题目录真实路径异常，已拒绝')
  assertInside(root, realTopic)
  for (const f of files) {
    const p = join(topicDir, f.name)
    if (basename(p) !== f.name || dirname(p) !== topicDir) {
      throw new ManageError('escape-rejected', 400, `文件名非法：${f.name}`)
    }
    if (!f.symlink) {
      // 普通文件：再确认一次真实路径仍在库内（防守硬链接/替换竞态）
      let real: string
      try {
        real = realpathSync(p)
      } catch {
        continue
      }
      assertInside(root, real)
    }
    // 符号链接：只移动链接本身，绝不对 readlink 目标动手 —— 不跟随即安全
  }
}

// ── 回收站 ──────────────────────────────────────────────────────────────────

export interface TrashResult {
  /** 相对 dataDir 的回收站目录（UI 展示用，不含机器上的绝对路径） */
  trashRel: string
  /**
   * 回收站的**绝对路径** —— 冻结契约（docs/reader-ux-requirements.md §2）里的 trashDir 字段。
   * S15 口径（「响应不泄露服务端路径」）的边界在这里：**错误响应**一律不含绝对路径
   * （文案脱敏，见 host 的 stripAbsPaths），而这个**成功响应**里的字段是刻意保留的
   * 「恢复线索」——用户/脚本据此直接去回收站把文件移回来（t4 评审 O4）。
   */
  trashDir: string
  moved: string[]
}

function trashStamp(): string {
  const d = new Date()
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
}

/**
 * 准备一个回收站目录。**失败也要有机器可读 code**（t3-F1 / R4-F1）：
 * 以前 mkdir 的原生错误会冒泡到 host 的外层兜底 → 500 无 code，且 `EACCES: … '/abs/path'`
 * 直接把 dataDir 的绝对路径写进响应体（违反本模块自述的 S15）。这里统一转成 ManageError，
 * 文案只描述现象，绝对路径只出现在 `trashRel`（相对 dataDir，UI 展示用）。
 */
export function newTrashBundle(dataDir: string): { abs: string; rel: string } {
  const root = realDataDir(dataDir)
  const rel = join('.trash', `${trashStamp()}-${randomBytes(3).toString('hex')}`)
  const abs = join(root, rel)
  try {
    mkdirSync(abs, { recursive: true, mode: 0o700 })
  } catch (err) {
    throw new ManageError('trash-move-failed', 500, '无法准备回收站目录，已取消删除（未删除任何文件；请检查文献库目录是否可写）', {
      trashRel: rel,
      cause: (err as NodeJS.ErrnoException).code ?? 'unknown',
    })
  }
  return { abs, rel }
}

/** 可注入的 rename 实现（仅测试用）：EBUSY/EPERM 在 Linux 上造不出来，注入是跨平台可验证的唯一办法。 */
export type RenameImpl = (from: string, to: string) => void

/**
 * 移入回收站失败时的**结构化真相**（字段都会进**错误**响应体，绝不静默）：
 * `moved` 是「回滚后**仍留在回收站**」的文件；回滚成功的文件已回到原处，因此不计入 moved 而计入
 * `rolledBack`；`remaining` 是「回滚后不在回收站」的文件（从未移动 + 已回滚）。`rollbackFailed`
 * 非空时文案必须降级成「部分文件未能回滚，请到回收站手动恢复」——把散落状态如实说清楚，不粉饰。
 *
 * **不变量（F-G）**：错误响应体只带**相对**的 `trashRel`（+ 文件名），**绝不带绝对路径**；
 * 绝对 `trashDir` 只出现在 200 成功响应里（O4 裁定：成功响应里那是刻意的恢复线索，错误响应一律脱敏）。
 */
export interface MoveFailure {
  /** 命中 EBUSY/EPERM 的文件名（其它 errno 时缺省） */
  [key: string]: unknown
  busy?: string
  moved: string[]
  remaining: string[]
  rolledBack: string[]
  rollbackFailed: string[]
  trashRel: string
  cause: string
}

/**
 * 把一批文件移入回收站。失败时**不**回退 unlink，而是：
 *   ① 先做**反向回滚**——把本次已 rename 进回收站的文件 rename 回原位（rename，不是 unlink；
 *      契约禁的是「删失败就退回真删」，回滚不违反它），让「失败 = 库没变」成为默认结果；
 *   ② 再按 errno 分类：EBUSY/EPERM（Windows 文件占用）→ 409 `file-busy` 可执行文案；
 *      其它 errno → 500 `trash-move-failed`。两种情况都带 `MoveFailure` 全量字段。
 * 回滚本身也可能失败（例如目标同时被占用）：此时**不静默**——失败的文件仍在回收站里（可恢复），
 * 如实列进 `rollbackFailed` 并给**相对**的 `trashRel`，文案降级为「未能回滚，请到回收站手动恢复」。
 */
export function moveToTrash(
  bundle: { abs: string; rel: string },
  topicDir: string,
  files: ManagedFile[],
  renameImpl: RenameImpl = renameSync,
): TrashResult {
  const moved: string[] = []
  for (const f of files) {
    const from = join(topicDir, f.name)
    try {
      renameImpl(from, join(bundle.abs, f.name))
      moved.push(f.name)
    } catch (err) {
      const cause = (err as NodeJS.ErrnoException).code ?? 'unknown'
      const busy = cause === 'EBUSY' || cause === 'EPERM'
      // ① 反向回滚（best-effort，最近移动的先回；rename 回去，绝不 unlink）
      const rolledBack: string[] = []
      const rollbackFailed: string[] = []
      for (const name of [...moved].reverse()) {
        try {
          renameImpl(join(bundle.abs, name), join(topicDir, name))
          rolledBack.push(name)
        } catch {
          rollbackFailed.push(name)
        }
      }
      // R-3：回滚干净时把本次创建的回收站目录 best-effort 清掉（与 clearTopic 的做法对齐），
      // 不给用户留一个空的「回收站记录」；清不掉（非空/权限等）也不影响错误上报。
      if (rollbackFailed.length === 0) {
        try { rmdirSync(bundle.abs) } catch { /* 非空或权限问题：留着无害 */ }
      }
      const inTrash = files.filter((x) => rollbackFailed.includes(x.name)).map((x) => x.name)
      const remaining = files.filter((x) => !inTrash.includes(x.name)).map((x) => x.name)
      const failure: MoveFailure = {
        ...(busy ? { busy: f.name } : {}),
        moved: inTrash,
        remaining,
        rolledBack,
        rollbackFailed,
        // F-G：只给相对路径——错误响应永不带服务端绝对路径
        trashRel: bundle.rel,
        cause,
      }
      const tail = rollbackFailed.length === 0
        ? '本次操作已全部撤销，文献库未改变'
        : `但 ${rollbackFailed.length} 个文件未能回滚（仍在回收站，可手动恢复）：${rollbackFailed.join('、')}`
      if (busy) {
        throw new ManageError('file-busy', 409,
          `文件被占用（可能正在阅读器或其他程序中打开），关闭后重试；${tail}`, failure)
      }
      throw new ManageError('trash-move-failed', 500, `移入回收站失败；${tail}`, failure)
    }
  }
  return { trashRel: bundle.rel, trashDir: bundle.abs, moved }
}

// ── 删除文献 ────────────────────────────────────────────────────────────────

/**
 * 「论文夹 + 同 stem 平铺残留」混合态检测（t4 评审 F2，修复口径 (a)：拒绝并提示先迁移）。
 *
 * 这是**迁移冲突之后**的真实库形态：论文夹 `<topic>/<名>/` 已存在，同时专题目录里还留着旧的
 * 平铺产物（`<名>.pdf` / `<名>.txt` / `<名>-zh.pdf` …）。`listPapers` 的确定性优先级是「论文夹赢」，
 * 所以平铺那半是**不可见的第二身份**：
 *   · delete 只删论文夹 ⇒ 该篇立刻以 legacy 身份重新出现（"删了还在"）；
 *   · rename 只改论文夹 ⇒ 旧名以 legacy 身份继续出现在库里（一个名字两篇）；
 *   · move 只搬论文夹 ⇒ 同一篇同时出现在源专题（legacy）与目标专题（重复身份）。
 * 三种都曾返回 `ok:true`。取向与 `move_paper` 拒绝旧布局一致：**让用户在界面把迁移做完**，
 * 而不是在对话侧替他做半篇迁移（docs/migrate-prompt-plan.md 红线）。
 *
 * 只读；纯函数；不碰盘。
 */
export function assertNoLayoutConflict(topicDir: string, paperName: string): void {
  // 没有论文夹 ⇒ 纯旧布局，交给既有 legacy 分支（delete/rename 允许，move 拒绝）
  if (!existsSync(join(topicDir, paperName))) return
  // 论文夹存在时，专题目录里不该再有同 stem 的平铺产物；有就是混合态
  const flat = listArtifacts(topicDir, paperName)
  if (flat.length === 0) return
  throw new ManageError('layout-conflict', 409,
    `该文献同时存在论文文件夹与旧平铺文件（${flat.map((f) => f.name).join('、')}），请先在界面完成迁移后再操作`, {
      files: flat.map((f) => f.name),
      hint: '设置 → 论文伴读 → 查看论文状态（读完警示后点一次「确认迁移」）',
    })
}

export interface PaperDeletePlan {
  topic: string
  name: string
  /** 论文目录相对 dataDir 的路径（`专题路径/论文名`）——迁移/回收站线索 */
  dirRel: string
  /** `folder` = 新布局（论文文件夹）；`legacy` = 旧布局（产物平铺在专题目录里，未迁移） */
  layout: 'folder' | 'legacy'
  files: ManagedFile[]
  totalBytes: number
  /** 回收站根（相对 dataDir）——UI 只需要这个 */
  trashRoot: string
  notDeleted: string[]
}

export function planPaperDelete(dataDir: string, topic: unknown, name: unknown): PaperDeletePlan {
  // 词法层统一走**边界类**（PR-1 的既定分层，t4 评审 [2] 的裁定）：删除/rename-from 只挡
  // 空/分隔符/`..`/NUL/保留名 `.trash`，**不**挡命名规范（前导点、超长、控制字符）。
  // 理由（实测为真）：listPapers 不过滤隐藏文件 → 手工放进库的 `.hidden.pdf` 会出现在列表里
  // 却删不掉；pdfqa 旧库与手工整理都会产生这类条目。命名规范只在**创建 / 改名-to** 时强制
  // （validateName / validateNewPaperName），即「能创建的必然能删除」。
  // realpath 层由 resolveExistingTopicDir / assertArtifactsContained 兜底（与词法层无关）。
  const paperName = validateEntryBoundary(name, 'paper')
  const topicName = validateTopicPath(topic, true)
  const topicDirAbs = resolveExistingTopicDir(dataDir, topicName)
  // 混合态先拒（t4-F2）：论文夹 + 同 stem 平铺残留 ⇒ layout-conflict，不做「半篇」操作
  assertNoLayoutConflict(topicDirAbs, paperName)
  // 布局判定（确定性优先级：论文文件夹存在 ⇒ folder；否则只有平铺 `<名>.pdf` ⇒ legacy）
  const layout: 'folder' | 'legacy' = isLegacyPaper(topicDirAbs, paperName) ? 'legacy' : 'folder'
  const paperDirAbs = resolveExistingPaperDir(dataDir, topicName, paperName)
  const files = listArtifacts(paperDirAbs, paperName)
  assertArtifactsContained(dataDir, paperDirAbs, files)
  // `.pdf` 必须是**常规文件**：符号链接不是文献（listPapers 只看常规文件，故 resolvePaper 找不到它，
  // 以前会以「文献库中找不到」的普通 Error 冒泡成 500）。这里判 404，与「合法名 + 不存在文献」一致。
  if (!files.some((f) => f.kind === 'pdf' && !f.symlink)) {
    throw new ManageError('not-found', 404, `文献不存在：${paperName}.pdf`)
  }
  return {
    topic: topicName,
    name: paperName,
    dirRel: layout === 'legacy' ? topicName : `${topicName}/${paperName}`,
    layout,
    files,
    totalBytes: files.reduce((n, f) => n + f.bytes, 0),
    trashRoot: '.trash',
    notDeleted: [
      // 明确「会话历史不删、学习档案文件会随文献进回收站」——原文案只说「会话历史不删」，
      // 用户会以为学习进度（<文献>.study.json）也留着；实际它是派生产物，和 .txt/译文一样被移走（可恢复）。
      '伴读会话历史（保存在 dsh 会话库里，不随文献删除；学习档案文件 <文献>.study.json 随文献移入回收站，可在回收站恢复）',
      '共享翻译环境（.venv-pdf2zh）与翻译草稿目录（.pdf2zh-tmp）',
      '专题目录本身（如需删除专题请另行操作）',
    ],
  }
}

export interface PaperDeleteResult {
  ok: true
  topic: string
  name: string
  moved: string[]
  skipped: ManagedFile[]
  trashDir: string
  trashRel: string
  /** 论文目录是否已被（非递归）rmdir 掉；false = 目录里还有我们不认识的条目，已如实保留 */
  dirRemoved: boolean
}

export function deletePaper(dataDir: string, topic: unknown, name: unknown, renameImpl?: RenameImpl): PaperDeleteResult {
  const plan = planPaperDelete(dataDir, topic, name)
  const paperDirAbs = resolveExistingPaperDir(dataDir, plan.topic, plan.name)
  const bundle = newTrashBundle(dataDir)
  // 隐藏条目（.DS_Store 等）也一并进回收站，否则论文目录 rmdir 不掉、会挡住「删专题」。
  // 顺序：隐藏条目在前、产物在后 ⇒ `.pdf` 仍然是**最后**被移走的（既有不变量）。
  // 隐藏条目收口只对**新布局的论文文件夹**做（旧布局的专题目录里藏着别人的文件，不能顺手动）
  // 去重：论文名以 `.` 开头时，`.hidden.pdf` 既匹配产物清单、又匹配「隐藏条目」谓词，
  // 重复 rename 的第二次必然是 ENOENT（实测把一次正常删除变成 500 回滚）。产物清单一律优先。
  const artifactNames = new Set(plan.files.map((f) => f.name))
  const hidden = plan.layout === 'folder'
    ? managedEntries(paperDirAbs, (n) => n.startsWith('.') && !artifactNames.has(n))
    : []
  // F3：回收站里保留**论文名层级**（`<bundle>/<论文名>/<文件>`），与 clearTopic 的
  // `<bundle>/<论文标签>/<文件>` 口径一致 —— 用户/脚本按「原相对路径」就能找到并恢复。
  const sub = { abs: join(bundle.abs, plan.name), rel: join(bundle.rel, plan.name) }
  mkdirSync(sub.abs, { recursive: true, mode: 0o700 })
  let res
  try {
    res = moveToTrash(sub, paperDirAbs, [...hidden, ...plan.files], renameImpl)
  } catch (err) {
    // 干净回滚时把空的回收站记录收掉（与改造前口径一致：失败的删除不留空 bundle）
    try { rmSync(join(sub.abs, 'manifest.json'), { force: true }); rmdirSync(sub.abs) } catch { /* 非空/权限：留着无害 */ }
    try { rmdirSync(bundle.abs) } catch { /* 还有别的东西：留着无害 */ }
    throw err
  }
  // 论文目录整体收口：非递归 rmdir（绝无 rm -rf）。目录里若还有我们不认识的条目，
  // 就如实保留（`dirRemoved:false`），绝不为了「删干净」去递归删除。
  let dirRemoved = false
  if (plan.layout === 'folder') {
    try {
      rmdirSync(paperDirAbs)
      dirRemoved = true
    } catch { /* 目录仍非空（用户自放内容）→ 保留，如实回报 */ }
  }
  const manifest = {
    v: 1,
    kind: 'paper',
    topic: plan.topic,
    name: plan.name,
    /** 原论文目录（相对 dataDir）——回收站恢复时的原始位置线索 */
    relativeDir: plan.dirRel,
    /** 本条目在回收站内的子目录（恢复时把这里的文件搬回 relativeDir） */
    trashSubdir: plan.name,
    deletedAt: new Date().toISOString(),
    files: plan.files.map((f) => ({ name: f.name, kind: f.kind, bytes: f.bytes, symlink: f.symlink })),
  }
  writeManifest(sub.abs, manifest)     // 论文层级：就近的恢复线索
  writeManifest(bundle.abs, manifest)  // bundle 根：既有调用方/断言读它
  return {
    ok: true,
    topic: plan.topic,
    name: plan.name,
    moved: res.moved,
    skipped: plan.files.filter((f) => !res.moved.includes(f.name)),
    // 响应里的回收站线索是**bundle 根**（manifest.json 与论文名子目录所在处），
    // 不是论文名子目录本身 —— 用户按它进回收站能一眼看到「哪篇、有哪些文件」。
    trashDir: bundle.abs,
    trashRel: bundle.rel,
    dirRemoved,
  }
}

/** 枚举目录里满足谓词的条目（文件/符号链接；目录跳过），供隐藏条目收口用。 */
function managedEntries(dir: string, accept: (name: string) => boolean): ManagedFile[] {
  const out: ManagedFile[] = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (!accept(e.name)) continue
    let bytes = 0
    let symlink = false
    // 目录**也要**收口：隐藏目录（.git/.DS_Store 所在目录）不收走就 rmdir 不掉专题，
    // 而 rmdir 非递归的不变量不允许我们递归删除它。rename 对目录同样成立。
    try {
      const st = lstatSync(join(dir, e.name))
      bytes = st.size
      symlink = st.isSymbolicLink()
    } catch { /* 竞态：已消失 */ }
    out.push({ name: e.name, kind: 'tmp', bytes, symlink })
  }
  return out
}

function writeManifest(bundleAbs: string, manifest: Record<string, unknown>): void {
  try {
    writeFileSync(join(bundleAbs, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  } catch {
    // manifest 只是给人看的恢复线索；写不了不影响删除结果
  }
}

// ── 删除专题 ────────────────────────────────────────────────────────────────

export interface TopicDeletePlan {
  name: string
  /** 非隐藏条目（>0 ⇒ 拒绝删除） */
  entries: string[]
  /** 本层的论文（新布局的论文目录名；旧布局未迁移的平铺 `<名>.pdf` 也算，仅用于报告） */
  papers: string[]
  /** 本层的**子专题**目录名（非论文目录的子目录） */
  subtopics: string[]
  /** 隐藏条目（.DS_Store 等）：不阻塞删除，但也不销毁 → 一并进回收站 */
  hidden: string[]
}

export function planTopicDelete(dataDir: string, name: unknown): TopicDeletePlan {
  // 删除专题同样只做边界类校验（逐段）：隐藏名专题（历史遗留）必须能删，否则是删不掉的孤儿。
  const topic = validateTopicPath(name, true)
  const topicDir = resolveExistingTopicDir(dataDir, topic)
  const all = readdirSync(topicDir, { withFileTypes: true })
  const visible = all.filter((e) => !e.name.startsWith('.'))
  const dirs = visible.filter((e) => e.isDirectory())
  const papers = [
    ...dirs.filter((e) => isPaperDir(join(topicDir, e.name))).map((e) => e.name),
    // 旧布局（未迁移）的平铺 `<名>.pdf`：仍然算「本层有一篇文献」，但不双读（运行期不认它的产物）
    ...visible.filter((e) => e.isFile() && isPaperPDF(e.name)).map((e) => e.name.slice(0, -4)),
  ]
  return {
    name: topic,
    entries: visible.map((e) => e.name),
    papers,
    subtopics: dirs.filter((e) => !isPaperDir(join(topicDir, e.name))).map((e) => e.name),
    hidden: all.filter((e) => e.name.startsWith('.')).map((e) => e.name),
  }
}

export interface TopicDeleteResult {
  ok: true
  name: string
  movedHidden: string[]
  trashDir: string | null
  trashRel: string | null
}

export function deleteTopic(dataDir: string, name: unknown, renameImpl?: RenameImpl): TopicDeleteResult {
  const plan = planTopicDelete(dataDir, name)
  if (plan.entries.length > 0) {
    throw new ManageError('topic-not-empty', 409, `专题内还有 ${plan.entries.length} 个条目（${plan.papers.length} 篇文献），请先逐篇删除`, {
      entries: plan.entries,
      papers: plan.papers,
      // 子专题单列：非空子树要走「清空」中间态（方案 §B2.2），UI 据 subtopics 提示影响面
      subtopics: plan.subtopics,
    })
  }
  const topicDir = resolveExistingTopicDir(dataDir, plan.name)
  let movedHidden: string[] = []
  let trashDir: string | null = null
  let trashRel: string | null = null
  if (plan.hidden.length > 0) {
    // 隐藏条目（.DS_Store 等）不阻塞删除，但也绝不静默销毁 → 进回收站后再 rmdir
    const files: ManagedFile[] = plan.hidden.map((h) => {
      let bytes = 0
      let symlink = false
      try {
        const st = lstatSync(join(topicDir, h))
        bytes = st.size
        symlink = st.isSymbolicLink()
      } catch { /* 竞态：已消失 */ }
      return { name: h, kind: 'tmp', bytes, symlink }
    })
    const bundle = newTrashBundle(dataDir)
    const res = moveToTrash(bundle, topicDir, files, renameImpl)
    movedHidden = res.moved
    trashDir = res.trashDir
    trashRel = res.trashRel
    writeManifest(bundle.abs, { v: 1, kind: 'topic-hidden', topic: plan.name, deletedAt: new Date().toISOString(), files })
  }
  try {
    rmdirSync(topicDir) // 非递归：非空即失败，绝不 rm -rf
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // 只有「目录非空」才是 topic-not-empty；EACCES/EBUSY 等 errno 如实上交，
    // 由 host 的错误通道给固定文案（上游 R1 ②：errno 不回显绝对路径、不谎报原因）。
    if (typeof code === 'string' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw err
    throw new ManageError('topic-not-empty', 409, '专题目录仍非空，未删除', {
      entries: readdirSync(topicDir),
      movedHidden,
      // F-G：错误响应不带绝对路径（绝对 trashDir 只留给 200 成功响应）
      trashRel,
      cause: (err as NodeJS.ErrnoException).code ?? 'unknown',
    })
  }
  return { ok: true, name: plan.name, movedHidden, trashDir, trashRel }
}

// ── 批量清空专题（上游评论第 10 条：非空专题删除的中间态）─────────────────────
// 产品决策（上游已定）：30 篇论文的专题 = 30 次删除确认太重。清空 = **一次确认**，逐篇走
// **同一套**回收站语义（精确 stem、`.pdf` 最后移、绝不 unlink）、仍受会话/翻译前置 409 约束。
// 本轮起 UI 不再要求手输专题名：改为「可见警示 + 点一次确认」；服务端仍比对 confirmName
//（由点击携带，接口与确认强度不放松）。

export interface TopicClearPaperPlan {
  name: string
  /** 该论文所在专题单元的路径（相对 dataDir）——子树清空时逐篇定位用 */
  topic: string
  /** `legacy` = 旧布局（产物平铺在专题目录里，未迁移）：源目录是专题目录本身、没有论文文件夹要收口 */
  legacy?: boolean
  /** 论文目录相对**所在专题单元**的路径（叶子专题里就是论文名）——回收站内保留原始相对路径用 */
  rel: string
  files: ManagedFile[]
  totalBytes: number
}

/**
 * 一个「清空单元」= 一棵子树里的一个专题目录（方案 §B2.2：把每个子专题当成独立清空单元）。
 * 叶子专题的单元里 `subtopics` 为空、`papers` 就是本层的文献 ⇒ 与既有返回体形状一致。
 */
export interface TopicClearUnit {
  /** 相对 dataDir 的专题路径（`A/B`） */
  topic: string
  /** 相对**本次清空的根专题**的路径（根 = ''）——回收站条目标签用 */
  rel: string
  /** 本层（不含子专题）的文献清单 */
  papers: TopicClearPaperPlan[]
  /** 本棵子树（含自己）的篇数/文件数/字节数 */
  papersCount: number
  filesCount: number
  totalBytes: number
  /** 本层隐藏条目（.DS_Store 等）：不阻塞清空，但也不销毁 → 一并进回收站 */
  hidden: string[]
  /** 本层的子专题单元 */
  subtopics: TopicClearUnit[]
}

export interface TopicClearPlan extends TopicClearUnit {
  trashRoot: string
  notDeleted: string[]
}

/** 递归规划一个清空单元（只读，不写盘）。论文目录**不递归**（结构不变量）。 */
function planClearUnit(dataDir: string, topicPath: string, rel: string): TopicClearUnit {
  const topicDir = resolveExistingTopicDir(dataDir, topicPath)
  const all = readdirSync(topicDir, { withFileTypes: true })
  const visible = all.filter((e) => !e.name.startsWith('.'))
  const papers: TopicClearPaperPlan[] = []
  const subtopics: TopicClearUnit[] = []
  for (const e of visible) {
    if (!e.isDirectory()) continue
    const childAbs = join(topicDir, e.name)
    if (isPaperDir(childAbs)) {
      const files = listArtifacts(childAbs, e.name)
      assertArtifactsContained(dataDir, childAbs, files)
      // 与 planPaperDelete 同口径：`.pdf` 必须是常规文件（符号链接不是文献）
      if (!files.some((f) => f.kind === 'pdf' && !f.symlink)) continue
      papers.push({ name: e.name, topic: topicPath, rel: e.name, files, totalBytes: files.reduce((n, f) => n + f.bytes, 0) })
    } else {
      subtopics.push(planClearUnit(dataDir, `${topicPath}/${e.name}`, rel ? `${rel}/${e.name}` : e.name))
    }
  }
  // 旧布局（未迁移）的平铺论文：同一层的 `<名>.pdf`（同名文件夹存在时文件夹赢）
  for (const e of visible) {
    if (!e.isFile() || !isPaperPDF(e.name)) continue
    const stem = e.name.slice(0, -4)
    if (existsSync(join(topicDir, stem))) continue
    const files = listArtifacts(topicDir, stem)
    assertArtifactsContained(dataDir, topicDir, files)
    if (!files.some((f) => f.kind === 'pdf' && !f.symlink)) continue
    papers.push({ name: stem, topic: topicPath, rel: stem, legacy: true, files, totalBytes: files.reduce((n, f) => n + f.bytes, 0) })
  }
  const childPapers = subtopics.reduce((n, s) => n + s.papersCount, 0)
  const childFiles = subtopics.reduce((n, s) => n + s.filesCount, 0)
  const childBytes = subtopics.reduce((n, s) => n + s.totalBytes, 0)
  return {
    topic: topicPath,
    rel,
    papers,
    papersCount: papers.length + childPapers,
    filesCount: papers.reduce((n, p) => n + p.files.length, 0) + childFiles,
    totalBytes: papers.reduce((n, p) => n + p.totalBytes, 0) + childBytes,
    hidden: all.filter((e) => e.name.startsWith('.')).map((e) => e.name),
    subtopics,
  }
}

/** 清空预览（dry-run，只读）：逐篇列出将移入回收站的产物（含整棵子树）；不写盘。 */
export function planTopicClear(dataDir: string, topic: unknown): TopicClearPlan {
  const topicName = validateTopicPath(topic, true)
  const unit = planClearUnit(dataDir, topicName, '')
  return {
    ...unit,
    trashRoot: TRASH_DIR,
    notDeleted: [
      '伴读会话历史（保存在 dsh 会话库里，不随文献清空；学习档案文件 <文献>.study.json 属派生产物，随文献移入回收站，可在回收站恢复）',
      '共享翻译环境（.venv-pdf2zh）与翻译草稿目录（.pdf2zh-tmp）',
      '库外文件（清空只作用于该专题目录内）',
    ],
  }
}

export interface TopicClearResult {
  ok: true
  topic: string
  /** 实际清空的篇数 */
  cleared: number
  /** 实际移入回收站的文件数 */
  movedFiles: number
  /** 一并移入回收站的隐藏条目 */
  movedHidden: string[]
  trashDir: string
  trashRel: string
  /** 本次连带清掉的**子专题**数（叶子专题为 0） */
  subtopicsCleared: number
}

/**
 * 清空专题（含整棵子树）：**后序遍历**，每个专题单元一个独立 `.trash` bundle，每篇论文一个子目录
 * `<bundle>/<论文名>/<文件>`（避免同名产物跨篇撞名），每篇一份 manifest + 单元根一份清单；
 * 单元内全部移完后把隐藏条目移入 bundle 根，最后对每个单元**非递归** `rmdir`（绝无 rm -rf）。
 *
 * 原子性口径（**不是文件系统事务，是「失败即回滚」**）：
 *   ① 任何时候都不会 unlink 用户数据（只有我们自己的 manifest 会被清掉）；
 *   ② 任一步失败 → 先把**本次请求已移动的全部文件**（含已完成篇）rename 回原位（best-effort）；
 *   ③ 回滚失败的文件如实列进 `rollbackFailed`，且**一定**在回收站里（给 trashDir/trashRel 供手动恢复）。
 *
 * 标签口径（与叶子专题时代**逐字兼容**）：一篇论文的标签 = 它相对**本次清空根专题**的路径
 * （叶子专题里就是论文名），文件标签 = `<论文标签>/<文件名>`（叶子专题里就是 `P/P.pdf`）。
 */
export function clearTopic(dataDir: string, topic: unknown, renameImpl: RenameImpl = renameSync): TopicClearResult {
  const plan = planTopicClear(dataDir, topic)
  // 空专题不属于「清空」的职责（删除专题才是）——把两件事分开，避免留下一个空目录
  if (plan.papersCount === 0) {
    throw new ManageError('bad-request', 400, '专题已为空，请用删除专题', { clearEndpoint: '/api/library/delete-topic' })
  }
  /** 后序遍历（子专题先于父专题）——自底向上清，父目录最后才可能空出来。 */
  const postOrder = (unit: TopicClearUnit): TopicClearUnit[] => [
    ...unit.subtopics.flatMap(postOrder),
    unit,
  ]
  const units = postOrder(plan)
  const planOrder = units.flatMap((u) => u.papers.map((p) => (u.rel ? `${u.rel}/${p.rel}` : p.rel)))
  const stamp = new Date().toISOString()
  /** 已移动的文件（扁平记账，回滚按倒序搬回原位）。 */
  const moved: Array<{ fromAbs: string; toAbs: string; label: string; paperLabel: string; bundleAbs: string; bundleRel: string }> = []
  /** 已完成的论文标签（失败前）——审计字段 `clearedBeforeRollback`。 */
  const donePapers: string[] = []
  const doneBundles: Array<{ abs: string; rel: string; subs: string[] }> = []
  const movedHiddenAll: string[] = []
  let failedPaper = ''
  let currentBundle: { abs: string; rel: string } = { abs: '', rel: '' }
  try {
    for (const unit of units) {
      const topicDir = resolveExistingTopicDir(dataDir, unit.topic)
      const bundle = newTrashBundle(dataDir)
      currentBundle = bundle
      const rec = { abs: bundle.abs, rel: bundle.rel, subs: [] as string[] }
      doneBundles.push(rec)
      for (const p of unit.papers) {
        const label = unit.rel ? `${unit.rel}/${p.rel}` : p.rel
        failedPaper = label
        // 旧布局：产物就平铺在专题目录里，源目录 = 专题目录；新布局：源目录 = 论文文件夹
        const paperDirAbs = p.legacy ? topicDir : join(topicDir, p.rel)
        const subAbs = join(bundle.abs, p.rel)
        mkdirSync(subAbs, { recursive: true, mode: 0o700 })
        rec.subs.push(subAbs)
        // 论文目录内的隐藏条目也一并收口（否则论文目录 rmdir 不掉）；顺序：隐藏在前 ⇒ `.pdf` 仍最后移。
        // 旧布局是**专题目录**，里面的隐藏条目不属于这一篇 —— 不顺手动（否则会搬走别人的东西）。
        const artifactNames = new Set(p.files.map((f) => f.name))
        const files = [...(p.legacy ? [] : managedEntries(paperDirAbs, (n) => n.startsWith('.') && !artifactNames.has(n))), ...p.files]
        const res = moveToTrash({ abs: subAbs, rel: join(bundle.rel, p.rel) }, paperDirAbs, files, renameImpl)
        for (const name of res.moved) {
          moved.push({
            fromAbs: join(subAbs, name), toAbs: join(paperDirAbs, name),
            label: `${label}/${name}`, paperLabel: label, bundleAbs: bundle.abs, bundleRel: bundle.rel,
          })
        }
        donePapers.push(label)
        if (!p.legacy) { try { rmdirSync(paperDirAbs) } catch { /* 还有我们不认识的条目 → 保留，最终 rmdir 会如实报 topic-not-empty */ } }
        writeManifest(subAbs, {
          v: 1, kind: 'paper', topic: unit.topic, name: p.name, relativeDir: `${unit.topic}/${p.name}`,
          deletedAt: stamp,
          files: p.files.map((f) => ({ name: f.name, kind: f.kind, bytes: f.bytes, symlink: f.symlink })),
        })
      }
      // 隐藏条目：全部文献移完后进**单元**的 bundle 根（隐藏名以 `.` 开头，不会与篇名子目录撞名）
      if (unit.hidden.length > 0) {
        failedPaper = unit.rel ? `${unit.rel}/.hidden` : '.hidden'
        const files: ManagedFile[] = managedEntries(topicDir, (n) => n.startsWith('.'))
        const res = moveToTrash(bundle, topicDir, files, renameImpl)
        for (const name of res.moved) {
          moved.push({
            fromAbs: join(bundle.abs, name), toAbs: join(topicDir, name),
            label: `${unit.rel ? unit.rel + '/' : ''}${name}`, paperLabel: unit.rel || '.hidden',
            bundleAbs: bundle.abs, bundleRel: bundle.rel,
          })
        }
        movedHiddenAll.push(...res.moved)
      }
      writeManifest(bundle.abs, {
        v: 1, kind: unit.rel ? 'subtree-clear' : 'topic-clear', topic: unit.topic, deletedAt: stamp,
        papers: unit.papers.map((p) => ({ name: p.name, rel: p.rel, files: p.files.map((f) => f.name) })),
        subtopics: unit.subtopics.map((s) => s.topic),
        hidden: unit.hidden,
      })
      failedPaper = ''
      // 后序 ⇒ 子专题此刻已被清空并 rmdir，本层也该空了
      try {
        rmdirSync(topicDir) // 非递归：非空即失败，绝不 rm -rf
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (typeof code === 'string' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw err
        throw new ManageError('topic-not-empty', 409, '专题目录仍非空，未删除', {
          entries: readdirSync(topicDir), cause: code, topic: unit.topic,
        })
      }
    }
    const rootBundle = doneBundles[doneBundles.length - 1]!
    return {
      ok: true, topic: plan.topic, cleared: donePapers.length,
      movedFiles: moved.length,
      movedHidden: movedHiddenAll, trashDir: rootBundle.abs, trashRel: rootBundle.rel,
      subtopicsCleared: units.length - 1,
    }
  } catch (err) {
    // ── 失败即回滚：把本次请求**已移动的全部文件**rename 回原位（含已完成篇）──
    const base = isManageError(err) ? err.extra : {}
    const rolledBack: string[] = []
    const rollbackFailed: string[] = []
    for (const m of [...moved].reverse()) {
      try {
        // ⚠️ 清空时每篇论文的文件夹会被（非递归）rmdir 收口 —— 回滚要把**父目录先建回来**，
        // 否则 rename 目标不存在（ENOENT），文件只能留在回收站里、库里看起来「白了」（实测：D6 抓到）。
        mkdirSync(dirname(m.toAbs), { recursive: true, mode: 0o700 })
        renameImpl(m.fromAbs, m.toAbs)
        rolledBack.push(m.label)
      } catch {
        rollbackFailed.push(m.label)
      }
    }
    // 回滚干净 → 把本次创建的回收站子目录/根目录（此时只剩我们自己的 manifest）清掉，
    // 不给用户留一个空的「回收站记录」；清不掉也不影响结果（best-effort，不覆盖上面的错误）。
    if (rollbackFailed.length === 0) {
      for (const b of doneBundles) {
        for (const sub of b.subs) {
          try { rmSync(join(sub, 'manifest.json'), { force: true }); rmdirSync(sub) } catch { /* 留着无害 */ }
        }
        try { rmSync(join(b.abs, 'manifest.json'), { force: true }); rmdirSync(b.abs) } catch { /* 留着无害 */ }
      }
      // R2-3（顺手，第一轮 F-E，基线同）：把**空的** `.trash` 根也收掉 —— 否则一次失败的清空会在库里
      // 留下一个空回收站目录。**非空一律不动**（那是用户可恢复的数据），rmdir 非递归天然保证这一点。
      try {
        rmdirSync(join(realDataDir(dataDir), TRASH_DIR))
      } catch { /* 非空 / 不存在 / 权限：留着无害 */ }
    }
    const failedPaperRolledBack = (Array.isArray(base.rolledBack) ? (base.rolledBack as string[]) : [])
      .map((n) => `${failedPaper || '?'}/${n}`)
    const failedPaperFailed = (Array.isArray(base.rollbackFailed) ? (base.rollbackFailed as string[]) : [])
      .map((n) => `${failedPaper || '?'}/${n}`)
    const allRollbackFailed = [...failedPaperFailed, ...rollbackFailed]
    const totalProcessed = donePapers.length + (failedPaper ? 1 : 0)
    const totalRolledBack = failedPaperRolledBack.length + rolledBack.length
    const tail = allRollbackFailed.length === 0
      ? `已处理 ${totalProcessed} 篇：本次已移动的文件已全部回滚，专题内容未改变`
      : `已处理 ${totalProcessed} 篇：${totalRolledBack} 个文件已回滚，但 ${allRollbackFailed.length} 个文件未能回滚（仍在回收站，可手动恢复）：${allRollbackFailed.join('、')}`
    // F-C：**有文件没回滚时绝不保留内层那句「…已全部撤销，文献库未改变」**——它只对失败的那一篇成立，
    // 拼到整体回滚结果上就自相矛盾。内层只保留「；」之前的可执行前缀（如「文件被占用…关闭后重试」），
    // 回滚结论一律由外层的 tail 单方面给出。
    const innerRaw = isManageError(err) ? err.message : '清空中断'
    const inner = allRollbackFailed.length === 0 ? innerRaw : (innerRaw.split('；')[0] || innerRaw)
    const message = `${inner}｜${tail}`
    // F-H：字段名要说清语义——`unprocessedPapers` 只列「这次压根没轮到」的篇；
    // 「用户数据还在回收站」的篇另给 `papersWithFilesInTrash`（回滚失败时唯一能自救的清单）。
    const unprocessedPapers = planOrder.filter((n) => !donePapers.includes(n) && n !== failedPaper)
    const papersWithFilesInTrash = [...new Set(allRollbackFailed.map((n) => n.split('/').slice(0, -1).join('/')))]
    throw new ManageError(
      isManageError(err) ? err.code : 'trash-move-failed',
      isManageError(err) ? err.status : 500,
      message,
      {
        ...base,
        // `cleared` = 本次**真正清空**（最终仍留在回收站）的篇数：失败即回滚 ⇒ 恒为 0
        cleared: 0,
        clearedBeforeRollback: donePapers,
        failedPaper: failedPaper || null,
        rolledBack: [...failedPaperRolledBack, ...rolledBack],
        rollbackFailed: allRollbackFailed,
        moved: allRollbackFailed,
        unprocessedPapers,
        papersWithFilesInTrash,
        // F-G：错误响应只给相对路径（绝对 trashDir 只留在 200 成功响应）
        trashRel: currentBundle.rel,
      },
    )
  }
}

// ── 重命名 ──────────────────────────────────────────────────────────────────

export interface RenameResult {
  ok: true
  moved: string[]
  from: string
  to: string
}

/**
 * 产物改名：**纯前缀拼接**，不能用 `String.replace(paperName, newName)`——
 * `newName` 里的 `$&` / `` $` `` / `$'` / `$1` 会被当成**替换模式**展开（t3-F2）：
 * 实测 10 个产物会得到各不相同的 stem、产生无法再按名删除的孤儿文件，且响应里的 `to`
 * 与磁盘不符。`listArtifacts` 保证 `f.name` 一定以 `paperName` 开头（精确 stem 匹配）。
 */
export function renamedName(fileName: string, paperName: string, newName: string): string {
  return fileName.startsWith(paperName) ? newName + fileName.slice(paperName.length) : fileName
}

export interface RenamePaperPlan {
  topic: string
  name: string
  newName: string
  /** `folder` = 新布局；`legacy` = 旧布局（改名 = 逐个平铺文件改名） */
  layout: 'folder' | 'legacy'
  /** 源论文夹（folder 布局）或专题目录本身（legacy 布局）的绝对路径 */
  sourceDir: string
  files: ManagedFile[]
  totalBytes: number
}

/** 目标名的 realpath 是否与「源侧同名实体」是同一个东西（大小写-only 改名的放行判据）。 */
function sameRealpath(a: string, b: string | null): boolean {
  if (!b) return false
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false // 目标不可读 → 视为冲突（与既有 renamePaper 分支同口径）
  }
}

/**
 * 改名目标的**三路冲突**判定（t4 评审 F1，修复）：与 `add_paper` / `planMovePaper` 同一口径 ——
 *   `<topicDir>/<newName>/`（论文夹）|| `<topicDir>/<newName>.pdf`（旧布局平铺）||
 *   `listArtifacts(topicDir, newName).length > 0`（孤儿 sidecar / 译文变体）
 * 任一命中 → 409 `target-exists`。
 *
 * 为什么必须查平铺与孤儿产物：`listPapers` 的优先级是「论文夹赢」，所以一次只查论文夹的改名会把
 * 一篇**既有旧布局文献从列表里静默遮蔽**（盘上还在，身份消失），而且返回成功。
 * 大小写-only 改名的既有语义逐字保留：目标目录/平铺 pdf 与源是同一实体时不算冲突。
 */
function assertRenameTargetFree(topicDir: string, paperName: string, newName: string, sourceDir: string, layout: 'folder' | 'legacy'): void {
  const targetDir = join(topicDir, newName)
  const flatOld = join(topicDir, paperName + '.pdf')
  const flatNew = join(topicDir, newName + '.pdf')
  const dirHit = existsSync(targetDir) && !(layout === 'folder' && sameRealpath(targetDir, sourceDir))
  const flatHit = existsSync(flatNew) && !(existsSync(flatOld) && sameRealpath(flatNew, flatOld))
  const artifactsHit = listArtifacts(topicDir, newName).length > 0
  if (!dirHit && !flatHit && !artifactsHit) return
  throw new ManageError('target-exists', 409, `已存在同名文献或残留产物：${newName}`, { conflicts: [newName] })
}

/**
 * `renamePaper` 的**只读**前置（一个实现，两处消费：工具在**审批前**预检、`renamePaper` 执行时复核）。
 * 任一检查失败都抛 ManageError 且零改动；成功只返回计划，不碰盘。
 */
export function planRenamePaper(dataDir: string, topic: unknown, name: unknown, newNameRaw: unknown): RenamePaperPlan {
  // rename-from（topic/name）只做边界类校验；改名**目标**名仍走命名规范类（validateNewPaperName）。
  const topicName = validateTopicPath(topic, true)
  const paperName = validateEntryBoundary(name, 'paper')
  const newName = validateNewPaperName(newNameRaw, paperName)
  // 全套存在性/产物/`.pdf` 常规文件/**混合态布局冲突**（t4-F2）都走既有 planPaperDelete
  const del = planPaperDelete(dataDir, topicName, paperName)
  const topicDir = resolveExistingTopicDir(dataDir, topicName)
  const sourceDir = del.layout === 'folder' ? resolveExistingPaperDir(dataDir, topicName, paperName) : topicDir
  assertRenameTargetFree(topicDir, paperName, newName, sourceDir, del.layout)
  return {
    topic: del.topic,
    name: del.name,
    newName,
    layout: del.layout,
    sourceDir,
    files: del.files,
    totalBytes: del.totalBytes,
  }
}

/**
 * 重命名文献（新布局）：**先整体 rename 论文目录** `<old>/` → `<new>/`，再在目录内把
 * `<old><后缀>` 逐个改名为 `<new><后缀>`（方案 §B1.3 #13）。
 * 两步之间不原子 ⇒ 中途失败按逆序回滚（内部文件名 → 目录名），并如实报 `rename-partial`/`file-busy`。
 *
 * 目标冲突判定**复用 `planRenamePaper`**（三路 + 大小写-only 放行）：执行前会重新算一遍目标状态，
 * 因此不存在「用旧计划执行」的窗口；UI 路由共用本函数，自动获得同一加严。
 */
export function renamePaper(dataDir: string, topic: unknown, name: unknown, newNameRaw: unknown, renameImpl: RenameImpl = renameSync): RenameResult {
  const plan = planRenamePaper(dataDir, topic, name, newNameRaw)
  const topicDir = resolveExistingTopicDir(dataDir, plan.topic)
  // 旧布局（未迁移）：产物平铺在专题目录里 ⇒ 逐个文件改名（原来的实现，行为逐字保留）
  if (plan.layout === 'legacy') return renameLegacyPaper(dataDir, topicDir, plan.name, plan.newName, renameImpl)
  const paperDirAbs = plan.sourceDir
  const paperName = plan.name
  const newName = plan.newName
  const files = plan.files
  const targetDir = join(topicDir, newName)

  // ① 目录整体改名（同一文件系统内的元数据操作）
  if (targetDir !== paperDirAbs) {
    try {
      renameImpl(paperDirAbs, targetDir)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EBUSY' || code === 'EPERM') {
        throw new ManageError('file-busy', 409, `文件被占用（可能正在阅读器或其他程序中打开），关闭后重试；${'本次改名未生效'}`, {
          busy: newName, cause: code,
        })
      }
      if (typeof code === 'string' && code) throw err
      throw new ManageError('rename-partial', 500, '重命名文献失败（目录改名未生效）', {})
    }
  }

  // ② 目录内文件名同步改名（产物名带论文名）
  const renamed: Array<{ from: string; to: string }> = []
  const rollbackInner = () => {
    const rolledBack: string[] = []
    const rollbackFailed: string[] = []
    for (const m of [...renamed].reverse()) {
      try { renameImpl(m.to, m.from); rolledBack.push(basename(m.from)) } catch { rollbackFailed.push(basename(m.from)) }
    }
    return { rolledBack, rollbackFailed }
  }
  for (const f of files) {
    const from = join(targetDir, f.name)
    const to = join(targetDir, renamedName(f.name, paperName, newName))
    if (from === to) continue
    try {
      renameImpl(from, to)
      renamed.push({ from, to })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const { rolledBack, rollbackFailed } = rollbackInner()
      // 目录名也搬回去（内部文件名已回滚 ⇒ 目录是完整的）
      let dirRestored = true
      if (rolledBack.length > 0 || rollbackFailed.length === 0) {
        try { if (targetDir !== paperDirAbs) renameImpl(targetDir, paperDirAbs) } catch { dirRestored = false }
      }
      const tail = rollbackFailed.length === 0
        ? (dirRestored ? '本次改名已全部撤销，文献库未改变' : '内部文件已撤销，但目录名未能还原，请手动检查')
        : `但 ${rollbackFailed.length} 个文件未能回滚（仍在改名后的名字上，请手动检查）：${rollbackFailed.join('、')}`
      if (code === 'EBUSY' || code === 'EPERM') {
        throw new ManageError('file-busy', 409, `文件被占用（可能正在阅读器或其他程序中打开），关闭后重试；${tail}`, {
          busy: basename(from), moved: [], remaining: files.map((f2) => f2.name), rolledBack, rollbackFailed, cause: code,
        })
      }
      throw new ManageError('rename-partial', 500, `重命名中途失败；${tail}`, {
        moved: [], remaining: files.map((f2) => f2.name), rolledBack, rollbackFailed, cause: code ?? 'unknown',
      })
    }
  }
  return { ok: true, moved: renamed.map((m) => basename(m.to)), from: paperName, to: newName }
}

/**
 * 旧布局的产物改名：逐个文件 rename（**纯前缀拼接**，防 `$&` 展开），中途失败 best-effort 回滚。
 * 新布局走「先整体 rename 论文文件夹、再改文件夹内文件名」的两段式；这段只为未迁移的库保留。
 */
function renameLegacyPaper(dataDir: string, topicDir: string, paperName: string, newName: string, renameImpl: RenameImpl): RenameResult {
  const files = listArtifacts(topicDir, paperName)
  assertArtifactsContained(dataDir, topicDir, files)
  if (!files.some((f) => f.kind === 'pdf')) throw new ManageError('not-found', 404, `文献不存在：${paperName}.pdf`)
  const clash: string[] = []
  for (const f of files) {
    const target = join(topicDir, renamedName(f.name, paperName, newName))
    if (!existsSync(target)) continue
    let same = false
    try {
      same = realpathSync(target) === realpathSync(join(topicDir, f.name))
    } catch { /* 目标不可读 → 视为冲突 */ }
    if (!same) clash.push(basename(target))
  }
  if (clash.length > 0) {
    throw new ManageError('target-exists', 409, `已存在同名文件：${clash.slice(0, 3).join(', ')}${clash.length > 3 ? ' …' : ''}`, { conflicts: clash })
  }
  const moved: Array<{ from: string; to: string }> = []
  for (const f of files) {
    const from = join(topicDir, f.name)
    const to = join(topicDir, renamedName(f.name, paperName, newName))
    if (from === to) continue
    try {
      renameImpl(from, to)
      moved.push({ from, to })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const busy = code === 'EBUSY' || code === 'EPERM'
      const rolledBack: string[] = []
      const rollbackFailed: string[] = []
      for (const m of moved.reverse()) {
        try { renameImpl(m.to, m.from); rolledBack.push(basename(m.from)) } catch { rollbackFailed.push(basename(m.from)) }
      }
      const remaining = files.filter((f2) => !rollbackFailed.includes(f2.name)).map((f2) => f2.name)
      const tail = rollbackFailed.length === 0
        ? '本次改名已全部撤销，文献库未改变'
        : `但 ${rollbackFailed.length} 个文件未能回滚（仍在改名后的名字上，请手动检查）：${rollbackFailed.join('、')}`
      if (busy) {
        throw new ManageError('file-busy', 409, `文件被占用（可能正在阅读器或其他程序中打开），关闭后重试；${tail}`, {
          busy: basename(from), moved: [], remaining, rolledBack, rollbackFailed, cause: code,
        })
      }
      if (typeof code === 'string' && code && rollbackFailed.length === 0) throw err
      throw new ManageError('rename-partial', 500, `重命名中途失败；${tail}`, {
        moved: [], remaining, rolledBack, rollbackFailed, cause: code ?? 'unknown',
      })
    }
  }
  return { ok: true, moved: moved.map((m) => basename(m.to)), from: paperName, to: newName }
}

/**
 * 重命名/移动专题（新布局）：`to` 是**相对 dataDir 的路径**（`A/B`）⇒ 天然支持「移动到另一父」。
 * 附带两条新不变量（方案 §B2.5）：
 *   · 移动到**自己的子树**里 → 409 `bad-request`（否则目录会消失成孤儿）；
 *   · `to` 的父目录必须已存在且是库内目录（不隐式创建父级）。
 */
export function renameTopic(dataDir: string, name: unknown, newNameRaw: unknown, renameImpl: RenameImpl = renameSync): RenameResult {
  // from 侧是已存在目录 → 边界类（历史遗留名也能改名）；to 侧是新路径 → 逐段命名规范类。
  const topic = validateTopicPath(name, true)
  const newTopic = validateTopicPath(newNameRaw, false)
  if (newTopic === topic) throw new ManageError('bad-request', 400, '新名称与原名称相同')
  const dir = resolveExistingTopicDir(dataDir, topic)
  const root = realDataDir(dataDir)
  const parentRel = newTopic.split('/').slice(0, -1).join('/')
  if (parentRel) resolveTopicDir(dataDir, parentRel)   // 父目录必须存在（404 文案复用）
  const target = join(root, ...newTopic.split('/'))
  if (existsSync(target)) throw new ManageError('target-exists', 409, `已存在同名专题：${newTopic}`)
  assertInside(root, target)
  // 移动到自己子树里：目标路径落在源目录之内 ⇒ 拒绝（409；不是 400 的命名问题）
  const selfPrefix = dir.endsWith(sep) ? dir : dir + sep
  if (target.startsWith(selfPrefix)) {
    throw new ManageError('bad-request', 409, '不能把专题移动到它自己的子专题下', { from: topic, to: newTopic })
  }
  try {
    renameImpl(dir, target)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // Windows 文件占用（EBUSY/EPERM）→ 409 file-busy 可执行文案（上游必修 3）。
    if (code === 'EBUSY' || code === 'EPERM') {
      throw new ManageError('file-busy', 409, '文件被占用（可能正在阅读器或其他程序中打开），关闭后重试；本次改名未生效', {
        busy: newTopic, cause: code,
      })
    }
    // 其它 errno（ENAMETOOLONG/EACCES…）带上原始 .code 上交：host 的错误通道给固定中文文案 400，
    // 绝不把绝对路径回显给客户端。非 errno 才归为 rename-partial。
    if (typeof code === 'string' && code) throw err
    throw new ManageError('rename-partial', 500, '重命名专题失败', {})
  }
  return { ok: true, moved: [], from: topic, to: newTopic }
}
// ── agent 文献整理工具的新写语义（建空专题 / 原子收录 / 整目录移动）─────────────
// 契约：docs/library-manage-tools-plan.md §3.2.3–§3.2.5。三者的**校验/回收站/realpath**全部复用
// 上面已有的实现（validateName / validateTopicPath / resolveTopicDir* / assertInside / realDataDir /
// listArtifacts / planPaperDelete / moveToTrash / rename*），本段只补「路由里原本内联」与
// 「工具新增」的写路径，不复制第二份校验。

/**
 * 创建（多级）专题 —— 与 `src/host.ts` 的 `POST /api/library/topic` **同构**：
 * 逐段词法校验 → 对每个**已存在**的祖先走 `resolveTopicDir`（拒符号链接/逃逸）→ 已存在则复核后
 * 幂等返回 `created:false`；否则 `assertInside` + `mkdir(recursive)`。
 * 不写工作区缓存、不写 `.trash`、不做审批（只新增一个空目录）。
 */
export interface CreateTopicResult {
  ok: true
  topic: string
  created: boolean
}

/** 目标路径上「已存在的条目」形态：null=不存在；'dir'=真目录；'conflict'=普通文件/其它；'symlink'=符号链接。 */
function existingEntryKind(dir: string): 'dir' | 'conflict' | 'symlink' | null {
  let st
  try {
    st = lstatSync(dir)
  } catch {
    return null
  }
  if (st.isSymbolicLink()) return 'symlink'
  return st.isDirectory() ? 'dir' : 'conflict'
}

/** `createTopic` 的「目标已存在」收口：目录 ⇒ 幂等 created:false；文件/符号链接 ⇒ 冲突（零改动）。 */
function finishExistingTopic(dataDir: string, topic: string, kind: 'dir' | 'conflict' | 'symlink'): CreateTopicResult {
  if (kind === 'symlink') {
    // 与 resolveTopicDir 的 realpath 层同口径：符号链接专题一律拒（不隐式穿越）
    throw new ManageError('escape-rejected', 400, `路径越界：专题目录是符号链接，已拒绝：${topic}`)
  }
  if (kind === 'conflict') {
    throw new ManageError('target-exists', 409, `已存在同名文件或专题：${topic}`, { conflicts: [topic] })
  }
  resolveTopicDir(dataDir, topic)   // 真目录：realpath / 子路径包含再复核一次
  return { ok: true, topic, created: false }
}

export function createTopic(dataDir: string, raw: unknown): CreateTopicResult {
  const topic = validateTopicPath(raw, false)
  const root = realDataDir(dataDir)
  const segs = topic.split('/')
  for (let i = 1; i < segs.length; i++) {
    if (!existsSync(join(root, ...segs.slice(0, i)))) break
    resolveTopicDir(dataDir, segs.slice(0, i).join('/'))
  }
  const dir = join(root, ...segs)
  // 已存在 → 必须是库内真目录（不是符号链接）⇒ 幂等返回 created:false（路由也是 200）。
  // 同名**普通文件/其它非目录** → 409 target-exists（t3 低危：以前会走 resolveTopicDir 的 404，
  // 与 add_paper/planMovePaper 的「名字被占用」语义不一致；这里统一成冲突，仍零副作用）。
  const existing = existingEntryKind(dir)
  if (existing !== null) return finishExistingTopic(dataDir, topic, existing)
  assertInside(root, dir)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // 并发下被别人先建出来：仍是「已存在」语义（复核后返回 created:false，绝不覆盖内容）
    if (code === 'EEXIST') {
      const raced = existingEntryKind(dir)
      if (raced !== null) return finishExistingTopic(dataDir, topic, raced)
      throw new ManageError('target-exists', 409, `已存在同名文件或专题：${topic}`, { conflicts: [topic] })
    }
    if (code === 'EBUSY' || code === 'EPERM') {
      throw new ManageError('file-busy', 409, '位置被占用（可能正在阅读器或其他程序中打开），关闭后重试；本次未创建专题', { cause: code })
    }
    throw new ManageError('add-partial', 500, '创建专题失败（未做任何改动）', { cause: code ?? 'unknown' })
  }
  return { ok: true, topic, created: true }
}

export interface AddPaperOptions {
  /** 复制实现（仅测试注入；默认 copyFileSync） */
  copyImpl?: (from: string, to: string) => void
  /** 落盘实现（仅测试注入；默认 linkSync；不可用时回退 renameSync） */
  linkImpl?: (from: string, to: string) => void
  renameImpl?: RenameImpl
}

export interface AddPaperResult {
  ok: true
  topic: string
  name: string
  bytes: number
  /** 落盘后的 PDF 绝对路径（与 transcribe_pdf 的 txtPath 同为绝对路径） */
  pdfPath: string
  /** 源文件的 basename（不泄露源目录绝对路径；审批与文案只需要文件名） */
  sourceName: string
}

/** PDF 魔数：读前 1024 字节找 ASCII `%PDF-`（允许前置少量垃圾，与 pdf.js 的容忍度一致）。 */
function hasPdfMagic(path: string): boolean {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(1024)
    const n = readSync(fd, buf, 0, 1024, 0)
    return buf.subarray(0, n).includes('%PDF-')
  } finally {
    closeSync(fd)
  }
}

/**
 * 把本地 PDF **原子**收录为一篇新文献（`<topicDir>/<name>/<name>.pdf`）。
 *
 * 源文件只读：不会被移动/删除；拒绝目录与符号链接（「符号链接不是文献」是全库不变量，
 * 用户要收录链接目标请传 realpath）；要求非空且含 `%PDF-` 头。
 *
 * 目标冲突一律 409 且零写入（同名论文夹 / 平铺 `<name>.pdf` / 同名孤儿产物任一命中）。
 * 落盘不覆盖：先写 `.tmp-<pid>-<8hex>`（`TMP_RE` 兼容，中途残留也能被产物清单精确识别），
 * 再 `linkSync` 到最终名（`EEXIST` ⇒ target-exists）；文件系统不支持硬链接时回退同目录
 * `renameSync`（`!existsSync` 先复核）。任何失败都把本次创建的东西清理到零改动。
 */
export function addPaper(
  dataDir: string,
  topic: unknown,
  sourcePath: unknown,
  name?: unknown,
  opts: AddPaperOptions = {},
): AddPaperResult {
  if (typeof sourcePath !== 'string' || sourcePath.trim() === '') {
    throw new ManageError('bad-request', 400, 'add_paper 需要 source_path（源 PDF 绝对路径）')
  }
  const topicName = validateTopicPath(topic, false)
  const topicDir = resolveTopicDir(dataDir, topicName)
  // 论文名先定（词法层在**任何写盘/读源之前**）：显式 name 优先，否则取源文件 basename 去掉 .pdf
  let paperName: string
  if (name !== undefined && name !== null && name !== '') {
    paperName = validatePaperName(name)
  } else {
    const base = basename(resolve(sourcePath))
    const stem = base.toLowerCase().endsWith('.pdf') ? base.slice(0, -4) : base
    paperName = validatePaperName(stem)
  }
  const src = resolve(sourcePath)
  let st
  try {
    st = lstatSync(src)
  } catch {
    throw new ManageError('source-not-found', 404, `源文件不存在或不可读：${basename(src)}`)
  }
  if (!st.isFile() || st.isSymbolicLink()) {
    throw new ManageError('source-invalid', 400, '源必须是常规 PDF 文件（不接受目录/符号链接）')
  }
  if (st.size === 0) throw new ManageError('source-empty', 400, '源文件为空')
  let realSrc: string
  let pdfMagic: boolean
  try {
    realSrc = realpathSync(src)
    pdfMagic = hasPdfMagic(realSrc)
  } catch {
    throw new ManageError('source-not-found', 404, `源文件不存在或不可读：${basename(src)}`)
  }
  if (!pdfMagic) throw new ManageError('source-not-pdf', 400, '源文件不是 PDF（缺 %PDF- 头）')
  // 目标冲突（三条任一命中 ⇒ 409，零写入）：同名论文夹 / 平铺 pdf / 同名孤儿产物
  if (existsSync(join(topicDir, paperName)) || existsSync(join(topicDir, paperName + '.pdf')) || listArtifacts(topicDir, paperName).length > 0) {
    throw new ManageError('target-exists', 409, `已存在同名文献或残留产物：${paperName}`, { conflicts: [paperName] })
  }
  const targetDir = join(topicDir, paperName)
  const finalPath = join(targetDir, paperName + '.pdf')
  const tmpPath = join(targetDir, `${paperName}.pdf.tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
  const copyImpl = opts.copyImpl ?? copyFileSync
  const linkImpl = opts.linkImpl ?? linkSync
  const renameImpl = opts.renameImpl ?? renameSync
  let dirCreated = false
  let finalCreated = false
  try {
    mkdirSync(targetDir, { recursive: true, mode: 0o700 })
    dirCreated = true   // 前置已确认不存在；工具层持 topic+paper 锁 ⇒ 单进程内不会撞（跨进程竞争不在本插件支持范围）
    copyImpl(realSrc, tmpPath)
    if (statSync(tmpPath).size !== st.size) {
      throw new ManageError('add-partial', 500, '收录中断：复制结果与源文件大小不一致，已清理到零改动', { cause: 'size-mismatch' })
    }
    try {
      linkImpl(tmpPath, finalPath)
      finalCreated = true
      // 收到这里时**落盘已经成功**（final 已就位、内容已校验）——临时名只是我们自己的残留。
      // 清理绝对不能把一次成功的收录变成错误（数据已可用），但也不能完全静默（t3 低危：以前空 catch 吞掉）：
      // 先 unlink，失败再 rm --force；仍失败就 warn 留痕（不扩 schema/summary 契约，不伪装成完全干净）。
      try {
        unlinkSync(tmpPath)
      } catch (err) {
        try {
          rmSync(tmpPath, { force: true })
        } catch {
          console.warn('[dsh-paper-reader] addPaper: 收录成功但临时文件未能清理（可手动删除）:', basename(tmpPath), err)
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        throw new ManageError('target-exists', 409, `已存在同名文献：${paperName}`, { conflicts: [paperName] })
      }
      if (code === 'EPERM' || code === 'ENOSYS' || code === 'EOPNOTSUPP' || code === 'EXDEV') {
        // 硬链接不可用（FAT/exFAT/部分网络盘）：同目录 rename，落盘前再复核一次「不覆盖」
        if (existsSync(finalPath)) {
          throw new ManageError('target-exists', 409, `已存在同名文献：${paperName}`, { conflicts: [paperName] })
        }
        renameImpl(tmpPath, finalPath)
        finalCreated = true
      } else {
        throw err
      }
    }
  } catch (err) {
    const cause = (err as NodeJS.ErrnoException).code ?? 'unknown'
    const cleanupFailed: string[] = []
    for (const [what, p] of [['tempLeft', tmpPath], ['fileLeft', finalCreated ? finalPath : '']] as const) {
      if (!p) continue
      try {
        if (existsSync(p)) rmSync(p, { force: true })
      } catch { cleanupFailed.push(what) }
    }
    if (dirCreated) {
      try { rmdirSync(targetDir) } catch { if (existsSync(targetDir)) cleanupFailed.push('dirLeft') }
    }
    if (isManageError(err)) throw err
    if (cleanupFailed.length > 0) {
      throw new ManageError('add-partial', 500, `收录中断且未能清理干净（残留：${cleanupFailed.join('、')}），请手动检查`, {
        tempLeft: cleanupFailed.includes('tempLeft'), dirLeft: cleanupFailed.includes('dirLeft'), cause,
      })
    }
    if (cause === 'EBUSY' || cause === 'EPERM') {
      throw new ManageError('file-busy', 409, '文件被占用（可能正在阅读器或其他程序中打开），关闭后重试；本次收录未生效', { cause })
    }
    throw new ManageError('add-partial', 500, '收录中断，已清理到零改动', { cause })
  }
  return { ok: true, topic: topicName, name: paperName, bytes: st.size, pdfPath: finalPath, sourceName: basename(src) }
}

export interface MoveResult {
  ok: true
  /** 形如 `T/P` */
  from: string
  /** 形如 `S/P` */
  to: string
  name: string
  /** 产物文件名（来自 listArtifacts；不含未知条目） */
  moved: string[]
  /** 论文夹里不属于产物族的条目（随目录一起搬走，如实报告） */
  otherEntries: string[]
}

export interface MovePaperPlan {
  /** 源专题（规范化后的相对路径） */
  topic: string
  /** 目标专题（规范化后的相对路径） */
  toTopic: string
  name: string
  sourceDir: string
  targetDir: string
  files: ManagedFile[]
  moved: string[]
  otherEntries: string[]
}

/**
 * movePaper 的**只读**前置（一个实现，两处消费：工具在审批前预检、movePaper 执行前复核）。
 * 任一检查失败都抛 ManageError 且**零改动**；成功只返回计划，不碰盘。
 */
export function planMovePaper(dataDir: string, fromTopic: unknown, name: unknown, toTopic: unknown): MovePaperPlan {
  const fromName = validateTopicPath(fromTopic, true)
  const toName = validateTopicPath(toTopic, true)
  const paperName = validateEntryBoundary(name, 'paper')
  resolveExistingTopicDir(dataDir, fromName)   // 源专题必须存在（404 / 符号链接 400）
  const toDir = resolveExistingTopicDir(dataDir, toName)   // 目标专题必须已存在（不隐式创建）
  const plan = planPaperDelete(dataDir, fromName, paperName)   // 词法/存在性/产物包含性/`.pdf` 常规文件
  if (plan.layout === 'legacy') {
    throw new ManageError('legacy-layout', 409, '该文献仍是旧布局（未迁移），请先在界面执行迁移后再移动', {
      topic: fromName, name: paperName,
    })
  }
  const sourceDir = resolveExistingPaperDir(dataDir, fromName, plan.name)
  const target = join(toDir, plan.name)
  if (target === sourceDir) throw new ManageError('bad-request', 400, '目标专题与源专题相同')
  if (existsSync(target) || existsSync(join(toDir, plan.name + '.pdf')) || listArtifacts(toDir, plan.name).length > 0) {
    throw new ManageError('target-exists', 409, `目标专题已存在同名文献或残留产物：${toName}/${plan.name}`, {
      conflicts: [`${toName}/${plan.name}`],
    })
  }
  const selfPrefix = sourceDir.endsWith(sep) ? sourceDir : sourceDir + sep
  if (target.startsWith(selfPrefix)) {
    throw new ManageError('bad-request', 409, '不能把文献移动到它自己的子目录下', {
      from: `${fromName}/${paperName}`, to: `${toName}/${plan.name}`,
    })
  }
  assertInside(realDataDir(dataDir), target)
  // 只读枚举（用于如实报告）：产物清单走既有精确 stem 匹配，其余条目按差集列出（它们随目录一起搬走）
  const artifactNames = new Set(plan.files.map((f) => f.name))
  let otherEntries: string[]
  try {
    otherEntries = readdirSync(sourceDir).filter((n) => !artifactNames.has(n)).sort()
  } catch (err) {
    // 目录不可读（EACCES/IO）：给出可执行文案，绝不把 errno 的绝对路径冒泡给调用方（S15/F5）
    throw new ManageError('bad-request', 400, '论文文件夹不可读，已取消移动（未做任何改动）', {
      cause: (err as NodeJS.ErrnoException).code ?? 'unknown',
    })
  }
  return {
    topic: fromName,
    toTopic: toName,
    name: plan.name,
    sourceDir,
    targetDir: target,
    files: plan.files,
    moved: plan.files.map((f) => f.name),
    otherEntries,
  }
}

/**
 * 跨专题移动一篇论文 —— **一次目录 rename** `<fromTopicDir>/<name>` → `<toTopicDir>/<name>`：
 * 不逐个搬文件、不改文件名、不重建 sidecar。论文夹内的全部产物（含译文变体/隐藏条目/用户自放文件）
 * 都在同一目录树内，同文件系统 rename 是**原子**的，天然「全产物一起搬」。
 *
 * **拒绝旧布局**（`legacy-layout` 409）：把平铺产物收进论文文件夹 = 替用户执行了一篇迁移，
 * 而迁移执行只能留在界面（docs/migrate-prompt-plan.md 红线）。
 *
 * 前置全部只读（见 planMovePaper）。rename 失败按 errno 映射（EBUSY/EPERM → 409 file-busy，
 * 其它 → 500 move-partial）；rename 成功但后置校验不成立时尽力回滚，并如实报告
 * rolledBack / rollbackFailed。
 */
export function movePaper(
  dataDir: string,
  fromTopic: unknown,
  name: unknown,
  toTopic: unknown,
  renameImpl: RenameImpl = renameSync,
): MoveResult {
  const plan = planMovePaper(dataDir, fromTopic, name, toTopic)
  try {
    renameImpl(plan.sourceDir, plan.targetDir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EBUSY' || code === 'EPERM') {
      throw new ManageError('file-busy', 409, '文件被占用（可能正在阅读器或其他程序中打开），关闭后重试；本次移动未生效', {
        busy: plan.name, cause: code,
      })
    }
    if (typeof code === 'string' && code) {
      throw new ManageError('move-partial', 500, '移动文献失败（未生效）；文献库未改变', { cause: code })
    }
    throw new ManageError('move-partial', 500, '移动文献失败（未生效）；文献库未改变', { cause: 'unknown' })
  }
  // 后置校验：目标必须是论文目录、源目录必须已不存在；否则尽力回滚并如实报告
  if (!isPaperDir(plan.targetDir) || existsSync(plan.sourceDir)) {
    let rolledBack = false
    try {
      renameImpl(plan.targetDir, plan.sourceDir)
      rolledBack = true
    } catch { /* 回滚失败：如实报告，让用户手动检查 */ }
    if (rolledBack) {
      throw new ManageError('move-partial', 500, '移动后校验失败，已回滚；文献库未改变', { rolledBack: [plan.name] })
    }
    throw new ManageError('move-partial', 500,
      `移动后校验失败且回滚未成功：论文可能在目标路径（${plan.toTopic}/${plan.name}），请手动检查`, {
        rollbackFailed: [plan.name], trashRel: null,
      })
  }
  return {
    ok: true,
    from: `${plan.topic}/${plan.name}`,
    to: `${plan.toTopic}/${plan.name}`,
    name: plan.name,
    moved: plan.moved,
    otherEntries: plan.otherEntries,
  }
}

