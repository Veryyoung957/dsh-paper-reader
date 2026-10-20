// dsh-paper-reader — Cordis 插件壳。
// 壳保持薄：agent 循环/模型层交给 dsh 框架，本插件只注册工具和 HTTP 路由。
// 核心逻辑（转录/检索）是 src/ 下不依赖 Cordis 的纯函数模块，方便日后迁移。

import type { Context } from '@deepseek-ai/cordis'
import { registerTools, type PluginConfig } from './tools.ts'
import { registerRoutes } from './host.ts'
import { createLibraryGuards } from './library-guards.ts'
import { resolveDataDir } from './library.ts'

export const name = 'dsh-paper-reader'

// 等宿主的工具注册服务（ctx.tools）就绪后再运行。
// ⚠️ 审批服务（approval）**不**进 inject：headless/未装配 profile 没有它，加进 inject 会让整个插件
// 加载失败；官方 dsh-tool-fs / dsh-tool-bash 同样是「运行时 ctx.get('approval') 可选读取」。
export const inject = ['tools']

export function apply(ctx: Context, config: PluginConfig = {}) {
  // 破坏性操作的共用前置：**同一个实例**必须同时给到 agent 工具与 HTTP 路由，
  // 否则「路由在途」与「工具在途」互相看不见，锁形同虚设（计划 §3.3.4 / 风险 R8）。
  const guards = createLibraryGuards(resolveDataDir(config.dataDir))
  registerTools(ctx, config, guards)
  console.log(`[dsh-paper-reader] registered tools: list_papers, transcribe_pdf, search_paper, study_progress, study_update, migration_report, migration_prompt_choice, library_manage`)

  // webServer 是可选服务（web profile 有，headless 没有）：出现时再挂路由。
  // connection/sessionController/workspaceController/workspaceRegistry 同属 web profile（cordis 要求访问前先声明 inject）。
  ctx.inject(['webServer', 'connection', 'sessionController', 'workspaceController', 'workspaceRegistry'], (rctx) => {
    registerRoutes(rctx, config, guards)
  })
}
