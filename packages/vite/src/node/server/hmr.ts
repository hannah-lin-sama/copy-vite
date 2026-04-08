import fsp from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import colors from 'picocolors'
import type { RollupError } from 'rolldown'
import type { CustomPayload, HotPayload, Update } from '#types/hmrPayload'
import type {
  InvokeMethods,
  InvokeResponseData,
  InvokeSendData,
} from '../../shared/invokeMethods'
import { CLIENT_DIR } from '../constants'
import { createDebugger, monotonicDateNow, normalizePath } from '../utils'
import type { InferCustomEventPayload, ViteDevServer } from '..'
import { getHookHandler } from '../plugins'
import { isExplicitImportRequired } from '../plugins/importAnalysis'
import { getEnvFilesForMode } from '../env'
import type { Environment } from '../environment'
import { withTrailingSlash, wrapId } from '../../shared/utils'
import type { Plugin } from '../plugin'
import {
  ignoreDeprecationWarnings,
  warnFutureDeprecation,
} from '../deprecations'
import type { EnvironmentModuleNode } from './moduleGraph'
import type { ModuleNode } from './mixedModuleGraph'
import type { DevEnvironment } from './environment'
import { prepareError } from './middlewares/error'
import {
  BasicMinimalPluginContext,
  basePluginContextMeta,
} from './pluginContainer'
import type { HttpServer } from '.'
import { restartServerWithUrls } from '.'

export const debugHmr: ((...args: any[]) => any) | undefined =
  createDebugger('vite:hmr')

const whitespaceRE = /\s/

const normalizedClientDir = normalizePath(CLIENT_DIR)

export interface HmrOptions {
  protocol?: string
  host?: string
  port?: number
  clientPort?: number
  path?: string
  timeout?: number
  overlay?: boolean
  server?: HttpServer
}

export interface HotUpdateOptions {
  type: 'create' | 'update' | 'delete'
  file: string
  timestamp: number
  modules: Array<EnvironmentModuleNode>
  read: () => string | Promise<string>
  server: ViteDevServer
}

export interface HmrContext {
  file: string
  timestamp: number
  modules: Array<ModuleNode>
  read: () => string | Promise<string>
  server: ViteDevServer
}

interface PropagationBoundary {
  boundary: EnvironmentModuleNode & { type: 'js' | 'css' }
  acceptedVia: EnvironmentModuleNode
  isWithinCircularImport: boolean
}

export interface HotChannelClient {
  send(payload: HotPayload): void
}

export type HotChannelListener<T extends string = string> = (
  data: InferCustomEventPayload<T>,
  client: HotChannelClient,
) => void

export interface HotChannel<Api = any> {
  /**
   * Broadcast events to all clients
   */
  send?(payload: HotPayload): void
  /**
   * Handle custom event emitted by `import.meta.hot.send`
   */
  on?<T extends string>(event: T, listener: HotChannelListener<T>): void
  on?(event: 'connection', listener: () => void): void
  /**
   * Unregister event listener
   */
  off?(event: string, listener: Function): void
  /**
   * Start listening for messages
   */
  listen?(): void
  /**
   * Disconnect all clients, called when server is closed or restarted.
   */
  close?(): Promise<unknown> | void

  api?: Api
}

/**
 * 用于获取文件的短路径名称，具体逻辑是：
 * 如果文件路径在指定的根目录下，则返回相对于根目录的路径；否则返回原始文件路径。
 * @param file 文件路径
 * @param root 根目录
 * @returns 短名称
 */
export function getShortName(file: string, root: string): string {
  // withTrailingSlash 在尾部添加斜杠
  // file 路径是否以 root路径开头
  return file.startsWith(withTrailingSlash(root))
    ? // 计算出相对路径
      path.posix.relative(root, file)
    : file
}

export interface NormalizedHotChannelClient {
  /**
   * Send event to the client
   */
  send(payload: HotPayload): void
  /**
   * Send custom event
   */
  send(event: string, payload?: CustomPayload['data']): void
}

export interface NormalizedHotChannel<Api = any> {
  /**
   * Broadcast events to all clients
   */
  send(payload: HotPayload): void
  /**
   * Send custom event
   */
  send<T extends string>(event: T, payload?: InferCustomEventPayload<T>): void
  /**
   * Handle custom event emitted by `import.meta.hot.send`
   */
  on<T extends string>(
    event: T,
    listener: (
      data: InferCustomEventPayload<T>,
      client: NormalizedHotChannelClient,
    ) => void,
  ): void
  /**
   * @deprecated use `vite:client:connect` event instead
   */
  on(event: 'connection', listener: () => void): void
  /**
   * Unregister event listener
   */
  off(event: string, listener: Function): void
  /** @internal */
  setInvokeHandler(invokeHandlers: InvokeMethods | undefined): void
  handleInvoke(payload: HotPayload): Promise<{ result: any } | { error: any }>
  /**
   * Start listening for messages
   */
  listen(): void
  /**
   * Disconnect all clients, called when server is closed or restarted.
   */
  close(): Promise<unknown> | void

  api?: Api
}

