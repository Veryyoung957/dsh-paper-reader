// tools.ts — 工具注册（Cordis 壳；核心逻辑在 library/transcribe/search 纯函数里）。

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { basename } from 'node:path'
import { listPapers, listTopics, paperRefFor, resolveDataDir, resolvePaper, type PaperRef } from './library.ts'
import { transcribePaper, readTranscript, type SourceArg } from './transcribe.ts'
import { chunkText, queryVariantsFor, searchChunksMulti, formatHits } from './search.ts'
import { readTranscriptMeta } from './transcribe.ts'
import { EMBED_DEFAULTS, embeddingsPathFor, embeddingRecallFor, fuseHybridCandidates, type EmbedConfig } from './embed.ts'
import { resolveEmbedConfig } from './embed-config.ts'
import { resolveRerankClient, resolveShortlistSize, rerankHits, type RerankConfig } from './rerank.ts'
import { completeStep, formatStudy, readStudy, recordQuiz, setPlan } from './study.ts'
import { readerOrigin } from './origin.ts'
import { resolveMineruConfig, type MineruConfig } from './mineru-config.ts'
import { formatMigrationReport, planMigration } from './migrate.ts'
import {
  ManageError,
  addPaper,
  createTopic,
  deletePaper,
  deleteTopic,
  isManageError,
  movePaper,
  planMovePaper,
  planPaperDelete,
  planTopicDelete,
  renamePaper,
  renameTopic,
  validateEntryBoundary,
  validatePaperName,
  validateTopicPath,
  type ManageCode,
} from './library-manage.ts'
import { createLibraryGuards, type LibraryGuards } from './library-guards.ts'
import { zhStatus } from './translate.ts'
import {
  detectMigrationNeed,
  invalidateMigrationPromptCache,
  promptStatePayload,
  resetPromptState,
  takeMigrationPrompt,
  writePromptState,
  type MigrationNeed,
  type PromptLang,
} from './migrate-prompt.ts'

export interface PluginConfig {
  /** 文献库数据目录；默认 ~/.dsh-paper-reader/data */
  dataDir?: string
  /** 中文翻译（babeldoc）用的 OpenAI 兼容端点；不配则「生成中文版」不可用 */
  translate?: {
    baseUrl?: string
    apiKey?: string
    model?: string
  }
  /** 检索语义重排（Jev / TypeSafe）。凭据优先级：设置面板 > 此 YAML > 环境变量 TYPESAFE_API_KEY；都没有时退回纯关键词排序 */
  typesafe?: RerankConfig
  /** MinerU 解析后端（本地 legacy API + mineru.net v4 云端）。mode 默认 off，未配置时行为与改造前一致 */
  mineru?: MineruConfig
  /** 嵌入模型检索（OpenAI 兼容 /embeddings）。凭据优先级：设置面板 > 此 YAML > 环境变量 DSH_EMBED_API_KEY；
      三者缺任一项时嵌入检索整体关闭（默认关闭），search_paper 退回纯关键词排序 */
  embed?: EmbedConfig
}

const MINERU_SOURCES = ['auto', 'pdfjs', 'mineru-local', 'mineru-cloud'] as const
function sourceArg(v: unknown): SourceArg {
  return (MINERU_SOURCES as readonly string[]).includes(v as string) ? (v as SourceArg) : 'auto'
}

/** 文献定位参数（三工具共用的 args 子集）。 */
interface LocateArgs {
  path?: string
  topic?: string
  name?: string
}

const locateParams = {
  path: { type: 'string', description: 'PDF 绝对路径。与 topic+name 二选一。' },
  topic: { type: 'string', description: '专题名（文献库一级目录）。' },
  name: { type: 'string', description: '文献名（不带 .pdf 后缀）。省略时自动使用当前会话绑定的论文（伴读会话），只有查询别的论文才需要显式指定。' },
} as const

function locate(dataDir: string, args: LocateArgs, exec?: { agent?: { id?: string } }): PaperRef {
  const refArgs: { path?: string; topic?: string; name?: string } = {}
  if (args.path) refArgs.path = args.path
  if (args.topic) refArgs.topic = args.topic
  if (args.name) refArgs.name = args.name
  // 未指定论文时回退到「当前会话绑定的论文」：伴读会话 id 形如 dpr-<base64url(topic/name)>-N，
  // 工具执行上下文里的 agent.id 就是会话 id。直接在输入框提问（不经选中即问）时靠它定位。
  if (!refArgs.path && !refArgs.name) {
    const paper = paperFromSessionId(exec?.agent?.id)
    if (paper) return resolvePaper(dataDir, { topic: paper.topic, name: paper.name })
  }
  return resolvePaper(dataDir, refArgs)
}

/** 从伴读会话 id 反解论文（dpr-<base64url(topic/name)>[-N]）；非伴读会话返回 null。 */
export function paperFromSessionId(sessionId: string | undefined): { topic: string; name: string } | null {
  if (!sessionId?.startsWith('dpr-')) return null
  try {
    const body = sessionId.slice(4).replace(/-\d+$/, '')
    const decoded = Buffer.from(body, 'base64url').toString('utf8')
    const sep = decoded.indexOf('/')
    if (sep <= 0 || sep === decoded.length - 1) return null
    return { topic: decoded.slice(0, sep), name: decoded.slice(sep + 1) }
  } catch {
    return null
  }
}

/** 某篇论文的阅读器链接基址（拼 &page=N 即跳转链接）；origin 未捕获到时为 null。 */
function readerUrl(ref: PaperRef): string | null {
  const o = readerOrigin()
  if (!o) return null
  return `${o}/paper-reader/?topic=${encodeURIComponent(ref.topic)}&name=${encodeURIComponent(ref.name)}`
}

/** 输出 schema 里的 readerUrl 字段声明（nullable：没有任何浏览器请求过时尚未捕获 origin）。 */
const readerUrlSchema = {
  oneOf: [{ type: 'string' }, { type: 'null' }],
  required: true,
  description:
    '阅读器链接基址。引用页码时在末尾拼 &page=N 生成跳转链接；要定位到具体段落再拼 &q=<该段落原文短引文，3~8个词，URL编码>，点击会高亮对应片段。为 null 时本次不带链接。',
} as const

/** render 文本尾部统一带出的链接基址行（preset 规定了用法，这里只暴露值）。 */
const readerUrlLine = (url: string | null) => (url ? `\n阅读器链接基址：${url}` : '')

/* ═══════════════════════════════════════════════════════════════════════════
   对话侧「未迁移提示」入口（冻结方案 docs/migrate-prompt-plan.md §2）
   · 判据**实际扫目录**（detectMigrationNeed），不是只看 .migration-v1.done 标记；
   · `ask` 一旦给出，服务端立刻写 `choice='asked'` + 指纹 ⇒ 同一指纹第二次绝不再问（红线②）；
   · 判据任何异常都降级 silent、不写偏好（红线③④），故这里**不需要** try/catch 包一层。
   ═══════════════════════════════════════════════════════════════════════════ */

/** 提示文案语言（工具输出默认中文；DPR_MIGRATE_PROMPT_LANG=en 可切英文，供 en 文案验收用）。 */
function promptLang(): PromptLang {
  return process.env['DPR_MIGRATE_PROMPT_LANG']?.trim() === 'en' ? 'en' : 'zh'
}

/** 干跑报告进工具结果的字符上限（超长截断并注明——工具返回不该被一份报告撑爆）。 */
const MIGRATION_REPORT_LIMIT = 8000

/** `silent` 时也保留全部字段（便于断言），只是 `text=''`、`papers=null` 之一。 */
interface MigrationField {
  level: 'ask' | 'info' | 'silent'
  reason: string
  state: MigrationNeed['state']
  /** `certain=false` 时 **null**（不显示篇数以免误导）；`silent` 时为 0 */
  papers: number | null
  files: number | null
  migratable: number | null
  byClass: MigrationNeed['byClass']
  certain: boolean
  markerSync: MigrationNeed['markerSync']
  fingerprint: string
  reportTool: 'migration_report'
  askOnce: boolean
  text: string
  ask_hint: string | null
  /** §2.5 失败回退表：判据整个跑不了（根读不进去 / 抛错）时为 'scan-failed'，其余为 null。 */
  error: string | null
}

