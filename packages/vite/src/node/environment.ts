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
 * 用于为每个环境创建和管理独立的状态。
 * 它是一个高阶函数，返回一个能够根据当前环境返回对应状态的函数。
 *
 * @experimental
 */
export function perEnvironmentState<State>(
  initial: (environment: Environment) => State, // 初始化函数，用于为每个环境创建初始状态
): (context: PluginContext) => State {
  // 创建状态映射，用于存储每个环境的状态实例
  const stateMap = new WeakMap<Environment, State>()

  // 返回状态获取函数
  return function (context: PluginContext) {
    // 从上下文中获取 environment 对象
    const { environment } = context
    // 尝试从 stateMap 中获取该环境对应的状态
    let state = stateMap.get(environment)

    // 如果状态不存在（首次访问），调用 initial 函数为该环境创建初始状态
    if (!state) {
      state = initial(environment)
      stateMap.set(environment, state)
    }
    return state
  }
}
