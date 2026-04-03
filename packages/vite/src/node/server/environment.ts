import colors from 'picocolors'
import type { FetchFunctionOptions, FetchResult } from 'vite/module-runner'
import type { FSWatcher } from '#dep-types/chokidar'
import { BaseEnvironment } from '../baseEnvironment'
import type {
  EnvironmentOptions,
  ResolvedConfig,
  ResolvedEnvironmentOptions,
} from '../config'
import { mergeConfig, monotonicDateNow } from '../utils'
import { fetchModule } from '../ssr/fetchModule'
import type { DepsOptimizer } from '../optimizer'
import { isDepOptimizationDisabled } from '../optimizer'
import {
  createDepsOptimizer,
  createExplicitDepsOptimizer,
} from '../optimizer/optimizer'
import { ERR_OUTDATED_OPTIMIZED_DEP } from '../../shared/constants'
import { promiseWithResolvers } from '../../shared/utils'
import type { ViteDevServer } from '../server'
import { EnvironmentModuleGraph } from './moduleGraph'
import type { EnvironmentModuleNode } from './moduleGraph'
import type {
  HotChannel,
  NormalizedHotChannel,
  NormalizedHotChannelClient,
} from './hmr'
import { getShortName, normalizeHotChannel, updateModules } from './hmr'
import type {
  TransformOptionsInternal,
  TransformResult,
} from './transformRequest'
import { transformRequest } from './transformRequest'
import type { EnvironmentPluginContainer } from './pluginContainer'
import {
  ERR_CLOSED_SERVER,
  createEnvironmentPluginContainer,
} from './pluginContainer'
import { type WebSocketServer, isWebSocketServer } from './ws'
import { warmupFiles } from './warmup'
import { buildErrorMessage } from './middlewares/error'

export interface DevEnvironmentContext {
  hot: boolean
  transport?: HotChannel | WebSocketServer
  options?: EnvironmentOptions
  remoteRunner?: {
    inlineSourceMap?: boolean
  }
  depsOptimizer?: DepsOptimizer
  /** @internal used for full bundle mode */
  disableDepsOptimizer?: boolean
}

/**
 * 开发环境
 * @class
 * @extends BaseEnvironment
 */
export class DevEnvironment extends BaseEnvironment {
  mode = 'dev' as const
  // 环境中模块间的依赖关系图
  moduleGraph: EnvironmentModuleGraph

  depsOptimizer?: DepsOptimizer
  /**
   * @internal
   */
  _remoteRunnerOptions: DevEnvironmentContext['remoteRunner']

  get pluginContainer(): EnvironmentPluginContainer<DevEnvironment> {
    if (!this._pluginContainer)
      // 抛出错误，提示插件容器未初始化，不能调用
      throw new Error(
        `${this.name} environment.pluginContainer called before initialized`,
      )
    return this._pluginContainer
  }
  /**
   * @internal
   * 插件容器，管理该环境下的 Vite 插件实例
   */
  _pluginContainer: EnvironmentPluginContainer<DevEnvironment> | undefined

  /**
   * @internal
   */
  _closing: boolean = false
  /**
   * @internal
   * 记录正在进行的模块转换请求，用于等待它们完成再关闭服务器，避免资源泄漏。
   */
  _pendingRequests: Map<
    string,
    {
      request: Promise<TransformResult | null>
      timestamp: number
      abort: () => void
    }
  >
  /**
   * @internal
   * 用于检测模块图的静态导入是否已全部处理完毕
   */
  _crawlEndFinder: CrawlEndFinder

  /**
   * Hot channel for this environment. If not provided or disabled,
   * it will be a noop channel that does nothing.
   * 热更新通道，用于向客户端发送 HMR 消息。
   *
   * @example
   * environment.hot.send({ type: 'full-reload' })
   */
  hot: NormalizedHotChannel