/** 计算并「取用」一次提示（ask ⇒ 写 asked）。两个工具共用，走同一份缓存与同一份偏好。 */
function migrationField(dataDir: string): MigrationField {
  const need = detectMigrationNeed(dataDir)
  const taken = takeMigrationPrompt(need, { lang: promptLang(), by: 'tool' })
  const known = need.certain
  return {
    level: taken.level,
    reason: taken.reason,
    state: need.state,
    papers: known ? need.papers : null,
    files: known ? need.files : null,
    migratable: known ? need.migratable : null,
    byClass: need.byClass,
    certain: known,
    markerSync: need.markerSync,
    fingerprint: need.fingerprint,
    reportTool: 'migration_report',
    askOnce: taken.level === 'ask',
    text: taken.text,
    ask_hint: taken.askHint,
    error: taken.reason === 'scan-failed' ? 'scan-failed' : null,
  }
}

const nullableInt = { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true } as const

/** 两个工具共用的 `migration` 输出字段声明（`output.schema` 是 additionalProperties:false，必须登记）。 */
const migrationSchema = {
  type: 'object',
  required: true,
  properties: {
    level: {
      type: 'string', required: true, enum: ['ask', 'info', 'silent'],
      description: 'ask=请 agent 用一句话询问用户是否迁移；info=只说明情况（不问）；silent=不必提。',
    },
    reason: { type: 'string', required: true, description: 'level 的机器可读原因（unmigrated/already-asked/declined/needs-manual/unreadable…）。' },
    state: { type: 'string', required: true, description: '未迁移态：unmigrated/residue/partial/marker-mismatch/needs-manual/migrated/empty/unknown。' },
    papers: { ...nullableInt, description: '还有 N 篇论文留在旧（平铺）位置（certain=false 时为 null）。' },
    files: { ...nullableInt, description: '这些论文留在平铺位置的产物文件数（certain=false 时为 null）。' },
    migratable: { ...nullableInt, description: '迁移真正能收口的篇数（flat+residue）；只剩 conflict/quarantine 时为 0。' },
    byClass: {
      type: 'object', required: true,
      properties: {
        flat: { type: 'integer', required: true }, residue: { type: 'integer', required: true },
        conflict: { type: 'integer', required: true }, quarantine: { type: 'integer', required: true },
      },
      additionalProperties: false,
    },
    certain: { type: 'boolean', required: true, description: '判据是否完整（false=有子树读不进去或超扫描预算 ⇒ 不得据此报数）。' },
    markerSync: { type: 'string', required: true, enum: ['none', 'conflict', 'stale'], description: '迁移标记与实际扫描的关系（conflict=标记说完成但磁盘还有平铺）。' },
    fingerprint: { type: 'string', required: true, description: '当前库形态的指纹（含分类）；用于「同一情况不重复问」。' },
    reportTool: { type: 'string', required: true, description: '取只读干跑报告的工具名。' },
    askOnce: { type: 'boolean', required: true, description: 'level=ask 时为 true：服务端已记为「问过一次」，同一 fingerprint 不会再问。' },
    text: { type: 'string', required: true, description: '要原样带给用户的提示文本（silent/info 的「不打扰」情形为空串）。**执行迁移只能在界面**，对话侧没有执行入口。' },
    ask_hint: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true, description: '仅 level=ask 时给出的「怎么问」指令；其余为 null。' },
    error: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true, description: '判据整个跑不了（根读不进去/抛错）时为 scan-failed；此时 level=silent，什么都不该说。' },
  },
  additionalProperties: false,
} as const

/** `text` 非空时把提示追加到工具文本末尾（silent/info 的空文本不追加空行）。 */
const migrationLine = (m: { text?: string } | undefined) => (m?.text ? `\n\n${m.text}` : '')

/** 4 个 source 值的文案（§10.1：不得把 MinerU 结果误报成「本地提取」）。 */
function sourceLabel(source: string): string {
  switch (source) {
    case 'cache': return '缓存复用'
    case 'local': return '本地提取(pdf.js)'
    case 'mineru-local': return '本地 MinerU 解析'
    case 'mineru-cloud': return '云端 MinerU 解析'
    default: return source
  }
}

