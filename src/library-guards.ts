// library-guards.ts — 破坏性操作（删除/改名/移动/清空）的**共用前置**：
//   · 伴读会话准入（fail-closed：查不到 = unknown ⇒ 拒绝）；
//   · 翻译在途的取数口径由调用方用 zhStatus 判定（本模块只提供会话与锁，不 import translate 以免循环）；
//   · 同目标在途互斥（进程内锁，原来私有在 host.ts 的 withInflight 里）；
//   · 专题路径变化后的副作用钩子（web 侧注入 dropWorkspaceCache）。
//
// 契约：docs/library-manage-tools-plan.md §3.3.1/§3.3.5。**唯一实现**：host.ts 的 HTTP 路由与
// tools.ts 的 library_manage 必须共用**同一个实例**（src/index.ts 显式创建并双传），否则「路由在途」
// 与「工具在途」互相看不见，锁形同虚设（风险 R8）。
//
// 本模块不依赖 Cordis，可直接被测试 import（dist/library-guards.js）。

import { listPapers } from './library.ts'
import { ManageError } from './library-manage.ts'

export interface PaperRefLike {
  topic: string
  name: string
}

/** 某文献的伴读会话统计。`unknown=true` 表示**查不到**（服务缺失/查询抛错）⇒ 调用方必须 fail closed。 */
export interface PaperSessionInfo {
  total: number
  running: number
  unknown: boolean
}

/** web 侧注入的会话扫描器（host 的 scanPaperSessions）。未注入 ⇒ 一律 unknown（headless 会话无此服务）。 */
export type PaperSessionScanner = (ref: PaperRefLike) => Promise<Array<{ running: boolean }>>

/** 专题路径变化后的副作用（web 侧注入 dropWorkspaceCache）。 */
export type TopicPathChangedHook = (topicPath: string) => void

export interface LibraryGuards {
  readonly dataDir: string
  /** web 侧注入：返回该篇的全部伴读会话（只读）。未注入 ⇒ unknown（fail closed）。 */
  setPaperSessionScanner(fn: PaperSessionScanner | null): void
  /** web 侧注入：专题路径变化后的副作用（清 workspace 缓存）。工具成功后调用。 */
  setTopicPathChangedHook(fn: TopicPathChangedHook | null): void
  topicPathChanged(topicPath: string): void

  sessionInfo(ref: PaperRefLike): Promise<PaperSessionInfo>
  /** unknown → 503 session-unknown；running>0 → 409 session-running（extra.sessions）。 */
  requirePaperClear(ref: PaperRefLike): Promise<void>
  /** 对 listPapers(dataDir, topic) 的每篇调 requirePaperClear（专题级：含整棵子树）。 */
  requireTopicClear(topic: string): Promise<void>

  /** `${topic}\u0000${name}`（与 host 现有键格式逐字一致） */
  paperKey(topic: string, name: string): string
  /** `topic\u0000${topic}`（与 host 现有键格式逐字一致） */
  topicKey(topic: string): string
  /** 全部键按字典序去重后一次性尝试；任一已占用 → 抛 ManageError('busy',409,原文案)。 */
  runExclusive<T>(keys: string[], fn: () => Promise<T> | T): Promise<T>
  tryAcquire(keys: string[]): boolean
  release(keys: string[]): void
  /** 保留 host 现有「子串包含」语义（src/host.ts 的 scopeBusy），不趁重构改行为（V5/R5）。 */
  isBusy(scopePath: string): boolean
}

/** 去重 + 字典序：多个写者按同一顺序尝试，避免不同加锁顺序造成死锁/半持有。 */
function normalizeKeys(keys: string[]): string[] {
  return [...new Set(keys)].sort()
}

export function createLibraryGuards(dataDir: string): LibraryGuards {
  let scanner: PaperSessionScanner | null = null
  let pathChanged: TopicPathChangedHook | null = null
  const inflight = new Set<string>()

  const sessionInfo = async (ref: PaperRefLike): Promise<PaperSessionInfo> => {
    if (!scanner) return { total: 0, running: 0, unknown: true }
    try {
      const sessions = await scanner(ref)
      return { total: sessions.length, running: sessions.filter((s) => s.running).length, unknown: false }
    } catch {
      // fail closed：查不到 ≠ 没有在跑（R3 的既定取向）
      return { total: 0, running: 0, unknown: true }
    }
  }

  const requirePaperClear = async (ref: PaperRefLike): Promise<void> => {
    const info = await sessionInfo(ref)
    if (info.unknown) {
      throw new ManageError('session-unknown', 503,
        '暂时无法确认该文献的伴读会话状态，为避免误删已取消本次操作；请稍后重试')
    }
    if (info.running > 0) {
      throw new ManageError('session-running', 409,
        `该文献有 ${info.running} 个正在运行的伴读会话，请先结束后再操作`, {
          sessions: { total: info.total, running: info.running },
        })
    }
  }

  const requireTopicClear = async (topic: string): Promise<void> => {
    for (const p of listPapers(dataDir, topic)) await requirePaperClear({ topic: p.topic, name: p.name })
  }

  const tryAcquire = (keys: string[]): boolean => {
    const normalized = normalizeKeys(keys)
    if (normalized.some((k) => inflight.has(k))) return false
    for (const k of normalized) inflight.add(k)
    return true
  }

  const release = (keys: string[]): void => {
    for (const k of normalizeKeys(keys)) inflight.delete(k)
  }

  const runExclusive = async <T>(keys: string[], fn: () => Promise<T> | T): Promise<T> => {
    if (!tryAcquire(keys)) {
      throw new ManageError('busy', 409, '同一目标的另一个删除/重命名/移动操作正在进行，请稍后重试')
    }
    try {
      return await fn()
    } finally {
      release(keys)
    }
  }

  return {
    dataDir,
    setPaperSessionScanner: (fn) => { scanner = fn },
    setTopicPathChangedHook: (fn) => { pathChanged = fn },
    topicPathChanged: (topicPath) => { try { pathChanged?.(topicPath) } catch { /* 缓存钩子失败不影响操作结果 */ } },
    sessionInfo,
    requirePaperClear,
    requireTopicClear,
    paperKey: (topic, name) => `${topic}\u0000${name}`,
    topicKey: (topic) => `topic\u0000${topic}`,
    runExclusive,
    tryAcquire,
    release,
    isBusy: (scopePath) => {
      // 历史语义（**不在本批修**）：读路径只按「子串包含」判断，paper scope（`T/P`）本来就匹配不到
      // `topic\0T` / `T\0P`；这里原样保留，避免顺手改变读路径的提示行为（R5/V5）。
      for (const k of inflight) if (k.includes(scopePath)) return true
      return false
    },
  }
}
