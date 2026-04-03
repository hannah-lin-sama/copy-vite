import colors from 'picocolors'
import type { FutureOptions, ResolvedConfig } from './config'

const docsURL = 'https://vite.dev'

const deprecationCode = {
  removePluginHookSsrArgument: 'this-environment-in-hooks',
  removePluginHookHandleHotUpdate: 'hotupdate-hook',

  removeServerModuleGraph: 'per-environment-apis',
  removeServerReloadModule: 'per-environment-apis',
  removeServerPluginContainer: 'per-environment-apis',
  removeServerHot: 'per-environment-apis',
  removeServerTransformRequest: 'per-environment-apis',
  removeServerWarmupRequest: 'per-environment-apis',

  removeSsrLoadModule: 'ssr-using-modulerunner',
} satisfies Record<keyof FutureOptions, string>

const deprecationMessages = {
  removePluginHookSsrArgument:
    "Plugin hook `options.ssr` is replaced with `this.environment.config.consumer === 'server'`.",
  removePluginHookHandleHotUpdate:
    'Plugin hook `handleHotUpdate()` is replaced with `hotUpdate()`.',

  removeServerModuleGraph:
    'The `server.moduleGraph` is replaced with `this.environment.moduleGraph`.',
  removeServerReloadModule:
    'The `server.reloadModule` is replaced with `environment.reloadModule`.',
  removeServerPluginContainer:
    'The `server.pluginContainer` is replaced with `this.environment.pluginContainer`.',
  removeServerHot: 'The `server.hot` is replaced with `this.environment.hot`.',
  removeServerTransformRequest:
    'The `server.transformRequest` is replaced with `this.environment.transformRequest`.',
  removeServerWarmupRequest:
    'The `server.warmupRequest` is replaced with `this.environment.warmupRequest`.',

  removeSsrLoadModule:
    'The `server.ssrLoadModule` is replaced with Environment Runner.',
} satisfies Record<keyof FutureOptions, string>

let _ignoreDeprecationWarnings = false

export function isFutureDeprecationEnabled(
  config: ResolvedConfig,
  type: keyof FutureOptions,
): boolean {
  return !!config.future?.[type]
}

// Later we could have a `warnDeprecation` utils when the deprecation is landed
/**
 * Warn about future deprecations.
 * 根据配置显示关于未来可能弃用功能的警告
 */
export function warnFutureDeprecation(
  config: ResolvedConfig,
  type: keyof FutureOptions,
  extraMessage?: string, // 额外消息
  stacktrace = true, // 是否显示栈跟踪
): void {
  // 忽略警告或配置中未启用警告，或警告类型不是 warn 时，不显示警告
  if (
    _ignoreDeprecationWarnings ||
    !config.future ||
    config.future[type] !== 'warn'
  )
    return

  // 构建警告消息
  let msg = `[vite future] ${deprecationMessages[type]}`
  if (extraMessage) {
    msg += ` ${extraMessage}`
  }
  msg = colors.yellow(msg)

  // 添加文档链接
  const docs = `${docsURL}/changes/${deprecationCode[type].toLowerCase()}`
  msg +=
    colors.gray(`\n  ${stacktrace ? '├' : '└'}─── `) +
    colors.underline(docs) +
    '\n'

  // 添加栈跟踪
  if (stacktrace) {
    const stack = new Error().stack
    if (stack) {
      // 过滤掉 Vite 内部栈跟踪
      let stacks = stack
        .split('\n')
        .slice(3)
        .filter((i) => !i.includes('/node_modules/vite/dist/'))
      if (stacks.length === 0) {
        stacks.push('No stack trace found.')
      }
      stacks = stacks.map(
        (i, idx) => `  ${idx === stacks.length - 1 ? '└' : '│'} ${i.trim()}`,
      )
      msg += colors.dim(stacks.join('\n')) + '\n'
    }
  }
  // 显示警告
  config.logger.warnOnce(msg)
}

export function ignoreDeprecationWarnings<T>(fn: () => T): T {
  const before = _ignoreDeprecationWarnings
  _ignoreDeprecationWarnings = true
  const ret = fn()
  _ignoreDeprecationWarnings = before
  return ret
}
