import { existsSync, readFileSync } from 'node:fs'
import { ModuleRunner, createNodeImportMeta } from 'vite/module-runner'
import type {
  ModuleEvaluator,
  ModuleRunnerHmr,
  ModuleRunnerOptions,
} from 'vite/module-runner'
import type { HotPayload } from '#types/hmrPayload'
import type { DevEnvironment } from '../../server/environment'
import type {
  HotChannelClient,
  NormalizedServerHotChannel,
} from '../../server/hmr'
import type { ModuleRunnerTransport } from '../../../shared/moduleRunnerTransport'

/**
 * @experimental
 */
export interface ServerModuleRunnerOptions extends Omit<
  ModuleRunnerOptions,
  'root' | 'fetchModule' | 'hmr' | 'transport'
> {
  /**
   * Disable HMR or configure HMR logger.
   */
  hmr?:
    | false
    | {
        logger?: ModuleRunnerHmr['logger']
      }
  /**
   * Provide a custom module evaluator. This controls how the code is executed.
   */
  evaluator?: ModuleEvaluator
}

/**
 * 创建 HMR 选项，根据环境配置和用户选项。
 * @param environment 开发环境实例
 * @param options 服务器端模块运行器选项
 * @returns HMR 选项对象
 */
function createHMROptions(
  environment: DevEnvironment,
  options: ServerModuleRunnerOptions,
) {
  if (environment.config.server.hmr === false || options.hmr === false) {
    return false
  }
  if (!('api' in environment.hot)) return false
  return {
    logger: options.hmr?.logger,
  }
}

const prepareStackTrace = {
  retrieveFile(id: string) {
    if (existsSync(id)) {
      return readFileSync(id, 'utf-8')
    }
  },
}

function resolveSourceMapOptions(options: ServerModuleRunnerOptions) {
  if (options.sourcemapInterceptor != null) {
    if (options.sourcemapInterceptor === 'prepareStackTrace') {
      return prepareStackTrace
    }
    if (typeof options.sourcemapInterceptor === 'object') {
      return { ...prepareStackTrace, ...options.sourcemapInterceptor }
    }
    return options.sourcemapInterceptor
  }
  if (typeof process !== 'undefined' && 'setSourceMapsEnabled' in process) {
    return 'node'
  }
  return prepareStackTrace
}

/**
 * 创建服务器端模块运行器传输系统。
 * @param options 服务器端模块运行器选项
 * @returns 服务器端模块运行器传输系统实例
 */
export const createServerModuleRunnerTransport = (options: {
  channel: NormalizedServerHotChannel
}): ModuleRunnerTransport => {
  // 创建 HMR 客户端
  const hmrClient: HotChannelClient = {
    send: (payload: HotPayload) => {
      if (payload.type !== 'custom') {
        throw new Error(
          'Cannot send non-custom events from the client to the server.',
        )
      }
      options.channel.send(payload)
    },
  }

  let handler: ((data: HotPayload) => void) | undefined

  return {
    connect({ onMessage }) {
      // 连接传输通道，监听客户端消息
      options.channel.api!.outsideEmitter.on('send', onMessage)
      // 发送连接事件，通知客户端已连接
      options.channel.api!.innerEmitter.emit(
        'vite:client:connect',
        undefined,
        hmrClient,
      )
      // 发送连接确认，通知客户端已连接
      onMessage({ type: 'connected' })
      handler = onMessage
    },
    // 断开传输通道，移除消息监听器
    disconnect() {
      if (handler) {
        options.channel.api!.outsideEmitter.off('send', handler)
      }
      // 发送断开事件，通知客户端已断开
      options.channel.api!.innerEmitter.emit(
        'vite:client:disconnect',
        undefined,
        hmrClient,
      )
    },
    // 发送消息到客户端
    send(payload) {
      if (payload.type !== 'custom') {
        throw new Error(
          'Cannot send non-custom events from the server to the client.',
        )
      }
      options.channel.api!.innerEmitter.emit(
        payload.event,
        payload.data,
        hmrClient,
      )
    },
  }
}

/**
 * Create an instance of the Vite SSR runtime that support HMR.
 * 用于创建服务器端模块运行器。
 * 它为 SSR 环境提供了一个专门的模块运行器，支持 HMR、源码映射和 Node.js 风格的 import.meta 对象。
 * @experimental
 */
export function createServerModuleRunner(
  environment: DevEnvironment,
  options: ServerModuleRunnerOptions = {},
): ModuleRunner {
  // 创建 HMR 选项，根据环境配置和用户选项
  const hmr = createHMROptions(environment, options)

  // 创建模块运行器实例
  // 传递必要的选项，包括传输通道、HMR 选项、导入元数据创建器和源码映射拦截器
  // 这些选项确保了模块运行器在 SSR 环境中的正常运行
  return new ModuleRunner(
    {
      ...options,
      // 传输通道，用于与客户端进行通信
      transport: createServerModuleRunnerTransport({
        // 就是hot通道（暴露的send、on、close、off、listen、api）
        channel: environment.hot as NormalizedServerHotChannel,
      }),
      hmr,
      // 设置 import.meta 创建函数
      createImportMeta: createNodeImportMeta,
      // 源码映射拦截器，用于处理模块的源码映射
      sourcemapInterceptor: resolveSourceMapOptions(options),
    },
    options.evaluator,
  )
}