export const normalizeHotChannel = (
  channel: HotChannel,
  enableHmr: boolean,
  normalizeClient = true,
): NormalizedHotChannel => {
  // 用于存储事件监听器的映射
  const normalizedListenerMap = new WeakMap<
    (data: any, client: NormalizedHotChannelClient) => void | Promise<void>,
    (data: any, client: HotChannelClient) => void | Promise<void>
  >()

  // 用于存储客户端的映射
  const normalizedClients = new WeakMap<
    HotChannelClient,
    NormalizedHotChannelClient
  >()

  let invokeHandlers: InvokeMethods | undefined
  let listenerForInvokeHandler:
    | ((data: InvokeSendData, client: HotChannelClient) => void)
    | undefined

  const handleInvoke = async <T extends keyof InvokeMethods>(
    payload: HotPayload,
  ) => {
    if (!invokeHandlers) {
      return {
        error: {
          name: 'TransportError',
          message: 'invokeHandlers is not set',
          stack: new Error().stack,
        },
      }
    }

    const data: InvokeSendData<T> = (payload as CustomPayload).data
    const { name, data: args } = data
    try {
      const invokeHandler = invokeHandlers[name]
      // @ts-expect-error `invokeHandler` is `InvokeMethods[T]`, so passing the args is fine
      const result = await invokeHandler(...args)
      return { result }
    } catch (error) {
      return {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
          ...error, // preserve enumerable properties such as RollupError.loc, frame, plugin
        },
      }
    }
  }

  return {
    ...channel,
    // 用于注册事件监听器
    on: (
      event: string,
      fn: (data: any, client: NormalizedHotChannelClient) => void,
    ) => {
      // 处理连接事件
      if (event === 'connection' || !normalizeClient) {
        channel.on?.(event, fn as () => void)
        return
      }

      const listenerWithNormalizedClient = (
        data: any,
        client: HotChannelClient,
      ) => {
        // 处理客户端事件
        if (!normalizedClients.has(client)) {
          normalizedClients.set(client, {
            send: (...args) => {
              let payload: HotPayload
              if (typeof args[0] === 'string') {
                payload = {
                  type: 'custom',
                  event: args[0],
                  data: args[1],
                }
              } else {
                payload = args[0]
              }
              client.send(payload)
            },
          })
        }
        // 调用事件监听器
        fn(data, normalizedClients.get(client)!)
      }
      // 存储事件监听器的映射
      normalizedListenerMap.set(fn, listenerWithNormalizedClient)

      // 注册事件监听器
      channel.on?.(event, listenerWithNormalizedClient)
    },
    // 用于移除事件监听器
    off: (event: string, fn: () => void) => {
      if (event === 'connection' || !normalizeClient) {
        // 移除连接事件监听器
        channel.off?.(event, fn as () => void)
        return
      }

      const normalizedListener = normalizedListenerMap.get(fn)
      if (normalizedListener) {
        channel.off?.(event, normalizedListener)
      }
    },
    /**
     * 设置远程调用处理器，用于处理客户端发起的远程方法调用。
     * @param _invokeHandlers
     * @returns
     */
    setInvokeHandler(_invokeHandlers) {
      invokeHandlers = _invokeHandlers
      if (!_invokeHandlers) {
        if (listenerForInvokeHandler) {
          // 移除调用处理程序
          channel.off?.('vite:invoke', listenerForInvokeHandler)
        }
        return
      }

      listenerForInvokeHandler = async (payload, client) => {
        // 生成响应调用 ID
        const responseInvoke = payload.id.replace('send', 'response') as
          | 'response'
          | `response:${string}`
        // 发送调用响应
        client.send({
          type: 'custom',
          event: 'vite:invoke',
          data: {
            name: payload.name,
            id: responseInvoke,
            data: (await handleInvoke({
              type: 'custom',
              event: 'vite:invoke',
              data: payload,
            }))!,
          } satisfies InvokeResponseData,
        })
      }
      // 注册 vite:invoke 事件的调用处理程序
      channel.on?.('vite:invoke', listenerForInvokeHandler)
    },
    // 用于处理调用
    handleInvoke,
    /**
     * 发送消息到热通道，支持两种消息格式
     * 1、字符串事件名和数据
     * 2、完整的消息对象
     * @param args
     */
    send: (...args: any[]) => {
      let payload: HotPayload
      // 构建消息 payload
      // 如果第一个参数是字符串，说明是自定义事件
      if (typeof args[0] === 'string') {
        payload = {
          type: 'custom', // 自定义事件
          event: args[0],
          data: args[1],
        }
        // 非自定义事件，直接发送 payload
      } else {
        payload = args[0]
      }

      // 消息过滤，只发送连接、心跳、自定义事件和错误事件
      if (
        enableHmr ||
        payload.type === 'connected' ||
        payload.type === 'ping' ||
        payload.type === 'custom' ||
        payload.type === 'error'
      ) {
        channel.send?.(payload)
      }
    },
    // 启动服务器
    listen() {
      return channel.listen?.()
    },
    // 关闭服务器
    close() {
      return channel.close?.()
    },
  }
}

