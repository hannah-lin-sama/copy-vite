import type { ModuleRunner } from 'vite/module-runner'
import type { ResolvedConfig } from '../../config'
import type { DevEnvironmentContext } from '../environment'
import { DevEnvironment } from '../environment'
import type { ServerModuleRunnerOptions } from '../../ssr/runtime/serverModuleRunner'
import { createServerModuleRunner } from '../../ssr/runtime/serverModuleRunner'
import { createServerHotChannel } from '../hmr'
import type { Environment } from '../../environment'

/**
 * 用于创建可运行的开发环境实例。
 * 它确保环境具有必要的传输通道和热更新功能，为 Vite 的模块运行器提供支持。
 * @param name
 * @param config
 * @param context
 * @returns
 */
export function createRunnableDevEnvironment(
  name: string,
  config: ResolvedConfig,
  context: RunnableDevEnvironmentContext = {},
): RunnableDevEnvironment {
  if (context.transport == null) {
    // 创建默认的热更新通道
    context.transport = createServerHotChannel()
  }
  if (context.hot == null) {
    // 默认启用热更新
    context.hot = true
  }

  // 创建环境实例
  return new RunnableDevEnvironment(name, config, context)
}

export interface RunnableDevEnvironmentContext extends Omit<
  DevEnvironmentContext,
  'hot'
> {
  runner?: (
    environment: RunnableDevEnvironment,
    options?: ServerModuleRunnerOptions,
  ) => ModuleRunner
  runnerOptions?: ServerModuleRunnerOptions
  hot?: boolean
}

export function isRunnableDevEnvironment(
  environment: Environment,
): environment is RunnableDevEnvironment {
  return environment instanceof RunnableDevEnvironment
}

/**
 * 用于支持模块运行器（ModuleRunner）的开发环境。
 * 它为 Vite 的 SSR（服务器端渲染）和配置加载等场景提供了能够执行模块的环境支持。
 */
class RunnableDevEnvironment extends DevEnvironment {
  // 存储模块运行器实例
  // 懒加载创建? 避免在不需要时创建模块运行器，提高性能
  private _runner: ModuleRunner | undefined
  // 模块运行器工厂函数
  private _runnerFactory:
    | ((
        environment: RunnableDevEnvironment, // 当前环境实例
        options?: ServerModuleRunnerOptions, // 可选的运行器配置选项
      ) => ModuleRunner)
    | undefined
  // 模块运行器的配置选项
  private _runnerOptions: ServerModuleRunnerOptions | undefined

  constructor(
    name: string, // 环境名称，用于标识不同的环境实例
    config: ResolvedConfig, // 解析后的 Vite 配置对象，包含完整的 Vite 配置信息
    context: RunnableDevEnvironmentContext, // 运行环境上下文，包含运行器相关配置
  ) {
    // 调用父类构造函数，初始化核心开发环境功能
    super(name, config, context as DevEnvironmentContext)
    this._runnerFactory = context.runner
    this._runnerOptions = context.runnerOptions
  }

  /**
   * 用于获取模块运行器实例。
   * 它采用懒加载模式，只有在首次访问时才创建模块运行器，并将其缓存起来以供后续使用。
   */
  get runner(): ModuleRunner {
    // 缓存检查，避免重复创建模块运行器
    if (this._runner) {
      return this._runner
    }

    // 工厂函数
    const factory = this._runnerFactory || createServerModuleRunner
    // 创建模块运行器实例
    this._runner = factory(this, this._runnerOptions)
    return this._runner
  }

  /**
   * 用于关闭可运行的开发环境。它覆盖了父类 DevEnvironment 的 close 方法，
   * 在关闭父类环境的基础上，额外关闭模块运行器，确保所有相关资源都被正确释放。
   */
  override async close(): Promise<void> {
    await super.close()
    if (this._runner) {
      await this._runner.close()
    }
  }
}

export type { RunnableDevEnvironment }
