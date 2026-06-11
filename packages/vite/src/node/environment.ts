import type { PluginContext } from 'rolldown'
import type { DevEnvironment } from './server/environment'
import type { BuildEnvironment } from './build'
import type { ScanEnvironment } from './optimizer/scan'
import type { UnknownEnvironment } from './baseEnvironment'

export type Environment =
  | DevEnvironment
  | BuildEnvironment
  | /** @internal */ ScanEnvironment
  | UnknownEnvironment

/**
 * Creates a function that hides the complexities of a WeakMap with an initial value
 * to implement object metadata. Used by plugins to implement cross hooks per
 * environment metadata
 * 为每个 Vite 构建环境（如 client 和 ssr）创建并缓存独立的状态实例。
 * @experimental
 */
export function perEnvironmentState<State>(
  initial: (environment: Environment) => State,
): (context: PluginContext) => State {
  const stateMap = new WeakMap<Environment, State>()

  return function (context: PluginContext) {
    const { environment } = context
    // 尝试从 stateMap 中获取当前环境的状
    let state = stateMap.get(environment)
    if (!state) {
      // 调用 initial 函数初始化状态，并将其存储到 stateMap 中
      state = initial(environment)
      stateMap.set(environment, state)
    }
    return state
  }
}