export function getSortedPluginsByHotUpdateHook(
  plugins: readonly Plugin[],
): Plugin[] {
  const sortedPlugins: Plugin[] = []
  // Use indexes to track and insert the ordered plugins directly in the
  // resulting array to avoid creating 3 extra temporary arrays per hook
  let pre = 0,
    normal = 0,
    post = 0
  for (const plugin of plugins) {
    // 取出插件的 hotUpdate 或 handleHotUpdate 钩子
    const hook = plugin['hotUpdate'] ?? plugin['handleHotUpdate']
    if (hook) {
      if (typeof hook === 'object') {
        if (hook.order === 'pre') {
          sortedPlugins.splice(pre++, 0, plugin)
          continue
        }
        if (hook.order === 'post') {
          sortedPlugins.splice(pre + normal + post++, 0, plugin)
          continue
        }
      }
      sortedPlugins.splice(pre + normal++, 0, plugin)
    }
  }

  return sortedPlugins
}

const sortedHotUpdatePluginsCache = new WeakMap<Environment, Plugin[]>()
function getSortedHotUpdatePlugins(environment: Environment): Plugin[] {
  let sortedPlugins = sortedHotUpdatePluginsCache.get(environment)
  if (!sortedPlugins) {
    sortedPlugins = getSortedPluginsByHotUpdateHook(environment.plugins)
    sortedHotUpdatePluginsCache.set(environment, sortedPlugins)
  }
  return sortedPlugins
}

/**
 * 处理文件系统中的文件变更事件，根据变更类型和文件类型，决定是重启服务器、刷新页面还是执行热模块替换。
 * @param type 文件变化类型
 * @param file 文件路径
 * @param server 服务器实例
 * @returns
 */