  constructor(
    name: string,
    config: ResolvedConfig,
    context: DevEnvironmentContext,
  ) {
    // 获取环境对应的配置
    let options = config.environments[name]

    // 配置不存在，抛出错误
    if (!options) {
      throw new Error(`Environment "${name}" is not defined in the config.`)
    }
    // 合并环境选项
    if (context.options) {
      options = mergeConfig(
        options,
        context.options,
      ) as ResolvedEnvironmentOptions
    }
    super(name, config, options)

    // 存储待处理请求
    this._pendingRequests = new Map()

    // 初始化模块依赖图
    // 参数- name 环境名称
    // 参数- 模块解析函数
    this.moduleGraph = new EnvironmentModuleGraph(name, (url: string) =>
      this.pluginContainer!.resolveId(url, undefined),
    )

    // 创建 CrawlEndFinder 实例，用于检测模块依赖图是否爬取完成
    this._crawlEndFinder = setupOnCrawlEnd()

    // 存储远程运行器选项
    this._remoteRunnerOptions = context.remoteRunner ?? {}

    // 设置热更新通道
    this.hot = context.transport
      ? isWebSocketServer in context.transport
        ? context.transport
        : // 标准化热更新通道
          normalizeHotChannel(context.transport, context.hot)
      : // 如果没有提供热更新通道，创建一个空通道
        normalizeHotChannel({}, context.hot)

    // 设置热更新通道的调用处理函数
    this.hot.setInvokeHandler({
      // 获取模块
      fetchModule: (id, importer, options) => {
        return this.fetchModule(id, importer, options)
      },
      // 获取内置模块
      getBuiltins: async () => {
        return this.config.resolve.builtins.map((builtin) =>
          typeof builtin === 'string'
            ? { type: 'string', value: builtin }
            : { type: 'RegExp', source: builtin.source, flags: builtin.flags },
        )
      },
    })

    // 监听热更新通道的无效事件
    this.hot.on(
      'vite:invalidate',
      async ({ path, message, firstInvalidatedBy }, client) => {
        this.invalidateModule(
          {
            path,
            message,
            firstInvalidatedBy,
          },
          client,
        )
      },
    )

    // 初始化依赖优化器
    if (!context.disableDepsOptimizer) {
      const { optimizeDeps } = this.config

      // 如果提供了依赖优化器，直接使用
      if (context.depsOptimizer) {
        this.depsOptimizer = context.depsOptimizer

        // 如果禁用了依赖优化，设置为 undefined
      } else if (isDepOptimizationDisabled(optimizeDeps)) {
        this.depsOptimizer = undefined

        // 如果没有禁用依赖优化，创建依赖优化器
      } else {
        this.depsOptimizer = (
          optimizeDeps.noDiscovery
            ? createExplicitDepsOptimizer
            : createDepsOptimizer
        )(this)
      }
    }
  }

  /**
   * 创建插件容器
   * @param options
   * @returns
   */
  async init(options?: {
    watcher?: FSWatcher
    /**
     * the previous instance used for the environment with the same name
     *
     * when using, the consumer should check if it's an instance generated from the same class or factory function
     */
    previousInstance?: DevEnvironment
  }): Promise<void> {
    // 如果插件容器已初始化，直接返回
    if (this._initiated) {
      return
    }
    this._initiated = true // 标记为已初始化
    // 创建插件容器
    this._pluginContainer = await createEnvironmentPluginContainer(
      this, // 环境实例
      this.config.plugins, // 插件数组
      options?.watcher, // 文件系统监听器
    )
  }

  /**
   * When the dev server is restarted, the methods are called in the following order:
   * 启动环境服务
   * - new instance `init`
   * - previous instance `close`
   * - new instance `listen`
   */
  async listen(server: ViteDevServer): Promise<void> {
    // 热更新通道监听
    this.hot.listen()
    // 初始化依赖优化器
    await this.depsOptimizer?.init()
    // 预热文件
    warmupFiles(server, this)
  }

  /**
   *
   * @param id
   * @param importer
   * @param options
   * @returns
   */
  fetchModule(
    id: string,
    importer?: string,
    options?: FetchFunctionOptions,
  ): Promise<FetchResult> {
    return fetchModule(this, id, importer, {
      ...this._remoteRunnerOptions,
      ...options,
    })
  }

  /**
   * 重新加载指定的模块，并通过热模块替换（HMR）机制将更新传播到客户端
   * @param module
   */
  async reloadModule(module: EnvironmentModuleNode): Promise<void> {
    // HMR 启用检查：确保热模块替换功能未被禁用
    // 文件路径检查：确保模块有对应的文件路径
    if (this.config.server.hmr !== false && module.file) {
      // this 当前环境实例
      // module.file 模块文件路径
      // [module] 要更新的模块的数组
      // monotonicDateNow() 当前时间戳，用于版本控制
      updateModules(this, module.file, [module], monotonicDateNow())
    }
  }

  transformRequest(
    url: string,
    /** @internal */
    options?: TransformOptionsInternal,
  ): Promise<TransformResult | null> {
    return transformRequest(this, url, options)
  }

  /**
   * 用于预热（提前处理）指定 URL 的请求，以减少首次访问时的加载时间，提高开发服务器的响应速度。
   * @param url
   * @returns
   */
  async warmupRequest(url: string): Promise<void> {
    try {
      // 尝试转换请求
      await this.transformRequest(url)
    } catch (e) {
      if (
        // 过时的优化依赖或已关闭的服务器错误
        e?.code === ERR_OUTDATED_OPTIMIZED_DEP ||
        e?.code === ERR_CLOSED_SERVER
      ) {
        // these are expected errors
        return
      }
      // Unexpected error, log the issue but avoid an unhandled exception
      this.logger.error(
        // 构建错误消息
        buildErrorMessage(e, [`Pre-transform error: ${e.message}`], false),
        {
          error: e,
          timestamp: true,
        },
      )
    }
  }