function producerLabel(producer: string): string {
  switch (producer) {
    case 'pdfjs': return 'pdf.js'
    case 'mineru-local': return '本地 MinerU'
    case 'mineru-cloud': return '云端 MinerU'
    default: return producer
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   agent 侧「文献整理」工具（冻结契约：docs/library-manage-tools-plan.md）

   · 单一 `library_manage` + 7 个 action（建专题 / 收录 / 移动 / 改名 ×2 / 删除 ×2）；
   · 破坏性动作（delete_paper / delete_topic / rename_paper / rename_topic / move_paper）在执行前
     **必须**经 DSH 用户审批（`ctx.approval.request`）拿到 `allowed-once`：其余三态
     （rejected / cancelled / unavailable）一律**零副作用**并返回明确的机器码；
   · 参数里**没有** confirm / confirmName / token / approve 之类的「模型自填确认」——
     用户只能在审批 UI 上点允许，模型在正文里问一句不算确认（§2.7 红线）；
   · 迁移执行**不在**本工具内：action 枚举没有 migrate/rollback/clear_topic，也不 import 迁移执行函数
     （执行入口只在界面，docs/migrate-prompt-plan.md 红线）。
   ═══════════════════════════════════════════════════════════════════════════ */

const MANAGE_ACTIONS = ['create_topic', 'add_paper', 'move_paper', 'rename_paper', 'rename_topic', 'delete_paper', 'delete_topic'] as const
type ManageAction = (typeof MANAGE_ACTIONS)[number]
type ManageLang = 'zh' | 'en'
type ManageField = 'topic' | 'name' | 'new_name' | 'to_topic' | 'source_path'

/** action 级必填（§1.4）：未标 required 的字段一律可选，缺失在 execute 内自查（DSL 只能声明顶层 required）。 */
const MANAGE_REQUIRED: Record<ManageAction, readonly ManageField[]> = {
  create_topic: ['topic'],
  add_paper: ['topic', 'source_path'],
  move_paper: ['topic', 'name', 'to_topic'],
  rename_paper: ['topic', 'name', 'new_name'],
  rename_topic: ['topic', 'new_name'],
  delete_paper: ['topic', 'name'],
  delete_topic: ['topic'],
}

/** 需要用户逐次审批的动作（§2.2）：改/移既有身份或让数据离开可检索位置。 */
const MANAGE_NEEDS_APPROVAL: Record<ManageAction, boolean> = {
  create_topic: false,
  add_paper: false,
  move_paper: true,
  rename_paper: true,
  rename_topic: true,
  delete_paper: true,
  delete_topic: true,
}

const ACTION_LABEL: Record<ManageAction, { zh: string; en: string }> = {
  create_topic: { zh: '创建专题', en: 'create a topic' },
  add_paper: { zh: '收录 PDF', en: 'add a PDF' },
  move_paper: { zh: '移动论文', en: 'move a paper' },
  rename_paper: { zh: '重命名论文', en: 'rename a paper' },
  rename_topic: { zh: '重命名专题', en: 'rename a topic' },
  delete_paper: { zh: '删除论文', en: 'delete a paper' },
  delete_topic: { zh: '删除专题', en: 'delete a topic' },
}

/** en 模式下给既有中文 ManageError 追加的英文要点（§4.1：不谎称已本地化，只补一句映射）。 */
const EN_CODE_HINT: Partial<Record<ManageCode, string>> = {
  'bad-name': 'Invalid name',
  'bad-request': 'Bad request',
  'not-found': 'Topic/paper not found',
  'escape-rejected': 'Path escape rejected',
  'target-exists': 'Target already exists',
  'topic-not-empty': 'Topic not empty',
  'session-unknown': 'Session state unknown',
  'session-running': 'Running reader sessions',
  'translation-busy': 'Translation in progress',
  busy: 'Another operation in progress',
  'file-busy': 'File is busy',
  'trash-move-failed': 'Trash move failed',
  'rename-partial': 'Rename partially failed',
  'legacy-layout': 'Legacy layout; migrate in UI first',
  'source-not-found': 'Source not found',
  'source-invalid': 'Source must be a regular file',
  'source-empty': 'Source is empty',
  'source-not-pdf': 'Source is not a PDF',
  'add-partial': 'Add failed (cleaned up / residue listed)',
  'move-partial': 'Move failed; rollback result',
  'approval-rejected': 'The user rejected this action; nothing changed',
  'approval-cancelled': 'Approval cancelled; nothing changed',
  'approval-unavailable': 'Approval channel unavailable; nothing changed',
}

/** 文案语言（每次调用现读）：DPR_LIBRARY_MANAGE_LANG=en → en，其余 zh（沿用库内先例 promptLang）。 */
function manageLang(): ManageLang {
  return process.env['DPR_LIBRARY_MANAGE_LANG']?.trim() === 'en' ? 'en' : 'zh'
}

/** 工具自己生成的错误：统一 `[library_manage:<code>] ` 前缀（§4.1）。 */
function toolErr(
  code: ManageCode,
  status: number,
  zhText: string,
  enText: string,
  lang: ManageLang,
  extra: Record<string, unknown> = {},
): ManageError {
  return new ManageError(code, status, `[library_manage:${code}] ${lang === 'zh' ? zhText : enText}`, extra)
}

/** 把 dataDir 绝对路径从错误文案里剥掉（S15/F5：错误响应只允许相对 trashRel）。 */
function sanitizeManageError(dataDir: string, err: ManageError): ManageError {
  const message = dataDir ? err.message.split(dataDir).join('<dataDir>') : err.message
  if (message === err.message) return err
  return new ManageError(err.code, err.status, message, err.extra)
}

/** 给库层抛出的 ManageError 加工具前缀（en 模式再补一句英文要点），并脱敏绝对路径。 */
function withToolPrefix(lang: ManageLang, dataDir: string, err: ManageError): ManageError {
  const prefix = `[library_manage:${err.code}] `
  if (err.message.startsWith(prefix)) return sanitizeManageError(dataDir, err)
  const hint = lang === 'en' ? ` (en: ${EN_CODE_HINT[err.code] ?? err.code})` : ''
  return sanitizeManageError(dataDir, new ManageError(err.code, err.status, prefix + err.message + hint, err.extra))
}

function normalizeManageAction(raw: unknown, lang: ManageLang): ManageAction {
  if (typeof raw === 'string' && (MANAGE_ACTIONS as readonly string[]).includes(raw)) return raw as ManageAction
  throw toolErr('bad-request', 400,
    `action 必须是 ${MANAGE_ACTIONS.join(' / ')} 之一（迁移执行不在本工具内）`,
    `action must be one of ${MANAGE_ACTIONS.join(' / ')} (migration execution is not exposed here)`,
    lang)
}

function requireManageFields(action: ManageAction, args: Record<string, unknown>, lang: ManageLang): void {
  for (const f of MANAGE_REQUIRED[action]) {
    const v = args[f]
    if (typeof v !== 'string' || v.trim() === '') {
      throw toolErr('bad-request', 400,
        `${action} 缺少必填参数 ${f}（字符串）`,
        `${action} requires the ${f} parameter (string)`,
        lang)
    }
  }
}

interface ManageSummaryInput {
  action: ManageAction
  topic: string
  name?: string
  newName?: string
  toTopic?: string
  created?: boolean
  bytes?: number
  fileCount?: number
  totalBytes?: number
  trashRel?: string | null
  detached?: number
  sourceName?: string
  hiddenCount?: number
}

/** summary / render 同源（§1.5）：zh 默认，DPR_LIBRARY_MANAGE_LANG=en 切 en。 */
function formatSummary(lang: ManageLang, s: ManageSummaryInput): string {
  const zh = lang === 'zh'
  switch (s.action) {
    case 'create_topic':
      if (s.created) {
        return zh
          ? `已创建专题：${s.topic}（空专题；可用 add_paper 收录 PDF）`
          : `Topic created: ${s.topic} (empty; use add_paper to add PDFs)`
      }
      return zh ? `专题已存在：${s.topic}（未做任何改动）` : `Topic already exists: ${s.topic} (nothing changed)`
    case 'add_paper':
      return zh
        ? `已收录《${s.topic}/${s.name}》：${s.bytes} 字节，源文件 ${s.sourceName} 未被移动或删除`
        : `Added ${s.topic}/${s.name}: ${s.bytes} bytes; source ${s.sourceName} left untouched`
    case 'move_paper':
      return zh
        ? `已移动《${s.topic}/${s.name}》→《${s.toTopic}/${s.name}》：${s.fileCount} 个产物随论文文件夹整体移动，内容未改；${s.detached} 个伴读会话不再自动挂到新路径`
        : `Moved ${s.topic}/${s.name} → ${s.toTopic}/${s.name}: ${s.fileCount} artifacts moved with the paper folder, contents unchanged; ${s.detached} reader sessions no longer bind to the new path`
    case 'rename_paper':
      return zh
        ? `已重命名《${s.topic}/${s.name}》→《${s.topic}/${s.newName}》：${s.fileCount} 个文件同步改名；${s.detached} 个伴读会话不再自动挂到新路径`
        : `Renamed ${s.topic}/${s.name} → ${s.topic}/${s.newName}: ${s.fileCount} files renamed; ${s.detached} reader sessions no longer bind to the new path`
    case 'rename_topic':
      return zh
        ? `已重命名专题《${s.topic}》→《${s.newName}》：目录整体移动；${s.detached} 个伴读会话不再自动挂到新路径`
        : `Renamed topic ${s.topic} → ${s.newName}: directory moved; ${s.detached} reader sessions no longer bind to the new path`
    case 'delete_paper':
      return zh
        ? `已删除《${s.topic}/${s.name}》→ 回收站 ${s.trashRel}（${s.fileCount} 个文件，${s.totalBytes} 字节；按相对路径可手工移回恢复）`
        : `Deleted ${s.topic}/${s.name} → trash ${s.trashRel} (${s.fileCount} files, ${s.totalBytes} bytes; recover manually by moving them back)`
    case 'delete_topic':
      if (s.trashRel) {
        return zh
          ? `已删除空专题《${s.topic}》→ 回收站 ${s.trashRel}（隐藏条目已移入，可恢复）`
          : `Deleted empty topic ${s.topic} → trash ${s.trashRel} (hidden entries preserved)`
      }
      return zh
        ? `已删除空专题《${s.topic}》（无隐藏条目，未创建回收站目录）`
        : `Deleted empty topic ${s.topic} (no hidden entries; no trash bundle created)`
    default: {
      const never: never = s.action
      throw new Error(`未知 action: ${String(never)}`)
    }
  }
}

/* ── 审批门（§2）：只认 allowed-once；无服务/无 agent/无 answerer 一律 fail closed ────────── */

type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
const APPROVAL_OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const

/**
 * 本地**结构化**类型（不 import @deepseek-ai/dsh-user-approval、不新增依赖、不改 inject）：
 * 与官方 dsh-sandbox 的 minimal structural shape 同一取向；`ctx.get('approval')` 运行时可选读取。
 * `displayReason` 只在 0.2.x 的 ApprovalRequestEvent 上存在（本插件 devDep 0.1.5 类型没有它），
 * 这里作为可选字段透传：新版审批 UI 拿得到，旧版忽略，不靠它做任何判断。
 */
interface ApprovalRequestLike {
  agent: unknown
  toolName: string
  callId?: unknown
  reason: string
  displayReason?: string
  signal?: AbortSignal
}
interface ApprovalAsk {
  request(req: ApprovalRequestLike): Promise<ApprovalOutcome>
}

function approvalError(
  lang: ManageLang,
  kind: 'rejected' | 'cancelled' | 'unavailable',
  action: ManageAction,
): ManageError {
  const label = ACTION_LABEL[action]
  const code: ManageCode = kind === 'rejected' ? 'approval-rejected' : kind === 'cancelled' ? 'approval-cancelled' : 'approval-unavailable'
  const status = kind === 'rejected' ? 403 : kind === 'cancelled' ? 409 : 503
  const zhText = kind === 'rejected'
    ? `用户拒绝了本次${label.zh}；未做任何改动。请如实告知用户，不要重试或绕过。`
    : kind === 'cancelled'
      ? '审批被取消；未做任何改动。'
      : '审批通道不可用（无审批服务 / 无 agent / 无 answerer），已拒绝执行；未做任何改动。'
  const enText = kind === 'rejected'
    ? `The user rejected this ${label.en}; nothing changed. Tell the user honestly; do not retry or bypass the approval.`
    : kind === 'cancelled'
      ? 'Approval cancelled; nothing changed.'
      : 'Approval channel unavailable (no approval service / no agent / no answerer); nothing changed.'
  return toolErr(code, status, zhText, enText, lang)
}

function signalAborted(exec: { signal?: AbortSignal } | undefined): boolean {
  return exec?.signal?.aborted === true
}

/**
 * 审批（§2.3 冻结顺序）：已取消 → 不打扰；无服务/无 agent → 拒绝；request 抛错或闭集外的值 →
 * 按「通道不可用」拒绝；只有 `allowed-once` 才继续。**绝不**「先做后问」。
 */
async function requestManageApproval(opts: {
  ctx: Context
  exec: { agent?: unknown; callId?: unknown; signal?: AbortSignal } | undefined
  lang: ManageLang
  action: ManageAction
  reason: string
}): Promise<void> {
  const { ctx, exec, lang, action, reason } = opts
  // 只允许「需要审批」的动作走到这里（§2.2 的表格是唯一事实源；将来新增动作忘了分档会在这里炸）
  if (!MANAGE_NEEDS_APPROVAL[action]) {
    throw toolErr('bad-request', 400,
      `${action} 不需要审批，不应调用审批门（实现错误）`,
      `${action} does not require approval; the approval gate must not be called (implementation bug)`,
      lang)
  }
  if (signalAborted(exec)) throw approvalError(lang, 'cancelled', action)
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  const svc = typeof get === 'function' ? (get.call(ctx, 'approval') as ApprovalAsk | undefined) : undefined
  if (!svc || typeof svc.request !== 'function') throw approvalError(lang, 'unavailable', action)
  if (!exec?.agent) throw approvalError(lang, 'unavailable', action)
  let outcome: unknown
  try {
    outcome = await svc.request({
      agent: exec.agent,
      toolName: 'library_manage',
      ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
      reason,
      displayReason: reason,
      ...(exec.signal ? { signal: exec.signal } : {}),
    })
  } catch {
    // 无 open turn / 审计写失败 / answerer 抛错 ⇒ 通道不可用（绝不当成允许）
    throw approvalError(lang, 'unavailable', action)
  }
  if (typeof outcome !== 'string' || !(APPROVAL_OUTCOMES as readonly string[]).includes(outcome)) {
    throw approvalError(lang, 'unavailable', action)
  }
  if (outcome !== 'allowed-once') {
    throw approvalError(lang, outcome as 'rejected' | 'cancelled' | 'unavailable', action)
  }
  // 批准之后、第一次写盘之前再查一次取消（取消 = 零副作用）
  if (signalAborted(exec)) throw approvalError(lang, 'cancelled', action)
}

/** 审批 reason：双语单串（§2.4），审批弹窗由用户看，不随 DPR_LIBRARY_MANAGE_LANG 变。 */
function approvalReason(
  action: ManageAction,
  d: { topic: string; name?: string; newName?: string; toTopic?: string; fileCount?: number; totalBytes?: number; hiddenCount?: number },
): string {
  const target = d.name ? `${d.topic}/${d.name}` : d.topic
  let detail: string
  switch (action) {
    case 'delete_paper':
      detail = `${d.fileCount ?? 0} 个文件（${d.totalBytes ?? 0} 字节）→ 回收站 .trash`
      break
    case 'delete_topic':
      detail = `空专题；${d.hiddenCount ?? 0} 个隐藏条目 → 回收站`
      break
    case 'rename_paper':
      detail = `${d.name} → ${d.newName}（${d.fileCount ?? 0} 个文件同步改名）`
      break
    case 'rename_topic':
      detail = `${d.topic} → ${d.newName}（整棵子树）`
      break
    case 'move_paper':
      detail = `${d.topic} → ${d.toTopic}（论文文件夹整体移动）`
      break
    default:
      detail = ''
  }
  return `【文献整理 / Library manage】${action}：《${target}》${detail}。仅本次调用有效 / one-shot；`
    + '未获批准不会改动任何文件。 / Nothing changes unless you allow this one call.'
}

/** 翻译在途前置（沿用 host 的 zhStatus 口径：正在生成译文就拒绝，避免改/移正在写的产物）。 */
function assertTranslationIdle(lang: ManageLang, refs: PaperRef[]): void {
  for (const ref of refs) {
    if (!zhStatus(ref).busy) continue
    throw toolErr('translation-busy', 409,
      '该文献（或该专题内某篇文献）正在生成译文，请等待完成后再操作',
      'A paper in scope is generating a translation; retry after it finishes',
      lang)
  }
}

export function registerTools(ctx: Context, config: PluginConfig, guards?: LibraryGuards) {
  const dataDir = resolveDataDir(config.dataDir)
  // 破坏性操作的共用前置（会话准入 / 在途锁 / 缓存钩子）：与 host 路由**共用同一个实例**
  // （src/index.ts 显式创建并双传）。第三参缺省时自建一个，只服务既有测试（不传 = 不共享）。
  const g = guards ?? createLibraryGuards(dataDir)
  const shortlistSize = resolveShortlistSize(config.typesafe)

  ctx.tools.register(defineTool({
    name: 'list_papers',
    description:
      '列出文献库里的专题和文献。当用户提到某篇论文但你不知道它是否在库中、或用户问"我有哪些论文"时使用。',
    parameters: {
      topic: { type: 'string', description: '只看某个专题；省略则列出全部。' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          dataDir: { type: 'string', required: true, description: '文献库根目录。' },
          topics: {
            type: 'array',
            required: true,
            items: { type: 'string' },
            description: '专题列表。',
          },
          papers: {
            type: 'array',
            required: true,
            items: { type: 'string', description: '形如 专题/文献名' },
            description: '文献列表。',
          },
          migration: migrationSchema,
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: (value.papers.length === 0
            ? `文献库为空（${value.dataDir}）。把 PDF 放进 <专题>/ 目录即可。`
            : `文献库（${value.dataDir}）：\n${value.papers.map((p) => `- ${p}`).join('\n')}`)
            // 提示只**追加**在末尾：绝不改 papers/tree 的内容与顺序，也不影响任何既有行为（红线③）
            + migrationLine(value.migration),
        },
      ],
    },
    execute: async (args) => {
      const papers = listPapers(dataDir, args.topic).map((p) => `${p.topic}/${p.name}`)
      return { dataDir, topics: listTopics(dataDir), papers, migration: migrationField(dataDir) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'transcribe_pdf',
    description:
      '把一篇 PDF 论文转录为纯文本（默认本地 pdf.js 提取，带页码索引），结果落盘缓存。' +
      '可指定 source=mineru-local/mineru-cloud 改走 MinerU 解析后端（本地/云端，适合扫描件）。' +
      '读一篇新论文的第一步：先转录，再用 search_paper 检索。已有缓存时秒回。',
    parameters: {
      ...locateParams,
      force: { type: 'boolean', description: '忽略缓存重新转录。' },
      source: {
        type: 'string',
        enum: ['auto', 'pdfjs', 'mineru-local', 'mineru-cloud'],
        description:
          '解析来源：auto=有缓存复用、无缓存按配置（默认 pdfjs）；pdfjs=本地 pdf.js 文本层；' +
          'mineru-local=本地 MinerU API；mineru-cloud=mineru.net v4 云端。',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          paper: { type: 'string', required: true },
          txtPath: { type: 'string', required: true, description: '转录文本路径。' },
          chars: { type: 'integer', required: true },
          pageCount: { type: 'integer', required: true },
          hasPageIndex: { type: 'boolean', required: true, description: '是否有页码索引（检索结果能否带页码）。' },
          source: { type: 'string', required: true, enum: ['cache', 'local', 'mineru-local', 'mineru-cloud'] },
          producer: {
            type: 'string',
            required: true,
            enum: ['legacy', 'pdfjs', 'mineru-local', 'mineru-cloud'],
            description: '产出这份文本的引擎；legacy=旧缓存（缺来源标记，等价 pdfjs）。',
          },
          backend: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            required: true,
            description: '实际 MinerU backend（本地）或 modelVersion（云端）；非 MinerU 为 null。',
          },
          readerUrl: readerUrlSchema,
          migration: migrationSchema,
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `已转录《${value.paper}》：${value.chars} 字符，${value.pageCount} 页` +
            `（${sourceLabel(value.source)}${value.hasPageIndex ? '，含页码索引' : '，无页码索引'}）。` +
            (value.source !== 'cache' && value.producer !== 'pdfjs' && value.producer !== 'legacy'
              ? ` 引擎：${producerLabel(value.producer)}${value.backend ? `（${value.backend}）` : ''}。`
              : '') +
            `接下来可用 search_paper 检索具体内容。` +
            readerUrlLine(value.readerUrl) +
            migrationLine(value.migration),
        },
      ],
    },
    execute: async (args, exec) => {
      const ref = locate(dataDir, args, exec)
      const mineru = await resolveMineruConfig(config.mineru)
      const t = await transcribePaper(ref, { force: args.force === true, source: sourceArg(args.source), mineru })
      return {
        paper: `${ref.topic}/${ref.name}`,
        txtPath: ref.txtPath,
        chars: t.chars,
        pageCount: t.pageCount,
        hasPageIndex: t.pages.length > 0,
        source: t.source,
        producer: t.producer,
        backend: t.backend,
        readerUrl: readerUrl(ref),
        // 次入口：覆盖「打开/读某篇论文」这条路径（同一次扫描，走缓存；ask 仍由服务端写 asked）
        migration: migrationField(dataDir),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'search_paper',
    description:
      '在论文全文中按关键词检索相关片段，返回带页码的原文片段。' +
      '当需要论文的具体内容（定义、算法步骤、章节细节、数据）时使用，基于检索到的原文回答并注明页码。' +
      '关键词建议：用论文中的英文术语、章节号（如 "Section 3.1"）或概念名，不要用完整长句；找不到时换同义词或更短的词重试。' +
      '论文未转录时会自动先转录。' +
      '（配置了嵌入端点时额外做语义召回；未配置则纯关键词，与改造前一致）',
    parameters: {
      query: { type: 'string', required: true, description: '检索关键词，如 "backup task" 或 "locality"。' },
      k: { type: 'integer', description: '返回片段数量，默认 5，最多 8。' },
      ...locateParams,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          paper: { type: 'string', required: true },
          query: { type: 'string', required: true },
          totalChunks: { type: 'integer', required: true },
          reranked: {
            type: 'boolean',
            required: true,
            description: '返回片段是否经过语义重排（配置了 Jev/TypeSafe 凭据且候选充足时为 true）。',
          },
          compactQuery: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            required: true,
            description:
              '查询侧 LaTeX 紧凑写法（MinerU 来源论文才会一并匹配，如 Q_{t} → Q_t）；无需归一化时为 null。',
          },
          embedding: {
            type: 'object',
            required: true,
            description: '嵌入语义召回的状态：未配置时 configured=false 且不影响结果；降级时 degraded 给出原因。',
            properties: {
              configured: { type: 'boolean', required: true },
              used: { type: 'boolean', required: true },
              fromCache: { type: 'boolean', required: true },
              degraded: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
            },
            additionalProperties: false,
          },
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                chunk: { type: 'integer', required: true },
                page: {
                  oneOf: [{ type: 'integer' }, { type: 'null' }],
                  required: true,
                  description: '片段起始页码；无页码索引时为 null。',
                },
                text: { type: 'string', required: true },
              },
              additionalProperties: false,
            },
          },
          readerUrl: readerUrlSchema,
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const notes: string[] = []
        if (value.compactQuery) {
          notes.push(`（查询已按紧凑写法 \`${value.compactQuery}\` 一并匹配；原查询保留）`)
        }
        if (value.embedding.degraded) {
          notes.push(`（嵌入检索不可用，已降级为纯关键词：${value.embedding.degraded}）`)
        } else if (value.embedding.configured && value.embedding.used) {
          notes.push(value.embedding.fromCache ? '（含嵌入语义召回；分块向量命中缓存）' : '（含嵌入语义召回）')
        }
        return [
          {
            type: 'text',
            text:
              formatHits(
                value.hits.map((h) => ({
                  chunk: { index: h.chunk, start: 0, end: 0, text: h.text },
                  score: 0,
                  page: h.page,
                })),
                value.totalChunks,
                value.query,
              ) +
              (notes.length ? '\n' + notes.join('\n') : '') +
              readerUrlLine(value.readerUrl),
          },
        ]
      },
    },
    execute: async (args, exec) => {
      const ref = locate(dataDir, args, exec)
      let cached = await readTranscript(ref)
      if (!cached) {
        const mineru = await resolveMineruConfig(config.mineru)
        await transcribePaper(ref, { source: 'auto', mineru })
        cached = await readTranscript(ref)
      }
      if (!cached) throw new Error('转录失败，无法检索')
      const chunks = chunkText(cached.text, 1500)
      const k = Math.max(1, Math.min(args.k ?? 5, 8))
      // 折叠项 1（查询侧 LaTeX 归一化）：投影侧只对 MinerU 产物做紧凑写法归一化，
      // 因此查询侧的同名变体也**只对 MinerU 来源的论文**追加；原查询永远保留 →
      // pdfjs/旧缓存论文既不丢命中也不引入新行为（与改造前逐字节一致）。
      const producer = (await readTranscriptMeta(ref))?.producer ?? null
      const variants = queryVariantsFor(producer, args.query)
      const compact = variants.length > 1 ? variants[1]! : null
      // 关键词快搜捞 shortlist（宽召回）→ 可选语义召回 → 既有重排 → top-k。
      // 凭据每次现查（设置面板保存即生效）；未配置时三段都退回纯关键词，行为与改造前一致。
      const rerankClient = await resolveRerankClient(config.typesafe)
      const embedCfg = await resolveEmbedConfig(config.embed)
      const wideRecall = Boolean(rerankClient) || embedCfg.enabled
      const recallSize = wideRecall ? Math.max(k, shortlistSize) : k
      let hits = searchChunksMulti(chunks, cached.pages, variants, recallSize)
      // 嵌入召回：惰性（首次检索该论文才算）+ 缓存（<论文>.embeddings.json）；失败只影响本次召回。
      const embedding = await embeddingRecallFor({
        configured: embedCfg.enabled,
        cachePath: embeddingsPathFor(ref.txtPath),
        chunks,
        pages: cached.pages,
        query: args.query,
        chunkSize: 1500,
        limit: embedCfg.cfg.candidateSize ?? EMBED_DEFAULTS.candidateSize,
        ...(embedCfg.enabled
          ? {
              req: {
                baseUrl: embedCfg.cfg.baseUrl!,
                apiKey: embedCfg.cfg.apiKey!,
                model: embedCfg.cfg.model!,
                ...(embedCfg.cfg.timeoutMs !== undefined ? { timeoutMs: embedCfg.cfg.timeoutMs } : {}),
              },
              ...(embedCfg.cfg.batchSize !== undefined ? { batchSize: embedCfg.cfg.batchSize } : {}),
            }
          : {}),
      })
      if (embedding.hits.length > 0) hits = fuseHybridCandidates(hits, embedding.hits, recallSize)
      if (!wideRecall) hits = hits.slice(0, k)
      if (embedding.degraded) {
        console.warn('[dsh-paper-reader] 嵌入检索降级为纯关键词:', embedding.degraded)
      }
      let reranked = false
      if (rerankClient && hits.length > k) {
        try {
          hits = await rerankHits(rerankClient, args.query, hits, k, config.typesafe?.deadlineMs ?? 1500)
          reranked = true
        } catch (e) {
          // 超预算/网络/鉴权任何失败都退回关键词 top-k（结果已算好，零成本降级）
          console.warn('[dsh-paper-reader] 检索重排失败，退回关键词排序:', e)
          hits = hits.slice(0, k)
        }
      }
      if (!reranked) hits = hits.slice(0, k)
      return {
        paper: `${ref.topic}/${ref.name}`,
        query: args.query,
        totalChunks: chunks.length,
        hits: hits.map((h) => ({ chunk: h.chunk.index, page: h.page, text: h.chunk.text })),
        reranked,
        compactQuery: compact,
        embedding: {
          configured: embedding.configured,
          used: embedding.used,
          fromCache: embedding.fromCache,
          degraded: embedding.degraded,
        },
        readerUrl: readerUrl(ref),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'study_progress',
    description:
      '读取一篇论文的学习档案：分步阅读计划（每步状态）和历次检验成绩。' +
      '开始伴读、或用户想继续学习/查看进度时先调用；没有记录时返回空，此时应制定计划（study_update 的 set_plan）。',
    parameters: { ...locateParams },
    output: {
      schema: {
        type: 'object',
        properties: {
          paper: { type: 'string', required: true },
          hasRecord: { type: 'boolean', required: true },
          plan: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                id: { type: 'integer', required: true },
                title: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ['pending', 'current', 'done'] },
                note: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          quizzes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                time: { type: 'string', required: true },
                score: { type: 'integer', required: true },
                total: { type: 'integer', required: true },
                summary: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          readerUrl: readerUrlSchema,
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `《${value.paper}》学习档案：\n` + formatStudy(
            value.hasRecord ? { paper: value.paper, plan: value.plan, quizzes: value.quizzes } : null,
          ) + readerUrlLine(value.readerUrl),
        },
      ],
    },
    execute: async (args, exec) => {
      const ref = locate(dataDir, args, exec)
      const record = await readStudy(ref)
      return {
        paper: `${ref.topic}/${ref.name}`,
        hasRecord: record !== null,
        plan: record?.plan ?? [],
        quizzes: record?.quizzes ?? [],
        readerUrl: readerUrl(ref),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'study_update',
    description:
      '更新一篇论文的学习档案（老师用）：' +
      'set_plan=制定阅读计划（steps 为 3~6 个分步标题，会重置计划但保留历史成绩）；' +
      'complete_step=学生完成某一步（step_id + 可选 note 点评，自动推进到下一步）；' +
      'record_quiz=记录一次检验成绩（score/total + 可选 summary 薄弱点小结）。',
    parameters: {
      action: { type: 'string', required: true, enum: ['set_plan', 'complete_step', 'record_quiz'] },
      steps: { type: 'array', items: { type: 'string' }, description: 'set_plan 用：分步标题列表，如 "读摘要与引言（第 1 页），说出论文要解决的问题"。' },
      step_id: { type: 'integer', description: 'complete_step 用：完成的步骤号。' },
      note: { type: 'string', description: 'complete_step 用：对学生这一步表现的点评。' },
      score: { type: 'integer', description: 'record_quiz 用：得分。' },
      total: { type: 'integer', description: 'record_quiz 用：满分。' },
      summary: { type: 'string', description: 'record_quiz 用：本次检验小结（考点/薄弱点）。' },
      ...locateParams,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          paper: { type: 'string', required: true },
          summary: { type: 'string', required: true, description: '更新后的档案摘要。' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `《${value.paper}》档案已更新：\n${value.summary}` }],
    },
    execute: async (args, exec) => {
      const ref = locate(dataDir, args, exec)
      let record
      if (args.action === 'set_plan') {
        if (!args.steps?.length) throw new Error('set_plan 需要 steps')
        record = await setPlan(ref, args.steps)
      } else if (args.action === 'complete_step') {
        if (!args.step_id) throw new Error('complete_step 需要 step_id')
        record = await completeStep(ref, args.step_id, args.note)
      } else {
        if (args.score === undefined || args.total === undefined) throw new Error('record_quiz 需要 score 和 total')
        record = await recordQuiz(ref, args.score, args.total, args.summary)
      }
      return { paper: `${ref.topic}/${ref.name}`, summary: formatStudy(record) }
    },
  }))

  /* ── 只读干跑报告（§2.4）：用户答「要」之后给报告；**没有任何执行路径** ─────────────────────
     执行唯一入口在界面（设置 → 论文伴读 → 查看论文状态，在逐篇状态面板里读完警示点一次「确认迁移」）或 CLI --apply --yes。
     本工具连 `runMigration` 都不 import ⇒ 「改回缺陷态」的变异（M5）必然让 P16 变红。 */
  // ⚠️ dsh-tools 的 value schema DSL 不支持 `oneOf` 成员对象上的 `required: true`
  //（`oneOf[0].required is not supported`）⇒ needSchema 本体不带 required，由外层属性声明需求。
  const needSchema = {
    type: 'object',
    properties: {
      state: { type: 'string', required: true }, dataDirId: { type: 'string', required: true },
      papers: { type: 'integer', required: true },
      files: { type: 'integer', required: true }, migratable: { type: 'integer', required: true },
      orphans: { type: 'integer', required: true }, paperDirs: { type: 'integer', required: true },
      certain: { type: 'boolean', required: true },
      markerSync: { type: 'string', required: true, enum: ['none', 'conflict', 'stale'] },
      fingerprint: { type: 'string', required: true },
      byClass: {
        type: 'object', required: true,
        properties: {
          flat: { type: 'integer', required: true }, residue: { type: 'integer', required: true },
          conflict: { type: 'integer', required: true }, quarantine: { type: 'integer', required: true },
        },
        additionalProperties: false,
      },
      markers: {
        type: 'object', required: true,
        properties: { done: { type: 'boolean', required: true }, partial: { type: 'boolean', required: true } },
        additionalProperties: false,
      },
      unreadable: {
        type: 'array', required: true,
        items: {
          type: 'object',
          properties: { dir: { type: 'string', required: true }, cause: { type: 'string', required: true } },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  } as const

  ctx.tools.register(defineTool({
    name: 'migration_report',
    description:
      '只读干跑报告：扫描文献库并列出「旧（平铺）→ 按论文分文件夹」需要收口的论文/文件、' +
      '冲突与跳过项、读不进去的子树。' +
      '**除「确保数据目录存在」外不修改任何文件，也绝不执行迁移**（干跑走的是迁移预检的同一套只读遍历）；' +
      '执行只能在阅读器/设置面板里由用户确认（「查看论文状态」面板内警示后点一次「确认迁移」）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          dataDir: { type: 'string', required: true },
          report: { type: 'string', required: true, description: '人类可读干跑报告（超过 8000 字符时截断，truncated=true）。' },
          truncated: { type: 'boolean', required: true },
          need: { oneOf: [needSchema, { type: 'null' }], required: true, description: '判据结果；读不到库时为 null。' },
          plan: {
            oneOf: [
              {
                type: 'object',
                properties: {
                  moves: { type: 'integer', required: true },
                  alreadyDone: { type: 'integer', required: true },
                  orphans: { type: 'integer', required: true },
                  totals: {
                    type: 'object', required: true,
                    properties: {
                      papers: { type: 'integer', required: true }, files: { type: 'integer', required: true },
                      bytes: { type: 'integer', required: true }, needBytes: { type: 'integer', required: true },
                    },
                    additionalProperties: false,
                  },
                  conflicts: {
                    type: 'array', required: true,
                    items: {
                      type: 'object',
                      properties: { paper: { type: 'string', required: true }, target: { type: 'string', required: true }, reason: { type: 'string', required: true } },
                      additionalProperties: false,
                    },
                  },
                  quarantine: {
                    type: 'array', required: true,
                    items: {
                      type: 'object',
                      properties: { paper: { type: 'string', required: true }, reason: { type: 'string', required: true } },
                      additionalProperties: false,
                    },
                  },
                  unreadable: {
                    type: 'array', required: true,
                    items: {
                      type: 'object',
                      properties: { dir: { type: 'string', required: true }, cause: { type: 'string', required: true } },
                      additionalProperties: false,
                    },
                  },
                },
                additionalProperties: false,
              },
              { type: 'null' },
            ],
            required: true,
          },
          error: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true, description: '读库失败原因（未做任何改动）。' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (!value.ok) {
          return [{ type: 'text', text: `无法读取文献库：${value.error ?? '未知原因'}（未做任何改动）` }]
        }
        return [{
          type: 'text',
          text: value.report + (value.truncated ? '\n（已截断；完整只读报告见 CLI：node dist/migrate.js --data-dir <库>，默认只跑干跑）' : '') +
            '\n以上为只读报告，未改动任何文件。执行入口：设置 → 论文伴读 → 查看论文状态（在警示后点一次「确认迁移」）；我不会自动执行。',
        }]
      },
    },
    execute: async () => {
      try {
        const plan = planMigration(dataDir)
        const report = formatMigrationReport(plan)
        const truncated = report.length > MIGRATION_REPORT_LIMIT
        return {
          ok: true,
          dataDir,
          report: truncated ? report.slice(0, MIGRATION_REPORT_LIMIT) : report,
          truncated,
          need: detectMigrationNeed(dataDir, { force: true }),
          plan: {
            moves: plan.moves.length,
            alreadyDone: plan.alreadyDone.length,
            orphans: plan.orphans.length,
            totals: plan.totals,
            conflicts: plan.conflicts,
            quarantine: plan.quarantine,
            unreadable: plan.unreadable,
          },
          error: null,
        }
      } catch (err) {
        return {
          ok: false, dataDir, report: '', truncated: false, need: null, plan: null,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    },
  }))

  /* ── 只写偏好（§2.4）：**绝不迁移任何文件、不读库内容**（除非重算指纹需要扫目录，见下） ── */
  ctx.tools.register(defineTool({
    name: 'migration_prompt_choice',
    description:
      '记录用户对「是否迁移文献库布局」的回答。**只写提示偏好，绝不迁移任何文件**。' +
      '仅在用户明确回答后调用：later=以后再说（库变化时可再问一次）；declined=不再提醒（除「重新检查」外永不问）；' +
      'recheck=重新检查（清掉之前的回答，允许再问一次）。',
    parameters: {
      choice: { type: 'string', required: true, enum: ['later', 'declined', 'recheck'], description: '用户的回答。' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          choice: { type: 'string', required: true, enum: ['idle', 'asked', 'later', 'declined'] },
          willAsk: { type: 'boolean', required: true, description: '之后是否还可能主动问一次（declined=false，其余=true）。' },
          note: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.note }],
    },
    execute: async (args) => {
      if (args.choice === 'recheck') {
        const state = resetPromptState()
        return { ok: true, choice: state.choice, willAsk: true, note: '已重新检查：下次若库里仍有旧布局，会再提示一次（仍然只提示，不会自动迁移）。' }
      }
      // 指纹要跟着写：`later` 的语义是「同一情况不再问、库变了可以再问」——不写指纹就会立刻再问一次
      const need = detectMigrationNeed(dataDir)
      const written = writePromptState({
        choice: args.choice,
        at: new Date().toISOString(),
        by: 'tool',
        declaredPapers: need.papers,
        fingerprint: need.fingerprint,
        // 记下这条回答是针对**哪个库**的（t6 队长裁定 (b)：换库要重新问一次）
        dataDir: need.dataDirId,
      })
      const payload = promptStatePayload(written.state)
      return {
        ok: written.ok,
        choice: payload.choice,
        willAsk: args.choice !== 'declined',
        note: args.choice === 'declined'
          ? '已记录「不再提醒」：之后不会再主动问（设置 → 论文伴读 → 重新检查 可以恢复）。'
          : '已记录「以后再说」：同一情况不会再问；若库有变化会再提示一次。',
      }
    },
  }))

  /* ── 文献整理（agent 侧写操作；破坏性动作逐次经 DSH 用户审批）─────────────────────────
     契约：docs/library-manage-tools-plan.md §1（工具面）/§2（审批门）/§3（复用）/§4（拒绝码）。
     · 校验顺序**冻结**：参数 → 词法 → 存在性/冲突（只读）→ 在途锁 → 会话/翻译 → 审批 → 执行；
     · 写动作**不复用** locate() 的「按会话反解当前论文」回退：审批 reason 必须指名道姓，
       模型省略参数时由服务端猜目标违背最小惊讶（§1.6）。
     · 迁移执行不在本工具内（红线）：action 枚举没有 migrate*，也不 import 迁移执行函数。 */
  const libraryManageTool = defineTool({
    name: 'library_manage',
    description:
      '整理文献库。action 必填：create_topic=新建专题；add_paper=把本地 PDF 收进专题；' +
      'move_paper=把一篇论文移到另一个专题；rename_paper=改论文名；rename_topic=改专题名/移动专题；' +
      'delete_paper=删除论文（移入回收站，可手工恢复）；delete_topic=删除空专题（非空请逐篇删除）。' +
      'delete/rename/move 必须由用户在 DSH 审批 UI 上逐次允许（ctx.approval），没有 confirm 参数；' +
      '被拒绝/取消/审批通道不可用时不改动任何文件。迁移执行不在本工具内（只能在界面由用户确认）。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [...MANAGE_ACTIONS],
        description: '要执行的整理动作。delete_paper/delete_topic/rename_paper/rename_topic/move_paper 需要用户在 DSH 审批 UI 上逐次允许；create_topic/add_paper 不需要审批。',
      },
      topic: {
        type: 'string',
        description: '专题路径（相对文献库根，可多级如 A/B）。create_topic/add_paper/delete_topic 用目标专题；rename_paper/delete_paper 用文献所在专题；move_paper/rename_topic 用源专题。',
      },
      name: {
        type: 'string',
        description: '文献名（不带 .pdf）。delete_paper/rename_paper/move_paper 必填；add_paper 可省略（默认取 source_path 的文件名；若文件名以 .pdf 结尾则去掉，大小写不敏感）。',
      },
      new_name: {
        type: 'string',
        description: 'rename_paper/rename_topic 的新名字（论文名不带 .pdf；专题可多级路径）。',
      },
      to_topic: {
        type: 'string',
        description: 'move_paper 的目标专题路径。必须已存在（不存在请先 create_topic）。',
      },
      source_path: {
        type: 'string',
        description: 'add_paper 的源 PDF 绝对路径。必须是常规文件（不接受符号链接/目录）、内容含 %PDF- 头、非空；源文件只读，不会被移动或删除。',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true, enum: [...MANAGE_ACTIONS] },
          topic: { type: 'string', required: true, description: '动作完成后的专题路径（delete_topic 为被删专题；其余为目标/所在专题）。' },
          name: { type: 'string', description: '文献名（论文级动作）。' },
          new_name: { type: 'string', description: 'rename_* 完成后的新名字。' },
          to_topic: { type: 'string', description: 'move_paper 的目标专题。' },
          created: { type: 'boolean', description: 'create_topic：true=本次创建，false=已存在（幂等，无改动）。' },
          bytes: { type: 'integer', description: 'add_paper：写入的字节数。' },
          files: { type: 'array', required: true, items: { type: 'string' }, description: '受影响的文件名（不含目录）；create_topic/rename_topic 为空数组。' },
          trashDir: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true, description: '删除动作的回收站绝对路径（恢复线索）；非删除或无隐藏条目时为 null。' },
          trashRel: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true, description: '回收站相对 dataDir 的路径（恢复线索；不含服务端绝对路径）。' },
          approval: { type: 'string', required: true, enum: ['not-required', 'allowed-once'], description: '本次是否经过用户审批：add/create=not-required；其余=allowed-once。' },
          detachedSessions: { type: 'integer', required: true, description: '因改名/移动/删除而不再自动挂到该路径的伴读会话数（只读统计，不删历史）。' },
          summary: { type: 'string', required: true, description: '人类可读摘要（与 render 文本同源）。' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    execute: async (args, exec) => {
      const lang = manageLang()
      try {
        const action = normalizeManageAction(args.action, lang)
        requireManageFields(action, args as Record<string, unknown>, lang)
        // 已取消的调用不写任何字节（审批动作在 requestManageApproval 里还会再查一次）
        if (signalAborted(exec)) throw approvalError(lang, 'cancelled', action)
        switch (action) {
          case 'create_topic': {
            const topic = validateTopicPath(args.topic, false)
            const r = await g.runExclusive([g.topicKey(topic)], () => createTopic(dataDir, topic))
            invalidateMigrationPromptCache(dataDir)
            const summary = formatSummary(lang, { action, topic: r.topic, created: r.created })
            return {
              ok: true, action, topic: r.topic, created: r.created, files: [],
              trashDir: null, trashRel: null, approval: 'not-required' as const,
              detachedSessions: 0, summary,
            }
          }
          case 'add_paper': {
            const topic = validateTopicPath(args.topic, false)
            const sourcePath = String(args.source_path)
            // 锁键只需目录/文献两份（名字仅用于互斥；权威解析与校验在 addPaper 内部）
            const keys = [g.topicKey(topic)]
            const lockName = typeof args.name === 'string' && args.name.trim() !== ''
              ? args.name.trim()
              : basename(sourcePath).replace(/\.pdf$/i, '')
            if (lockName) keys.push(g.paperKey(topic, lockName))
            const r = await g.runExclusive(keys, () => addPaper(dataDir, topic, sourcePath, args.name))
            invalidateMigrationPromptCache(dataDir)
            const summary = formatSummary(lang, { action, topic: r.topic, name: r.name, bytes: r.bytes, sourceName: r.sourceName })
            return {
              ok: true, action, topic: r.topic, name: r.name, bytes: r.bytes, files: [`${r.name}.pdf`],
              trashDir: null, trashRel: null, approval: 'not-required' as const,
              detachedSessions: 0, summary,
            }
          }
          case 'move_paper': {
            const fromTopic = validateTopicPath(args.topic, true)
            const toTopic = validateTopicPath(args.to_topic, true)
            const name = validateEntryBoundary(args.name, 'paper')
            // 只读预检先行（含旧布局拒绝 / 目标冲突 / 自子树）——**不打扰用户**再点审批（§1.6 顺序）
            const plan = planMovePaper(dataDir, fromTopic, name, toTopic)
            const run = await g.runExclusive(
              [
                g.topicKey(plan.topic), g.paperKey(plan.topic, plan.name),
                g.topicKey(plan.toTopic), g.paperKey(plan.toTopic, plan.name),
              ],
              async () => {
                const ref = { topic: plan.topic, name: plan.name }
                await g.requirePaperClear(ref)
                assertTranslationIdle(lang, [paperRefFor(dataDir, plan.topic, plan.name)])
                const detached = (await g.sessionInfo(ref)).total
                await requestManageApproval({
                  ctx, exec, lang, action,
                  reason: approvalReason(action, { topic: plan.topic, name: plan.name, toTopic: plan.toTopic, fileCount: plan.moved.length }),
                })
                const r = movePaper(dataDir, plan.topic, plan.name, plan.toTopic)
                return { r, detached }
              },
            )
            invalidateMigrationPromptCache(dataDir)
            const summary = formatSummary(lang, {
              action, topic: plan.topic, name: plan.name, toTopic: plan.toTopic,
              fileCount: run.r.moved.length, detached: run.detached,
            })
            return {
              ok: true, action, topic: plan.topic, name: plan.name, to_topic: plan.toTopic,
              files: run.r.moved, trashDir: null, trashRel: null, approval: 'allowed-once' as const,
              detachedSessions: run.detached, summary,
            }
          }
          case 'rename_paper': {
            const topic = validateTopicPath(args.topic, true)
            const name = validateEntryBoundary(args.name, 'paper')
            const newName = validatePaperName(args.new_name)
            const plan = planPaperDelete(dataDir, topic, name)   // 只读：存在性 / 产物 / `.pdf` 常规文件
            if (newName === plan.name) {
              throw toolErr('bad-request', 400, '新名称与原名称相同', 'The new name equals the current name', lang)
            }
            const run = await g.runExclusive([g.topicKey(plan.topic), g.paperKey(plan.topic, plan.name)], async () => {
              const ref = { topic: plan.topic, name: plan.name }
              await g.requirePaperClear(ref)
              assertTranslationIdle(lang, [paperRefFor(dataDir, plan.topic, plan.name)])
              const detached = (await g.sessionInfo(ref)).total
              await requestManageApproval({
                ctx, exec, lang, action,
                reason: approvalReason(action, { topic: plan.topic, name: plan.name, newName, fileCount: plan.files.length }),
              })
              const r = renamePaper(dataDir, plan.topic, plan.name, newName)
              return { r, detached }
            })
            invalidateMigrationPromptCache(dataDir)
            const summary = formatSummary(lang, {
              action, topic: plan.topic, name: plan.name, newName: run.r.to,
              fileCount: run.r.moved.length, detached: run.detached,
            })
            return {
              ok: true, action, topic: plan.topic, name: plan.name, new_name: run.r.to,
              files: run.r.moved, trashDir: null, trashRel: null, approval: 'allowed-once' as const,
              detachedSessions: run.detached, summary,
            }
          }
          case 'rename_topic': {
            const topic = validateTopicPath(args.topic, true)
            const newTopic = validateTopicPath(args.new_name, false)
            if (newTopic === topic) {
              throw toolErr('bad-request', 400, '新名称与原名称相同', 'The new name equals the current name', lang)
            }
            const plan = planTopicDelete(dataDir, topic)   // 只读：存在性 / 符号链接 / 越界
            const run = await g.runExclusive([g.topicKey(plan.name), g.topicKey(newTopic)], async () => {
              await g.requireTopicClear(plan.name)
              const papers = listPapers(dataDir, plan.name).map((p) => paperRefFor(dataDir, p.topic, p.name))
              assertTranslationIdle(lang, papers)
              let detached = 0
              for (const ref of papers) detached += (await g.sessionInfo(ref)).total
              await requestManageApproval({
                ctx, exec, lang, action,
                reason: approvalReason(action, { topic: plan.name, newName: newTopic }),
              })
              const r = renameTopic(dataDir, plan.name, newTopic)
              return { r, detached }
            })
            invalidateMigrationPromptCache(dataDir)
            g.topicPathChanged(plan.name)   // 清工作区缓存（R6/D8）
            const summary = formatSummary(lang, { action, topic: plan.name, newName: run.r.to, detached: run.detached })
            return {
              ok: true, action, topic: plan.name, new_name: run.r.to, files: [],
              trashDir: null, trashRel: null, approval: 'allowed-once' as const,
              detachedSessions: run.detached, summary,
            }
          }
          case 'delete_paper': {
            const topic = validateTopicPath(args.topic, true)
            const name = validateEntryBoundary(args.name, 'paper')
            const plan = planPaperDelete(dataDir, topic, name)   // 只读：不存在就不打扰用户点审批（B10）
            const run = await g.runExclusive([g.topicKey(plan.topic), g.paperKey(plan.topic, plan.name)], async () => {
              const ref = { topic: plan.topic, name: plan.name }
              await g.requirePaperClear(ref)
              assertTranslationIdle(lang, [paperRefFor(dataDir, plan.topic, plan.name)])
              const detached = (await g.sessionInfo(ref)).total
              await requestManageApproval({
                ctx, exec, lang, action,
                reason: approvalReason(action, { topic: plan.topic, name: plan.name, fileCount: plan.files.length, totalBytes: plan.totalBytes }),
              })
              const r = deletePaper(dataDir, plan.topic, plan.name)
              return { r, detached }
            })
            invalidateMigrationPromptCache(dataDir)
            const summary = formatSummary(lang, {
              action, topic: plan.topic, name: plan.name, fileCount: run.r.moved.length,
              totalBytes: plan.totalBytes, trashRel: run.r.trashRel, detached: run.detached,
            })
            return {
              ok: true, action, topic: plan.topic, name: plan.name, files: run.r.moved,
              trashDir: run.r.trashDir, trashRel: run.r.trashRel, approval: 'allowed-once' as const,
              detachedSessions: run.detached, summary,
            }
          }
          case 'delete_topic': {
            const topic = validateTopicPath(args.topic, true)
            const plan = planTopicDelete(dataDir, topic)   // 只读：存在性 / 非空判定
            // 非空即拒（本工具**不提供**批量清空：清空只留在界面，破坏性操作逐次批准）
            if (plan.entries.length > 0) {
              throw toolErr('topic-not-empty', 409,
                `专题内还有 ${plan.entries.length} 个条目（${plan.papers.length} 篇文献）；本工具只删空专题，请逐篇删除后再试`,
                `Topic still has ${plan.entries.length} entries (${plan.papers.length} papers); this tool only deletes empty topics — delete papers one by one first`,
                lang, { entries: plan.entries, papers: plan.papers, subtopics: plan.subtopics })
            }
            const run = await g.runExclusive([g.topicKey(plan.name)], async () => {
              await g.requireTopicClear(plan.name)
              const papers = listPapers(dataDir, plan.name).map((p) => paperRefFor(dataDir, p.topic, p.name))
              assertTranslationIdle(lang, papers)
              let detached = 0
              for (const ref of papers) detached += (await g.sessionInfo(ref)).total
              await requestManageApproval({
                ctx, exec, lang, action,
                reason: approvalReason(action, { topic: plan.name, hiddenCount: plan.hidden.length }),
              })
              const r = deleteTopic(dataDir, plan.name)
              return { r, detached }
            })
            invalidateMigrationPromptCache(dataDir)
            g.topicPathChanged(plan.name)
            const summary = formatSummary(lang, {
              action, topic: plan.name, trashRel: run.r.trashRel, hiddenCount: run.r.movedHidden.length,
            })
            return {
              ok: true, action, topic: plan.name, files: run.r.movedHidden,
              trashDir: run.r.trashDir, trashRel: run.r.trashRel, approval: 'allowed-once' as const,
              detachedSessions: run.detached, summary,
            }
          }
          default:
            throw toolErr('bad-request', 400, '未知 action', 'Unknown action', lang)
        }
      } catch (err) {
        if (isManageError(err)) throw withToolPrefix(lang, dataDir, err)
        throw err
      }
    },
  })
  /* 注册前的最后一道统一化：`defineTool` 会**先按参数 schema 校验**（含 action 枚举）并在越界时抛
     `ToolArgsError`（不带 ManageError 的 code/status）。这里把它翻译成本工具的 `bad-request`，
     让「参数不合法」对模型/调用方是**同一个错误码**（§4.1），同时保留框架给出的具体原因。
     （运行时对象只是原始定义 + 一层 execute 包装，schema/渲染完全不变。） */
  ctx.tools.register({
    ...libraryManageTool,
    async execute(args, exec) {
      try {
        return await libraryManageTool.execute(args, exec)
      } catch (err) {
        // 用**结构化判定**（不 import ToolArgsError）：peer 范围是 >=0.1.5-rc.1，旧小版本未必导出该类名，
        // `instanceof undefined` 会在运行时抛 TypeError；按 name/violations 判定跨版本都稳。
        const e = err as { name?: unknown; message?: unknown; violations?: unknown }
        if (e?.name === 'ToolArgsError' || Array.isArray(e?.violations)) {
          const lang = manageLang()
          const detail = Array.isArray(e.violations) ? e.violations.join('; ') : String(e.message ?? '')
          throw toolErr('bad-request', 400, `参数不合法：${detail}`, `Invalid arguments: ${detail}`, lang)
        }
        throw err
      }
    },
  } as typeof libraryManageTool)
}