export async function handleHMRUpdate(
  type: 'create' | 'delete' | 'update',
  file: string,
  server: ViteDevServer,
): Promise<void> {
  // 获取服务器配置
  const { config } = server
  // 警告忽略过时的模块图 API
  const mixedModuleGraph = ignoreDeprecationWarnings(() => server.moduleGraph)

  // 获取所有环境
  const environments = Object.values(server.environments)
  const shortFile = getShortName(file, config.root)

  const isConfig = file === config.configFile //是否是配置文件
  // 是否是配置文件依赖
  const isConfigDependency = config.configFileDependencies.some(
    (name) => file === name,
  )

  // 是否是环境文件
  const isEnv =
    config.envDir !== false &&
    getEnvFilesForMode(config.mode, config.envDir).includes(file)

  // 配置文件、配置文件依赖、环境文件变化时，自动重启服务器
  if (isConfig || isConfigDependency || isEnv) {
    // auto restart server
    debugHmr?.(`[config change] ${colors.dim(shortFile)}`)

    // 打印日志
    config.logger.info(
      colors.green(
        `${normalizePath(
          path.relative(process.cwd(), file),
        )} changed, restarting server...`,
      ),
      { clear: true, timestamp: true },
    )
    try {
      // 重启服务器
      await restartServerWithUrls(server)
    } catch (e) {
      config.logger.error(colors.red(e))
    }
    return
  }

  debugHmr?.(`[file change] ${colors.dim(shortFile)}`)

  // (dev only) the client itself cannot be hot updated.
  // Vite 客户端自身文件变更 → 不能热更 → 必须整页刷新
  if (file.startsWith(withTrailingSlash(normalizedClientDir))) {
    environments.forEach(({ hot }) =>
      hot.send({
        type: 'full-reload',
        path: '*',
        triggeredBy: path.resolve(config.root, file),
      }),
    )
    return
  }

  // 普通开发模式（现在默认）
  // 1、不打包，原生 ESM
  // 2、每个文件单独请求
  // 3、HMR 极快
  // 4、但文件多了会有大量请求

  // 如果开启了 Vite 实验性的 bundledDev 模式，就 直接跳过整个 HMR 热更新逻辑
  if (config.experimental.bundledDev) {
    // TODO: support handleHotUpdate / hotUpdate
    return
  }

  const timestamp = monotonicDateNow()
  const contextMeta = {
    type,
    file,
    timestamp,
    read: () => readModifiedFile(file),
    server,
  }

  const hotMap = new Map<
    Environment,
    { options: HotUpdateOptions; error?: Error }
  >()

  // 遍历所有环境（client /ssr），找出文件变更后「需要被热更新的模块」。
  for (const environment of Object.values(server.environments)) {
    //  找到当前文件对应的所有模块
    const mods = new Set(environment.moduleGraph.getModulesByFile(file))

    // 如果是【文件新增】，把之前解析失败的模块也加进来重试
    /**
     * 场景：你先 import './Hello.vue'，但文件还没创建 → Vite 报错：模块不存在。
     * 你创建了 Hello.vue → 文件类型是 create。
     * Vite 会：把之前解析失败的模块重新加入热更新列表，让它们重试加载。
     * 作用：文件创建后，自动修复之前的导入错误，不需要刷新页面。
     */
    if (type === 'create') {
      for (const mod of environment.moduleGraph._hasResolveFailedErrorModules) {
        mods.add(mod)
      }
    }
    const options = {
      ...contextMeta,
      modules: [...mods],
    }
    // 存入 hotMap，后面统一执行更新
    hotMap.set(environment, { options })
  }

  /*  
    背景：Vite 现在有 两套模块图
    新架构：client、ssr 完全隔离（环境独立）
    旧架构： mixedModuleGraph 混合在一起（不区分环境）
  */
  // mixedMods 混合模块
  const mixedMods = new Set(mixedModuleGraph.getModulesByFile(file))
  // 专门给 plugin.handleHotUpdate 旧钩子使用的上下文。
  const mixedHmrContext: HmrContext = {
    ...contextMeta,
    modules: [...mixedMods],
  }
  // 给旧插件提供一个最小化可用的插件上下文，
  const contextForHandleHotUpdate = new BasicMinimalPluginContext(
    { ...basePluginContextMeta, watchMode: true },
    config.logger,
  )
  // 获取客户端环境和服务器端环境（新架构）
  const clientEnvironment = server.environments.client
  const ssrEnvironment = server.environments.ssr

  // 客户端插件上下文，给新钩子 hotUpdate 使用。
  const clientContext = clientEnvironment.pluginContainer.minimalContext
  // 取出热更新选项
  // 后面执行插件时，会把旧插件返回的过滤结果同步回新架构，让 client + ssr 模块图都能正确更新。
  const clientHotUpdateOptions = hotMap.get(clientEnvironment)!.options
  const ssrHotUpdateOptions = hotMap.get(ssrEnvironment)?.options

  // 遍历所有插件
  // → 执行它们的热更新钩子
  // → 过滤 / 修改要更新的模块
  // → 同步回 client /ssr/mixed 三套模块系统同时完美兼容新钩子（hotUpdate）+ 旧钩子（handleHotUpdate）。
  try {
    for (const plugin of getSortedHotUpdatePlugins(
      server.environments.client,
    )) {
      // 新插件 hotUpdate 钒子
      if (plugin.hotUpdate) {
        // 执行新钩子 hotUpdate
        const filteredModules = await getHookHandler(plugin.hotUpdate).call(
          clientContext,
          clientHotUpdateOptions,
        )
        if (filteredModules) {
          // 更新 client 环境模块
          clientHotUpdateOptions.modules = filteredModules
          // Invalidate the hmrContext to force compat modules to be updated
          // 同步更新混合模块图 mixedHmrContext（给旧插件兼容）
          mixedHmrContext.modules = mixedHmrContext.modules.filter(
            (mixedMod) =>
              filteredModules.some((mod) => mixedMod.id === mod.id) ||
              ssrHotUpdateOptions?.modules.some(
                (ssrMod) => ssrMod.id === mixedMod.id,
              ),
          )
          mixedHmrContext.modules.push(
            ...filteredModules
              .filter(
                (mod) =>
                  !mixedHmrContext.modules.some(
                    (mixedMod) => mixedMod.id === mod.id,
                  ),
              )
              .map((mod) =>
                mixedModuleGraph.getBackwardCompatibleModuleNode(mod),
              ),
          )
        }

        // 旧插件 —— plugin.handleHotUpdate
      } else if (type === 'update') {
        // 打印警告：未来会移除 handleHotUpdate
        warnFutureDeprecation(
          config,
          'removePluginHookHandleHotUpdate',
          `Used in plugin "${plugin.name}".`,
          false,
        )
        // later on, we'll need: if (runtime === 'client')
        // Backward compatibility with mixed client and ssr moduleGraph
        const filteredModules = await getHookHandler(
          plugin.handleHotUpdate!,
        ).call(contextForHandleHotUpdate, mixedHmrContext)

        if (filteredModules) {
          mixedHmrContext.modules = filteredModules
          // 同步回 client 环境模块列表
          clientHotUpdateOptions.modules =
            clientHotUpdateOptions.modules.filter((mod) =>
              filteredModules.some((mixedMod) => mod.id === mixedMod.id),
            )
          clientHotUpdateOptions.modules.push(
            ...(filteredModules
              .filter(
                (mixedMod) =>
                  !clientHotUpdateOptions.modules.some(
                    (mod) => mod.id === mixedMod.id,
                  ),
              )
              .map((mixedMod) => mixedMod._clientModule)
              .filter(Boolean) as EnvironmentModuleNode[]),
          )
          if (ssrHotUpdateOptions) {
            ssrHotUpdateOptions.modules = ssrHotUpdateOptions.modules.filter(
              (mod) =>
                filteredModules.some((mixedMod) => mod.id === mixedMod.id),
            )
            ssrHotUpdateOptions.modules.push(
              ...(filteredModules
                .filter(
                  (mixedMod) =>
                    !ssrHotUpdateOptions.modules.some(
                      (mod) => mod.id === mixedMod.id,
                    ),
                )
                .map((mixedMod) => mixedMod._ssrModule)
                .filter(Boolean) as EnvironmentModuleNode[]),
            )
          }
        }
      }
    }
  } catch (error) {
    // 插件执行出错 → 记录错误 → 后面发给浏览器红屏报错
    hotMap.get(server.environments.client)!.error = error
  }

  for (const environment of Object.values(server.environments)) {
    // 跳过 client（浏览器）环境，因为前面已经处理过了
    if (environment.name === 'client') continue

    const hot = hotMap.get(environment)!
    const context = environment.pluginContainer.minimalContext
    try {
      for (const plugin of getSortedHotUpdatePlugins(environment)) {
        // 新插件 hotUpdate 钒子
        if (plugin.hotUpdate) {
          const filteredModules = await getHookHandler(plugin.hotUpdate).call(
            context,
            hot.options,
          )
          if (filteredModules) {
            hot.options.modules = filteredModules
          }
        }
      }
    } catch (error) {
      hot.error = error
    }
  }

  /**
   * 处理热更新：决定是刷新页面、忽略、还是真正热替换模块
   * @param environment 环境
   * @returns
   */
  async function hmr(environment: DevEnvironment) {
    try {
      // 获取当前环境的热更新信息
      const { options, error } = hotMap.get(environment)!
      if (error) {
        throw error
      }
      // 如果没有需要更新的模块
      if (!options.modules.length) {
        // html file cannot be hot updated
        // html文件 client环境不能热更新，刷新页面
        if (file.endsWith('.html') && environment.name === 'client') {
          // 打印刷新页面日志
          environment.logger.info(
            colors.green(`page reload `) + colors.dim(shortFile),
            {
              clear: true,
              timestamp: true,
            },
          )
          // 发送刷新页面指令给浏览器
          environment.hot.send({
            type: 'full-reload',
            path: config.server.middlewareMode
              ? '*'
              : '/' + normalizePath(path.relative(config.root, file)),
          })
        } else {
          // loaded but not in the module graph, probably not js
          // 普通静态文件，无模块可更新 → 打日志，不处理
          debugHmr?.(
            `(${environment.name}) [no modules matched] ${colors.dim(shortFile)}`,
          )
        }
        return
      }

      // 真正执行热更新（模块替换）
      updateModules(environment, shortFile, options.modules, timestamp)
    } catch (err) {
      // 报错 → 发送红屏错误给浏览器
      environment.hot.send({
        type: 'error',
        err: prepareError(err),
      })
    }
  }

  const hotUpdateEnvironments =
    // 热更新环境配置
    server.config.server.hotUpdateEnvironments ??
    ((server, hmr) => {
      // Run HMR in parallel for all environments by default
      // 并行
      return Promise.all(
        Object.values(server.environments).map((environment) =>
          hmr(environment),
        ),
      )
    })

  await hotUpdateEnvironments(server, hmr)
}