  /**
   *
   * @param m
   * @param _client
   */
  protected invalidateModule(
    m: {
      path: string
      message?: string
      firstInvalidatedBy: string
    },
    _client: NormalizedHotChannelClient,
  ): void {
    const mod = this.moduleGraph.urlToModuleMap.get(m.path)
    if (
      mod &&
      mod.isSelfAccepting &&
      mod.lastHMRTimestamp > 0 &&
      !mod.lastHMRInvalidationReceived
    ) {
      mod.lastHMRInvalidationReceived = true
      this.logger.info(
        colors.yellow(`hmr invalidate `) +
          colors.dim(m.path) +
          (m.message ? ` ${m.message}` : ''),
        { timestamp: true },
      )
      const file = getShortName(mod.file!, this.config.root)
      updateModules(
        this,
        file,
        [...mod.importers].filter((imp) => imp !== mod), // ignore self-imports
        mod.lastHMRTimestamp,
        m.firstInvalidatedBy,
      )
    }
  }

  /**
   * 关闭开发环境，清理相关资源，包括插件容器、依赖优化器、热通道等，并等待所有待处理的请求完成
   */
  async close(): Promise<void> {
    // 标记为已关闭
    this._closing = true

    // 取消正在进行的依赖爬取
    this._crawlEndFinder.cancel()

    // 并行关闭资源
    await Promise.allSettled([
      // 关闭插件容器
      this.pluginContainer.close(),
      // 关闭依赖优化器
      this.depsOptimizer?.close(),
      // WebSocketServer is independent of HotChannel and should not be closed on environment close
      // 关闭热通道
      isWebSocketServer in this.hot ? Promise.resolve() : this.hot.close(),
      (async () => {
        // 循环等待多所有请求完成
        while (this._pendingRequests.size > 0) {
          await Promise.allSettled(
            [...this._pendingRequests.values()].map(
              (pending) => pending.request, // 是 promise
            ),
          )
        }
      })(),
    ])
  }

  /**
   * Calling `await environment.waitForRequestsIdle(id)` will wait until all static imports
   * are processed after the first transformRequest call. If called from a load or transform
   * plugin hook, the id needs to be passed as a parameter to avoid deadlocks.
   * Calling this function after the first static imports section of the module graph has been
   * processed will resolve immediately.
   * @experimental
   */
  // 用于等待模块依赖爬取过程中的所有请求处理完成
  waitForRequestsIdle(ignoredId?: string): Promise<void> {
    return this._crawlEndFinder.waitForRequestsIdle(ignoredId)
  }

  /**
   * @internal
   */
  _registerRequestProcessing(id: string, done: () => Promise<unknown>): void {
    this._crawlEndFinder.registerRequestProcessing(id, done)
  }
}

// 用于控制模块依赖爬取过程中判断空闲状态的超时时间。
const callCrawlEndIfIdleAfterMs = 50

interface CrawlEndFinder {
  // 注册一个正在处理的请求，将其加入到跟踪列表中
  registerRequestProcessing: (id: string, done: () => Promise<any>) => void
  //等待所有注册的请求处理完成，可选忽略某个特定请求
  waitForRequestsIdle: (ignoredId?: string) => Promise<void>
  // 取消正在处理的请求，终止爬取过程
  cancel: () => void
}

function setupOnCrawlEnd(): CrawlEndFinder {
  const registeredIds = new Set<string>()
  const seenIds = new Set<string>()
  const onCrawlEndPromiseWithResolvers = promiseWithResolvers<void>()

  let timeoutHandle: NodeJS.Timeout | undefined

  let cancelled = false
  function cancel() {
    cancelled = true
  }

  function registerRequestProcessing(
    id: string,
    done: () => Promise<any>,
  ): void {
    if (!seenIds.has(id)) {
      seenIds.add(id)
      registeredIds.add(id)
      done()
        .catch(() => {})
        .finally(() => markIdAsDone(id))
    }
  }

  function waitForRequestsIdle(ignoredId?: string): Promise<void> {
    if (ignoredId) {
      seenIds.add(ignoredId)
      markIdAsDone(ignoredId)
    } else {
      checkIfCrawlEndAfterTimeout()
    }
    return onCrawlEndPromiseWithResolvers.promise
  }

  function markIdAsDone(id: string): void {
    registeredIds.delete(id)
    checkIfCrawlEndAfterTimeout()
  }

  function checkIfCrawlEndAfterTimeout() {
    if (cancelled || registeredIds.size > 0) return

    if (timeoutHandle) clearTimeout(timeoutHandle)
    timeoutHandle = setTimeout(
      callOnCrawlEndWhenIdle,
      callCrawlEndIfIdleAfterMs,
    )
  }
  async function callOnCrawlEndWhenIdle() {
    if (cancelled || registeredIds.size > 0) return
    onCrawlEndPromiseWithResolvers.resolve()
  }

  return {
    registerRequestProcessing,
    waitForRequestsIdle,
    cancel,
  }
}