type HasDeadEnd = string | boolean

/**
 * 计算模块更新的边界，生成热更新指令，并发送到客户端，实现模块的热更新或全页刷新
 * @param environment 环境
 * @param file 文件路径
 * @param modules 模块列表
 * @param timestamp 时间戳
 * @param firstInvalidatedBy
 * @returns
 */
export function updateModules(
  environment: DevEnvironment,
  file: string,
  modules: EnvironmentModuleNode[],
  timestamp: number,
  // 第一个失效的模块 URL
  firstInvalidatedBy?: string,
): void {
  const { hot } = environment

  // 存储要发送给浏览器的热更新指令
  const updates: Update[] = []
  // 已失效的模块
  const invalidatedModules = new Set<EnvironmentModuleNode>()
  const traversedModules = new Set<EnvironmentModuleNode>() // 遍历过的模块（防止循环）
  // Modules could be empty if a root module is invalidated via import.meta.hot.invalidate()
  // 标记是否需要全页刷新
  let needFullReload: HasDeadEnd = modules.length === 0

  // 遍历所有需要更新的模块
  for (const mod of modules) {
    const boundaries: PropagationBoundary[] = []
    // 向上传播更新，找到 HMR 边界
    const hasDeadEnd = propagateUpdate(mod, traversedModules, boundaries)

    // 失效模块（清空缓存，强制重编译）
    environment.moduleGraph.invalidateModule(
      mod,
      invalidatedModules,
      timestamp,
      true,
    )

    // 如果已经需要刷新页面，直接跳过当前模块
    if (needFullReload) {
      continue
    }

    // 如果无法热更（hasDeadEnd）→ 标记需要全页刷新
    if (hasDeadEnd) {
      needFullReload = hasDeadEnd
      continue
    }

    // If import.meta.hot.invalidate was called already on that module for the same update,
    // it means any importer of that module can't hot update. We should fallback to full reload.
    if (
      firstInvalidatedBy &&
      boundaries.some(
        ({ acceptedVia }) =>
          normalizeHmrUrl(acceptedVia.url) === firstInvalidatedBy,
      )
    ) {
      needFullReload = 'circular import invalidate'
      continue
    }

    //  把「热更新边界」变成浏览器可执行的更新指令
    updates.push(
      ...boundaries.map(
        ({ boundary, acceptedVia, isWithinCircularImport }) => ({
          type: `${boundary.type}-update` as const,
          timestamp,
          path: normalizeHmrUrl(boundary.url),
          acceptedPath: normalizeHmrUrl(acceptedVia.url),
          explicitImportRequired:
            boundary.type === 'js'
              ? isExplicitImportRequired(acceptedVia.url)
              : false,
          isWithinCircularImport,
          firstInvalidatedBy,
        }),
      ),
    )
  }

  // html file cannot be hot updated because it may be used as the template for a top-level request response.
  const isClientHtmlChange =
    file.endsWith('.html') &&
    environment.name === 'client' &&
    // if the html file is imported as a module, we assume that this file is
    // not used as the template for top-level request response
    // (i.e. not used by the middleware).
    modules.every((mod) => mod.type !== 'js')

  // 如果需要刷新页面，发送全页刷新指令
  if (needFullReload || isClientHtmlChange) {
    const reason =
      typeof needFullReload === 'string'
        ? colors.dim(` (${needFullReload})`)
        : ''
    environment.logger.info(
      colors.green(`page reload `) + colors.dim(file) + reason,
      { clear: !firstInvalidatedBy, timestamp: true },
    )
    hot.send({
      type: 'full-reload',
      triggeredBy: path.resolve(environment.config.root, file),
      path:
        !isClientHtmlChange ||
        environment.config.server.middlewareMode ||
        updates.length > 0 // if there's an update, other URLs may be affected
          ? '*'
          : '/' + file,
    })
    return
  }

  // 没有需要更新的模块 → 打印日志
  if (updates.length === 0) {
    debugHmr?.(colors.yellow(`no update happened `) + colors.dim(file))
    return
  }

  // 记录热更新的模块路径
  environment.logger.info(
    colors.green(`hmr update `) +
      colors.dim([...new Set(updates.map((u) => u.path))].join(', ')),
    { clear: !firstInvalidatedBy, timestamp: true },
  )
  // 发送热更新到浏览器
  hot.send({
    type: 'update',
    updates,
  })
}

function areAllImportsAccepted(
  importedBindings: Set<string>,
  acceptedExports: Set<string>,
) {
  for (const binding of importedBindings) {
    if (!acceptedExports.has(binding)) {
      return false
    }
  }
  return true
}

/**
 * 向上传播模块更新，计算热更新的边界。它从发生变化的模块开始，向上遍历依赖链，寻找可以接受热更新的模块边界
 * @param node  当前模块
 * @param traversedModules 遍历过的模块集合
 * @param boundaries 热更新边界数组
 * @param currentChain 当前依赖链
 * @returns true 表示可以热更新，false 表示需要全页刷新
 *
 */
function propagateUpdate(
  node: EnvironmentModuleNode,
  traversedModules: Set<EnvironmentModuleNode>,
  boundaries: PropagationBoundary[],
  currentChain: EnvironmentModuleNode[] = [node],
): HasDeadEnd {
  // 循环检测：检查模块是否已经遍历过，避免循环依赖导致的无限遍历
  if (traversedModules.has(node)) {
    return false
  }
  // 添加当前模块到遍历过的模块集合
  traversedModules.add(node)

  // #7561
  // if the imports of `node` have not been analyzed, then `node` has not
  // been loaded in the browser and we should stop propagation.
  // 说明它尚未在浏览器中加载，停止传播
  if (node.id && node.isSelfAccepting === undefined) {
    debugHmr?.(
      `[propagate update] stop propagation because not analyzed: ${colors.dim(
        node.id,
      )}`,
    )
    return false
  }

  // 自接受模块处理
  // 通过 import.meta.hot.accept() 声明的模块，可以接受自身的热更新
  if (node.isSelfAccepting) {
    // isSelfAccepting is only true for js and css
    const boundary = node as EnvironmentModuleNode & { type: 'js' | 'css' }
    boundaries.push({
      boundary, // 边界模块节点
      acceptedVia: boundary, // 被接受模块节点
      // 是否在循环导入链中
      isWithinCircularImport: isNodeWithinCircularImports(node, currentChain),
    })
    return false
  }

  // A partially accepted module with no importers is considered self accepting,
  // because the deal is "there are parts of myself I can't self accept if they
  // are used outside of me".
  // Also, the imported module (this one) must be updated before the importers,
  // so that they do get the fresh imported module when/if they are reloaded.
  // 部分接受模块处理
  if (node.acceptedHmrExports) {
    // acceptedHmrExports is only true for js and css
    const boundary = node as EnvironmentModuleNode & { type: 'js' | 'css' }
    boundaries.push({
      boundary,
      acceptedVia: boundary,
      isWithinCircularImport: isNodeWithinCircularImports(node, currentChain),
    })
  } else {
    if (!node.importers.size) {
      return true
    }
  }

  // 遍历导入者
  for (const importer of node.importers) {
    const subChain = currentChain.concat(importer)

    if (importer.acceptedHmrDeps.has(node)) {
      // acceptedHmrDeps has value only for js and css
      const boundary = importer as EnvironmentModuleNode & {
        type: 'js' | 'css'
      }
      boundaries.push({
        boundary,
        acceptedVia: node,
        isWithinCircularImport: isNodeWithinCircularImports(importer, subChain),
      })
      continue
    }

    if (node.id && node.acceptedHmrExports && importer.importedBindings) {
      const importedBindingsFromNode = importer.importedBindings.get(node.id)
      if (
        importedBindingsFromNode &&
        areAllImportsAccepted(importedBindingsFromNode, node.acceptedHmrExports)
      ) {
        continue
      }
    }

    if (
      !currentChain.includes(importer) &&
      propagateUpdate(importer, traversedModules, boundaries, subChain)
    ) {
      return true
    }
  }
  return false
}

/**
 * Check importers recursively if it's an import loop. An accepted module within
 * an import loop cannot recover its execution order and should be reloaded.
 *
 * @param node The node that accepts HMR and is a boundary
 * @param nodeChain The chain of nodes/imports that lead to the node.
 *   (The last node in the chain imports the `node` parameter)
 * @param currentChain The current chain tracked from the `node` parameter
 * @param traversedModules The set of modules that have traversed
 */
// 用于检测模块是否在循环导入链中。它通过分析模块的导入关系，确定是否存在包含 HMR 接受模块的循环导入
function isNodeWithinCircularImports(
  node: EnvironmentModuleNode,
  nodeChain: EnvironmentModuleNode[],
  currentChain: EnvironmentModuleNode[] = [node],
  traversedModules = new Set<EnvironmentModuleNode>(),
): boolean {
  // To help visualize how each parameter works, imagine this import graph:
  //
  // A -> B -> C -> ACCEPTED -> D -> E -> NODE
  //      ^--------------------------|
  //
  // ACCEPTED: the node that accepts HMR. the `node` parameter.
  // NODE    : the initial node that triggered this HMR.
  //
  // This function will return true in the above graph, which:
  // `node`         : ACCEPTED
  // `nodeChain`    : [NODE, E, D, ACCEPTED]
  // `currentChain` : [ACCEPTED, C, B]
  //
  // It works by checking if any `node` importers are within `nodeChain`, which
  // means there's an import loop with a HMR-accepted module in it.

  // 检查模块是否已经遍历过，避免循环依赖导致的无限遍历
  if (traversedModules.has(node)) {
    return false
  }
  // 添加到已遍历集合
  traversedModules.add(node)

  // 遍历导入者
  for (const importer of node.importers) {
    // Node may import itself which is safe
    // 检查导入者是否是当前节点，如果是，则跳过
    if (importer === node) continue

    // Check circular imports
    // 检查当前导入是否在当前导入链中
    const importerIndex = nodeChain.indexOf(importer)
    // 在导入链中
    if (importerIndex > -1) {
      // Log extra debug information so users can fix and remove the circular imports
      if (debugHmr) {
        // Following explanation above:
        // `importer`                    : E
        // `currentChain` reversed       : [B, C, ACCEPTED]
        // `nodeChain` sliced & reversed : [D, E]
        // Combined                      : [E, B, C, ACCEPTED, D, E]
        const importChain = [
          importer,
          ...[...currentChain].reverse(),
          ...nodeChain.slice(importerIndex, -1).reverse(),
        ]
        debugHmr(
          colors.yellow(`circular imports detected: `) +
            importChain.map((m) => colors.dim(m.url)).join(' -> '),
        )
      }
      // 发现循环导入，返回 true
      return true
    }

    // Continue recursively
    // 不存在当前导入链中
    if (!currentChain.includes(importer)) {
      // 递归检查
      const result = isNodeWithinCircularImports(
        importer,
        nodeChain,
        currentChain.concat(importer),
        traversedModules,
      )
      if (result) return result
    }
  }
  return false
}

/**
 * 用于处理被修剪（pruned）的模块，更新它们的 HMR 时间戳并通知客户端
 */
export function handlePrunedModules(
  mods: Set<EnvironmentModuleNode>,
  { hot }: DevEnvironment,
): void {
  // update the disposed modules' hmr timestamp
  // since if it's re-imported, it should re-apply side effects
  // and without the timestamp the browser will not re-import it!
  const t = monotonicDateNow()
  // 遍历
  mods.forEach((mod) => {
    // 时间戳更新
    mod.lastHMRTimestamp = t
    // 重置失效
    mod.lastHMRInvalidationReceived = false
    debugHmr?.(`[dispose] ${colors.dim(mod.file)}`)
  })
  // 通知客户端
  // 客户端处理：客户端接收到消息后，会从内存中移除这些模块，确保它们在重新导入时能够重新执行
  hot.send({
    type: 'prune',
    paths: [...mods].map((m) => m.url),
  })
}

const enum LexerState {
  inCall,
  inSingleQuoteString,
  inDoubleQuoteString,
  inTemplateString,
  inArray,
}

/**
 * Lex import.meta.hot.accept() for accepted deps.
 * Since hot.accept() can only accept string literals or array of string
 * literals, we don't really need a heavy @babel/parse call on the entire source.
 * Vite 热模块替换（HMR）系统中的一个词法分析函数，
 * 用于解析 import.meta.hot.accept() 调用中的依赖项。
 * 它能够识别并提取 HMR 接受的依赖模块路径，同时判断模块是否为自接受模块。
 *
 * @returns selfAccepts
 */
export function lexAcceptedHmrDeps(
  code: string,
  start: number,
  urls: Set<{ url: string; start: number; end: number }>,
): boolean {
  // 词法分析状态
  let state: LexerState = LexerState.inCall
  // the state can only be 2 levels deep so no need for a stack
  // 前一个状态
  let prevState: LexerState = LexerState.inCall
  // 当前正在分析的依赖路径
  let currentDep: string = ''

  function addDep(index: number) {
    urls.add({
      url: currentDep,
      start: index - currentDep.length - 1,
      end: index + 1,
    })
    currentDep = ''
  }

  // 遍历代码字符
  for (let i = start; i < code.length; i++) {
    const char = code.charAt(i)
    switch (state) {
      // 处理函数调用状态
      case LexerState.inCall:
      case LexerState.inArray: // 处理数组状态（多个依赖项）
        if (char === `'`) {
          prevState = state
          state = LexerState.inSingleQuoteString // 单引号状态
        } else if (char === `"`) {
          prevState = state
          state = LexerState.inDoubleQuoteString // 双引号状态
        } else if (char === '`') {
          prevState = state
          state = LexerState.inTemplateString // 模板字符串状态

          // 空格跳过
        } else if (whitespaceRE.test(char)) {
          continue
        } else {
          // 处理函数调用状态
          if (state === LexerState.inCall) {
            if (char === `[`) {
              state = LexerState.inArray // 数组状态
            } else {
              // reaching here means the first arg is neither a string literal
              // nor an Array literal (direct callback) or there is no arg
              // in both case this indicates a self-accepting module
              return true // done
            }
          } else {
            if (char === `]`) {
              return false // done

              // 逗号跳过
            } else if (char === ',') {
              continue
            } else {
              error(i)
            }
          }
        }
        break
      // 处理单引号字符串
      case LexerState.inSingleQuoteString:
        if (char === `'`) {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else {
          currentDep += char
        }
        break
      // 处理双引号字符串
      case LexerState.inDoubleQuoteString:
        if (char === `"`) {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else {
          currentDep += char
        }
        break
      // 处理模板字符串
      case LexerState.inTemplateString:
        if (char === '`') {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else if (char === '$' && code.charAt(i + 1) === '{') {
          error(i)
        } else {
          currentDep += char
        }
        break
      default:
        throw new Error('unknown import.meta.hot lexer state')
    }
  }
  return false
}

export function lexAcceptedHmrExports(
  code: string,
  start: number,
  exportNames: Set<string>,
): boolean {
  const urls = new Set<{ url: string; start: number; end: number }>()
  lexAcceptedHmrDeps(code, start, urls)
  for (const { url } of urls) {
    exportNames.add(url)
  }
  return urls.size > 0
}

export function normalizeHmrUrl(url: string): string {
  if (url[0] !== '.' && url[0] !== '/') {
    url = wrapId(url)
  }
  return url
}

function error(pos: number) {
  const err = new Error(
    `import.meta.hot.accept() can only accept string literals or an ` +
      `Array of string literals.`,
  ) as RollupError
  err.pos = pos
  throw err
}

// vitejs/vite#610 when hot-reloading Vue files, we read immediately on file
// change event and sometimes this can be too early and get an empty buffer.
// Poll until the file's modified time has changed before reading again.
/**
 * 现象：编辑器（VSCode）保存文件时，操作系统的执行顺序是：
   1、清空文件内容（size = 0）
   2、写入新内容
   问题：
Vite 的文件监听（chokidar）反应极快，在 第 1 步（清空）就触发了 change 事件。
此时 Vite 马上去读文件 → 读到空字符串 → 导致编译报错。
这个函数就是为了：等待文件写入完成，再返回正确内容，避免读到空文件。
 * @param file 文件路径
 * @returns 文件内容
 */
async function readModifiedFile(file: string): Promise<string> {
  // 读取文件内容
  const content = await fsp.readFile(file, 'utf-8')

  // 如果文件内容为空，说明文件被删除了
  // 文件刚刚被编辑器清空，但还没来得及写入新内容。
  if (!content) {
    const mtime = (await fsp.stat(file)).mtimeMs // 记录当前文件修改时间

    // 循环等待：最多等 10 次，每次 10ms（共 100ms）
    for (let n = 0; n < 10; n++) {
      await new Promise((r) => setTimeout(r, 10))
      const newMtime = (await fsp.stat(file)).mtimeMs

      // 如果文件变了（说明写入完成）
      if (newMtime !== mtime) {
        break
      }
    }

    // 读取文件内容
    return await fsp.readFile(file, 'utf-8')
  } else {
    return content
  }
}

export type ServerHotChannelApi = {
  innerEmitter: EventEmitter
  outsideEmitter: EventEmitter
}

export type ServerHotChannel = HotChannel<ServerHotChannelApi>
export type NormalizedServerHotChannel =
  NormalizedHotChannel<ServerHotChannelApi>

/**
 * 用于创建服务器热更新通道。
 * 它提供了一个双向通信机制，用于在 Vite 开发服务器和客户端之间传递热更新信息，是 HMR 系统的重要组成部分。
 * @returns 热更新通道实例
 */
export function createServerHotChannel(): ServerHotChannel {
  // 1、创建事件发射器
  // 用于内部事件通信，如连接事件
  const innerEmitter = new EventEmitter()
  // 用于外部事件通信，如发送热更新 payload
  const outsideEmitter = new EventEmitter()

  // 2、返回热更新通道对象
  return {
    // 发送热更新
    send(payload: HotPayload) {
      // 通过 outsideEmitter 触发 'send' 事件
      outsideEmitter.emit('send', payload)
    },
    // 移除事件监听器
    off(event, listener: () => void) {
      innerEmitter.off(event, listener)
    },
    // 添加事件监听器
    on: ((event: string, listener: () => unknown) => {
      innerEmitter.on(event, listener)
    }) as ServerHotChannel['on'],
    // 关闭通道，移除所有事件监听器
    close() {
      innerEmitter.removeAllListeners()
      outsideEmitter.removeAllListeners()
    },
    // 监听连接事件
    listen() {
      innerEmitter.emit('connection')
    },
    // 提供通道 API 接口
    api: {
      innerEmitter,
      outsideEmitter,
    },
  }
}
