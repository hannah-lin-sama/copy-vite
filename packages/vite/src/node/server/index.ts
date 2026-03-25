import path from 'node:path'
import { execSync } from 'node:child_process'
import type * as net from 'node:net'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import type * as http from 'node:http'
import { performance } from 'node:perf_hooks'
import type { Http2SecureServer } from 'node:http2'
import connect from 'connect'
import corsMiddleware from 'cors'
import colors from 'picocolors'
import chokidar from 'chokidar'
import launchEditorMiddleware from 'launch-editor-middleware'
import { determineAgent } from '@vercel/detect-agent'
import type { SourceMap } from 'rolldown'
import type { ModuleRunner } from 'vite/module-runner'
import type { FSWatcher, WatchOptions } from '#dep-types/chokidar'
import type { Connect } from '#dep-types/connect'
import type { CommonServerOptions } from '../http'
import type {
  ForwardConsoleOptions,
  ResolvedForwardConsoleOptions,
} from '../../shared/forwardConsole'
import {
  httpServerStart,
  resolveHttpServer,
  resolveHttpsConfig,
  setClientErrorHandler,
} from '../http'
import type { InlineConfig, ResolvedConfig } from '../config'
import { isResolvedConfig, resolveConfig } from '../config'
import {
  type Hostname,
  diffDnsOrderChange,
  getServerUrlByHost,
  isInNodeModules,
  isObject,
  isParentDirectory,
  mergeConfig,
  mergeWithDefaults,
  monotonicDateNow,
  normalizePath,
  resolveHostname,
  resolveServerUrls,
  setupSIGTERMListener,
  teardownSIGTERMListener,
} from '../utils'
import { ssrLoadModule } from '../ssr/ssrModuleLoader'
import { ssrFixStacktrace, ssrRewriteStacktrace } from '../ssr/ssrStacktrace'
import { ssrTransform } from '../ssr/ssrTransform'
import { reloadOnTsconfigChange } from '../plugins/esbuild'
import { bindCLIShortcuts } from '../shortcuts'
import type { BindCLIShortcutsOptions, ShortcutsState } from '../shortcuts'
import {
  CLIENT_DIR,
  DEFAULT_DEV_PORT,
  defaultAllowedOrigins,
} from '../constants'
import type { Logger } from '../logger'
import { printServerUrls } from '../logger'
import { warnFutureDeprecation } from '../deprecations'
import {
  createNoopWatcher,
  getResolvedOutDirs,
  resolveChokidarOptions,
  resolveEmptyOutDir,
} from '../watch'
import { initPublicFiles } from '../publicDir'
import { getEnvFilesForMode } from '../env'
import type { RequiredExceptFor } from '../typeUtils'
import type { MinimalPluginContextWithoutEnvironment } from '../plugin'
import type { PluginContainer } from './pluginContainer'
import {
  BasicMinimalPluginContext,
  basePluginContextMeta,
  createPluginContainer,
} from './pluginContainer'
import type { WebSocketServer } from './ws'
import { createWebSocketServer } from './ws'
import { baseMiddleware } from './middlewares/base'
import { proxyMiddleware } from './middlewares/proxy'
import { htmlFallbackMiddleware } from './middlewares/htmlFallback'
import {
  cachedTransformMiddleware,
  transformMiddleware,
} from './middlewares/transform'
import {
  createDevHtmlTransformFn,
  indexHtmlMiddleware,
} from './middlewares/indexHtml'
import {
  servePublicMiddleware,
  serveRawFsMiddleware,
  serveStaticMiddleware,
} from './middlewares/static'
import { timeMiddleware } from './middlewares/time'
import { ModuleGraph } from './mixedModuleGraph'
import type { ModuleNode } from './mixedModuleGraph'
import { notFoundMiddleware } from './middlewares/notFound'
import { errorMiddleware } from './middlewares/error'
import type { HmrOptions, NormalizedHotChannel } from './hmr'
import { handleHMRUpdate, updateModules } from './hmr'
import { openBrowser as _openBrowser } from './openBrowser'
import type { TransformOptions, TransformResult } from './transformRequest'
import { searchForPackageRoot, searchForWorkspaceRoot } from './searchRoot'
import type { DevEnvironment } from './environment'
import { hostValidationMiddleware } from './middlewares/hostCheck'
import { rejectInvalidRequestMiddleware } from './middlewares/rejectInvalidRequest'
import { memoryFilesMiddleware } from './middlewares/memoryFiles'
import { rejectNoCorsRequestMiddleware } from './middlewares/rejectNoCorsRequest'

const usedConfigs = new WeakSet<ResolvedConfig>()

export interface ServerOptions extends CommonServerOptions {
  /**
   * Configure HMR-specific options (port, host, path & protocol)
   * 配置热模块替换（HMR）的行为
   */
  hmr?: HmrOptions | boolean
  /**
   * Do not start the websocket connection.
   * 完全禁用 WebSocket 连接（包括 HMR）
   * @experimental
   */
  ws?: false
  /**
   * Warm-up files to transform and cache the results in advance. This improves the
   * initial page load during server starts and prevents transform waterfalls.
   * 预热文件，即在开发服务器启动后立即转换并缓存指定文件，避免首次访问时的瀑布式编译，加快初始页面加载。
   */
  warmup?: {
    /**
     * The files to be transformed and used on the client-side. Supports glob patterns.
     * 客户端需要预热的文件（支持 glob 模式）
     */
    clientFiles?: string[]
    /**
     * The files to be transformed and used in SSR. Supports glob patterns.
     * 服务端渲染需要预热的文件
     */
    ssrFiles?: string[]
  }
  /**
   * chokidar watch options or null to disable FS watching
   * https://github.com/paulmillr/chokidar/tree/3.6.0#api
   * 配置文件监听器（底层使用 chokidar）的选项
   * null 完全禁用文件监听（此时修改文件不会触发 HMR）
   */
  watch?: WatchOptions | null
  /**
   * Create Vite dev server to be used as a middleware in an existing server
   * 将 Vite 开发服务器作为中间件挂载到现有的 Node.js 服务器上（
   * @default false
   */
  middlewareMode?:
    | boolean // true 表示中间件模式，Vite 不会创建 HTTP 服务器，只提供中间件
    | {
        /**
         * Parent server instance to attach to
         *
         * This is needed to proxy WebSocket connections to the parent server.
         */
        server: HttpServer
      }
  /**
   * Options for files served via '/\@fs/'.
   * 控制通过 /@fs/ 路径访问的文件系统的行为，例如限制访问根目录、允许符号链接等
   */
  fs?: FileSystemServeOptions
  /**
   * Origin for the generated asset URLs.
   * 指定生成资源 URL 时的源
   * @example `http://127.0.0.1:8080`
   */
  origin?: string
  /**
   * Pre-transform known direct imports
   * 是否预先转换已知的直接导入（即在 HTML 解析前提前转换依赖），以提升页面加载速度。
   * @default true
   */
  preTransformRequests?: boolean
  /**
   * Whether or not to ignore-list source files in the dev server sourcemap, used to populate
   * the [`x_google_ignoreList` source map extension](https://developer.chrome.com/blog/devtools-better-angular-debugging/#the-x_google_ignorelist-source-map-extension).
   *
   * By default, it excludes all paths containing `node_modules`. You can pass `false` to
   * disable this behavior, or, for full control, a function that takes the source path and
   * sourcemap path and returns whether to ignore the source path.
   * 配置 Chrome DevTools 的 x_google_ignoreList 源映射扩展，用于隐藏 node_modules 等第三方库的源文件，使调试时只显示项目源码。
   */
  sourcemapIgnoreList?:
    | false
    | ((sourcePath: string, sourcemapPath: string) => boolean)
  /**
   * Backward compatibility. The buildStart and buildEnd hooks were called only once for
   * the client environment. This option enables per-environment buildStart and buildEnd hooks.
   * 控制开发模式下是否对每个环境独立调用 buildStart 和 buildEnd 钩子。
   * @default false
   * @experimental
   */
  perEnvironmentStartEndDuringDev?: boolean
  /**
   * Backward compatibility. The watchChange hook was called only once for the client environment.
   * This option enables per-environment watchChange hooks.
   * 控制 watchChange 钩子是否按环境分别调用
   * @default false
   * @experimental
   */
  perEnvironmentWatchChangeDuringDev?: boolean
  /**
   * Run HMR tasks, by default the HMR propagation is done in parallel for all environments
   * 自定义 HMR 更新时哪些环境需要处理热更新。
   * @experimental
   */
  hotUpdateEnvironments?: (
    server: ViteDevServer,
    hmr: (environment: DevEnvironment) => Promise<void>,
  ) => Promise<void>

  // 将浏览器的控制台输出（console.log、error 等）通过 WebSocket 转发到服务器终端，方便调试。
  forwardConsole?: boolean | ForwardConsoleOptions
}

export interface ResolvedServerOptions extends Omit<
  RequiredExceptFor<
    ServerOptions,
    | 'host'
    | 'https'
    | 'proxy'
    | 'hmr'
    | 'ws'
    | 'watch'
    | 'origin'
    | 'hotUpdateEnvironments'
  >,
  'fs' | 'middlewareMode' | 'sourcemapIgnoreList' | 'forwardConsole'
> {
  fs: Required<FileSystemServeOptions>
  middlewareMode: NonNullable<ServerOptions['middlewareMode']>
  sourcemapIgnoreList: Exclude<
    ServerOptions['sourcemapIgnoreList'],
    false | undefined
  >
  forwardConsole: ResolvedForwardConsoleOptions
}

export interface FileSystemServeOptions {
  /**
   * Strictly restrict file accessing outside of allowing paths.
   *
   * Set to `false` to disable the warning
   *
   * @default true
   */
  strict?: boolean

  /**
   * Restrict accessing files outside the allowed directories.
   *
   * Accepts absolute path or a path relative to project root.
   * Will try to search up for workspace root by default.
   */
  allow?: string[]

  /**
   * Restrict accessing files that matches the patterns.
   *
   * This will have higher priority than `allow`.
   * picomatch patterns are supported.
   *
   * @default ['.env', '.env.*', '*.{crt,pem}', '**\/.git/**']
   */
  deny?: string[]
}

export type ServerHook = (
  this: MinimalPluginContextWithoutEnvironment,
  server: ViteDevServer,
) => (() => void) | void | Promise<(() => void) | void>

export type HttpServer = http.Server | Http2SecureServer

export async function resolveForwardConsoleOptions(
  value: boolean | ForwardConsoleOptions | undefined,
): Promise<ResolvedForwardConsoleOptions> {
  value ??= (await determineAgent()).isAgent

  if (value === false) {
    return {
      enabled: false,
      unhandledErrors: false,
      logLevels: [],
    }
  }

  if (value === true) {
    return {
      enabled: true,
      unhandledErrors: true,
      logLevels: ['error', 'warn'],
    }
  }

  const unhandledErrors = value.unhandledErrors ?? true
  const logLevels = value.logLevels ?? []

  return {
    enabled: unhandledErrors || logLevels.length > 0,
    unhandledErrors,
    logLevels,
  }
}

export interface ViteDevServer {
  /**
   * The resolved vite config object
   * 暴露最终解析后的 Vite 配置
   */
  config: ResolvedConfig
  /**
   * A connect app instance.
   * - Can be used to attach custom middlewares to the dev server.
   * - Can also be used as the handler function of a custom http server
   *   or as a middleware in any connect-style Node.js frameworks
   *
   * https://github.com/senchalabs/connect#use-middleware
   * Connect 框架的中间件容器，可挂载自定义中间件
   */
  middlewares: Connect.Server
  /**
   * native Node http server instance
   * will be null in middleware mode
   * Node 原生 HTTP 服务器实例
   */
  httpServer: HttpServer | null
  /**
   * Chokidar watcher instance. If `config.server.watch` is set to `null`,
   * it will not watch any files and calling `add` or `unwatch` will have no effect.
   * https://github.com/paulmillr/chokidar/tree/3.6.0#api
   * Chokidar 文件监听实例，监听项目文件变更，触发模块更新 / 热更新
   */
  watcher: FSWatcher
  /**
   * WebSocket server with `send(payload)` method
   * WebSocket 服务端，用于向客户端推送 HMR 消息（如模块更新、页面刷新）
   */
  ws: WebSocketServer
  /**
   * An alias to `server.environments.client.hot`.
   * If you want to interact with all environments, loop over `server.environments`.
   * HMR 通道别名（指向 environments.client.hot）
   */
  hot: NormalizedHotChannel
  /**
   * Rollup plugin container that can run plugin hooks on a given file
   * Rollup 插件容器，可手动触发插件钩子
   */
  pluginContainer: PluginContainer
  /**
   * Module execution environments attached to the Vite server.
   * 模块执行环境（客户端 / SSR / 自定义）
   */
  environments: Record<'client' | 'ssr' | (string & {}), DevEnvironment>
  /**
   * Module graph that tracks the import relationships, url to file mapping
   * and hmr state.
   * 模块依赖图，追踪模块间的导入关系、URL → 文件映射、HMR 状态
   */
  moduleGraph: ModuleGraph
  /**
   * The resolved urls Vite prints on the CLI (URL-encoded). Returns `null`
   * in middleware mode or if the server is not listening on any port.
   * 服务器启动后的访问 URL
   */
  resolvedUrls: ResolvedServerUrls | null
  /**
   * Programmatically resolve, load and transform a URL and get the result
   * without going through the http request pipeline.
   * 手动解析、加载、转换指定 URL 的模块（跳过 HTTP 流程），插件可用于预编译模块
   */
  transformRequest(
    url: string,
    options?: TransformOptions,
  ): Promise<TransformResult | null>
  /**
   * Same as `transformRequest` but only warm up the URLs so the next request
   * will already be cached. The function will never throw as it handles and
   * reports errors internally.
   * 预热指定 URL 的模块（缓存转换结果），提升后续请求性能，不会抛出错误
   */
  warmupRequest(url: string, options?: TransformOptions): Promise<void>
  /**
   * Apply vite built-in HTML transforms and any plugin HTML transforms.
   */
  transformIndexHtml(
    url: string,
    html: string,
    originalUrl?: string,
  ): Promise<string>
  /**
   * Transform module code into SSR format.
   * 将模块代码转换为 SSR 兼容格式（如处理 ESM → CJS）
   */
  ssrTransform(
    code: string,
    inMap: SourceMap | { mappings: '' } | null,
    url: string,
    originalCode?: string,
  ): Promise<TransformResult | null>
  /**
   * Load a given URL as an instantiated module for SSR.
   * 加载指定 URL 的模块并实例化为 SSR 可用的模块对象
   */
  ssrLoadModule(
    url: string,
    opts?: { fixStacktrace?: boolean },
  ): Promise<Record<string, any>>
  /**
   * Returns a fixed version of the given stack
   * 修复 SSR 报错的堆栈信息（映射到原始文件行号）
   */
  ssrRewriteStacktrace(stack: string): string
  /**
   * Mutates the given SSR error by rewriting the stacktrace
   * 直接修改 SSR 错误对象的堆栈信息，提升调试体验
   */
  ssrFixStacktrace(e: Error): void
  /**
   * Triggers HMR for a module in the module graph. You can use the `server.moduleGraph`
   * API to retrieve the module to be reloaded. If `hmr` is false, this is a no-op.
   * 重加载模块
   */
  reloadModule(module: ModuleNode): Promise<void>
  /**
   * Start the server.
   * 启动开发服务器（指定端口 / 标记是否为重启），返回服务器实例
   */
  listen(port?: number, isRestart?: boolean): Promise<ViteDevServer>
  /**
   * Stop the server.
   * 关闭服务器（停止监听、释放资源），用于自定义脚本的优雅退出
   */
  close(): Promise<void>
  /**
   * Print server urls
   * 打印服务器访问 URL（同 CLI 启动时的 URL 输出）
   */
  printUrls(): void
  /**
   * Bind CLI shortcuts
   */
  bindCLIShortcuts(options?: BindCLIShortcutsOptions<ViteDevServer>): void
  /**
   * Restart the server.
   *
   * @param forceOptimize - force the optimizer to re-bundle, same as --force cli flag
   */
  restart(forceOptimize?: boolean): Promise<void>
  /**
   * Open browser
   * 自动打开浏览器并访问服务器 URL，提升开发体验
   */
  openBrowser(): void
  /**
   * Calling `await server.waitForRequestsIdle(id)` will wait until all static imports
   * are processed. If called from a load or transform plugin hook, the id needs to be
   * passed as a parameter to avoid deadlocks. Calling this function after the first
   * static imports section of the module graph has been processed will resolve immediately.
   * 等待所有静态导入处理完成（避免插件钩子死锁），适用于 load/transform 钩子中
   */
  waitForRequestsIdle: (ignoredId?: string) => Promise<void>
  /**
   * @internal
   * 绑定 / 替换内部服务器实例
   */
  _setInternalServer(server: ViteDevServer): void
  /**
   * @internal
   * 维护服务器「重启
   */
  _restartPromise: Promise<void> | null
  /**
   * @internal
   * 标记「重启服务器时是否强制重新执行依赖预优化」
   */
  _forceOptimizeOnRestart: boolean
  /**
   * @internal
   * 维护 CLI 快捷键的状态（如 Vite 开发服务器启动后，按 r 重启、u 显示 URL、q 退出）
   */
  _shortcutsState?: ShortcutsState<ViteDevServer>
  /**
   * @internal
   * 记录服务器「实际监听的端口号」
   */
  _currentServerPort?: number | undefined
  /**
   * @internal
   * 存储用户配置的 server.port 值（未经过端口冲突处理）
   */
  _configServerPort?: number | undefined
  /**
   * @internal
   * 为 SSR 提供「模块运行时兼容层」，解决不同 Node 版本 / 模块规范的兼容性问题
   */
  _ssrCompatModuleRunner?: ModuleRunner
}

export interface ResolvedServerUrls {
  local: string[]
  network: string[]
}

/**
 * 创建 Vite 开发服务器
 * @param inlineConfig 配置对象
 * @returns 服务器实例
 */
export function createServer(
  inlineConfig: InlineConfig | ResolvedConfig = {},
): Promise<ViteDevServer> {
  return _createServer(inlineConfig, { listen: true })
}

/**
 * 创建 Vite 开发服务器
 * @param inlineConfig 配置对象
 * @param options 选项对象
 * @param options.listen 是否立即监听端口
 * @param options.previousEnvironments 上一个环境对象
 * @param options.previousShortcutsState 上一个快捷键状态对象
 * @returns 服务器实例
 */
export async function _createServer(
  inlineConfig: ResolvedConfig | InlineConfig | undefined = {},
  options: {
    listen: boolean
    previousEnvironments?: Record<string, DevEnvironment>
    previousShortcutsState?: ShortcutsState<ViteDevServer>
  },
): Promise<ViteDevServer> {

  const config = isResolvedConfig(inlineConfig)
    ? inlineConfig
    : await resolveConfig(inlineConfig, 'serve') // 确保是 serve 命令

  // 检查该配置是否已经关联过服务器
  if (usedConfigs.has(config)) {
    throw new Error(`There is already a server associated with the config.`)
  }

  if (config.command !== 'serve') {
    throw new Error(
      `Config was resolved for a "build", expected a "serve" command.`,
    )
  }

  usedConfigs.add(config)

  // 异步初始化 public 目录的文件列表
  const initPublicFilesPromise = initPublicFiles(config)

  const { root, server: serverConfig } = config
  // 解析 HTTPS 配置
  const httpsOptions = await resolveHttpsConfig(config.server.https)
  const { middlewareMode } = serverConfig // 获取中间件模式

  // 获取解析后的输出目录
  const resolvedOutDirs = getResolvedOutDirs(
    config.root,
    config.build.outDir,
    config.build.rollupOptions.output, // 解析 Rollup 输出选项，rollupOptions 已废弃
  )
  // 解析空输出目录
  const emptyOutDir = resolveEmptyOutDir(
    config.build.emptyOutDir,
    config.root,
    resolvedOutDirs,
  )
  // 文件监视器（chokidar）配置
  const resolvedWatchOptions = resolveChokidarOptions(
    {
      disableGlobbing: true,
      ...serverConfig.watch,
    },
    resolvedOutDirs,
    emptyOutDir,
    config.cacheDir,
  )

  const middlewares = connect() as Connect.Server

  // middlewareMode 为 true 时，不解析 HTTP 服务器，以中间件模式创建；否则解析 HTTP 服务器
  const httpServer = middlewareMode
    ? null
    : await resolveHttpServer(middlewares, httpsOptions)

  // 创建 WebSocket 服务器
  const ws = createWebSocketServer(httpServer, config, httpsOptions)

  const publicFiles = await initPublicFilesPromise
  const { publicDir } = config

  if (httpServer) {
    setClientErrorHandler(httpServer, config.logger)
  }

  // eslint-disable-next-line eqeqeq
  // 检查是否启用文件监视
  const watchEnabled = serverConfig.watch !== null
  // 文件监视器实例化
  const watcher = watchEnabled
    ? (chokidar.watch(
        // config file dependencies and env file might be outside of root
        [
          ...(config.experimental.bundledDev ? [] : [root]),
          ...config.configFileDependencies,
          ...getEnvFilesForMode(config.mode, config.envDir),
          // Watch the public directory explicitly because it might be outside
          // of the root directory.
          ...(publicDir && publicFiles ? [publicDir] : []),
        ],

        resolvedWatchOptions,
      ) as FSWatcher)
    : createNoopWatcher(resolvedWatchOptions)

  // 初始化环境对象
  const environments: Record<string, DevEnvironment> = {}

  // 多环境（Environments）初始化
  await Promise.all(
    Object.entries(config.environments).map(
      async ([name, environmentOptions]) => {
        const environment = await environmentOptions.dev.createEnvironment(
          name,
          config,
          {
            ws,
          },
        )
        environments[name] = environment

        const previousInstance =
          options.previousEnvironments?.[environment.name]
        await environment.init({ watcher, previousInstance })
      },
    ),
  )

  // Backward compatibility
  // 向后兼容与服务器对象构建
  let moduleGraph = new ModuleGraph({
    client: () => environments.client.moduleGraph,
    ssr: () => environments.ssr.moduleGraph,
  })
  let pluginContainer = createPluginContainer(environments)

  const closeHttpServer = createServerCloseFn(httpServer)

  const devHtmlTransformFn = createDevHtmlTransformFn(config)

  // Promise used by `server.close()` to ensure `closeServer()` is only called once
  let closeServerPromise: Promise<void> | undefined

  // 关闭服务器
  const closeServer = async () => {
    if (!middlewareMode) {
      teardownSIGTERMListener(closeServerAndExit)
    }

    // 关闭所有资源
    await Promise.allSettled([
      watcher.close(), // 关闭文件监视器
      ws.close(), // 关闭 WebSocket 服务器
      Promise.allSettled(
        Object.values(server.environments).map((environment) =>
          environment.close(), // 关闭每个环境
        ),
      ),
      closeHttpServer(), // 关闭 HTTP 服务器
      server._ssrCompatModuleRunner?.close(), // 关闭 SSR 兼容模块运行器
    ])
    server.resolvedUrls = null
    server._ssrCompatModuleRunner = undefined
  }

  let hot = ws

  // 构建 server 对象
  let server: ViteDevServer = {
    config,
    middlewares,
    httpServer,
    watcher,
    ws, // WebSocket 服务器实例
    get hot() {
      warnFutureDeprecation(config, 'removeServerHot')
      return hot // 返回 WebSocket 服务器实例
    },
    set hot(h) {
      hot = h // 设置 WebSocket 服务器实例
    },

    environments,
    get pluginContainer() {
      warnFutureDeprecation(config, 'removeServerPluginContainer')
      return pluginContainer
    },
    set pluginContainer(p) {
      pluginContainer = p
    },
    get moduleGraph() {
      warnFutureDeprecation(config, 'removeServerModuleGraph')
      return moduleGraph
    },
    set moduleGraph(graph) {
      moduleGraph = graph
    },

    resolvedUrls: null, // will be set on listen
    ssrTransform(
      code: string,
      inMap: SourceMap | { mappings: '' } | null,
      url: string,
      originalCode = code,
    ) {
      return ssrTransform(code, inMap, url, originalCode, {
        json: {
          stringify:
            config.json.stringify === true && config.json.namedExports !== true,
        },
      })
    },
    transformRequest(url, options) {
      warnFutureDeprecation(config, 'removeServerTransformRequest')
      const environment = server.environments[options?.ssr ? 'ssr' : 'client']
      return environment.transformRequest(url)
    },
    warmupRequest(url, options) {
      warnFutureDeprecation(config, 'removeServerWarmupRequest')
      const environment = server.environments[options?.ssr ? 'ssr' : 'client']
      return environment.warmupRequest(url)
    },
    transformIndexHtml(url, html, originalUrl) {
      return devHtmlTransformFn(server, url, html, originalUrl)
    },
    async ssrLoadModule(url, opts?: { fixStacktrace?: boolean }) {
      warnFutureDeprecation(config, 'removeSsrLoadModule')
      return ssrLoadModule(url, server, opts?.fixStacktrace)
    },
    ssrFixStacktrace(e) {
      warnFutureDeprecation(
        config,
        'removeSsrLoadModule',
        "ssrFixStacktrace doesn't need to be used for Environment Module Runners.",
      )
      ssrFixStacktrace(e, server.environments.ssr.moduleGraph)
    },
    ssrRewriteStacktrace(stack: string) {
      warnFutureDeprecation(
        config,
        'removeSsrLoadModule',
        "ssrRewriteStacktrace doesn't need to be used for Environment Module Runners.",
      )
      return ssrRewriteStacktrace(stack, server.environments.ssr.moduleGraph)
        .result
    },
    async reloadModule(module) {
      warnFutureDeprecation(config, 'removeServerReloadModule')
      if (serverConfig.hmr !== false && module.file) {
        // TODO: Should we also update the node moduleGraph for backward compatibility?
        const environmentModule = (module._clientModule ?? module._ssrModule)!
        updateModules(
          environments[environmentModule.environment]!,
          module.file,
          [environmentModule],
          monotonicDateNow(),
        )
      }
    },
    // 启动 HTTP 服务器监听指定端口
    async listen(port?: number, isRestart?: boolean) {
      // 解析主机名
      const hostname = await resolveHostname(config.server.host)
      if (httpServer) {
        httpServer.prependListener('listening', () => {
          // 解析服务器监听的 URL 地址
          server.resolvedUrls = resolveServerUrls(
            httpServer,
            config.server,
            hostname,
            httpsOptions,
            config,
          )
        })
      }
      // 启动 HTTP 服务器
      await startServer(server, hostname, port)
      if (httpServer) {
        // 如果不是重启,配置了 open 选项打开浏览器
        if (!isRestart && config.server.open) server.openBrowser()
      }
      return server
    },
    openBrowser() {
      const options = server.config.server
      const url = getServerUrlByHost(server.resolvedUrls, options.host)
      if (url) {
        const path =
          typeof options.open === 'string'
            ? new URL(options.open, url).href
            : url

        // We know the url that the browser would be opened to, so we can
        // start the request while we are awaiting the browser. This will
        // start the crawling of static imports ~500ms before.
        // preTransformRequests needs to be enabled for this optimization.
        if (server.config.server.preTransformRequests) {
          setTimeout(() => {
            const getMethod = path.startsWith('https:') ? httpsGet : httpGet

            getMethod(
              path,
              {
                headers: {
                  // Allow the history middleware to redirect to /index.html
                  Accept: 'text/html',
                },
              },
              (res) => {
                res.on('end', () => {
                  // Ignore response, scripts discovered while processing the entry
                  // will be preprocessed (server.config.server.preTransformRequests)
                })
              },
            )
              .on('error', () => {
                // Ignore errors
              })
              .end()
          }, 0)
        }

        _openBrowser(path, true, server.config.logger)
      } else {
        server.config.logger.warn('No URL available to open in browser')
      }
    },
    async close() {
      if (!closeServerPromise) {
        closeServerPromise = closeServer()
      }
      return closeServerPromise
    },
    printUrls() {
      // 打印服务器监听的 URL 地址
      if (server.resolvedUrls) {
        printServerUrls(
          server.resolvedUrls,
          serverConfig.host,
          config.logger.info,
        )
      } else if (middlewareMode) {
        throw new Error('cannot print server URLs in middleware mode.')
      } else {
        throw new Error(
          'cannot print server URLs before server.listen is called.',
        )
      }
    },
    // 绑定 CLI 短键
    bindCLIShortcuts(options) {
      bindCLIShortcuts(server, options)
    },
    async restart(forceOptimize?: boolean) {
      if (!server._restartPromise) {
        server._forceOptimizeOnRestart = !!forceOptimize
        server._restartPromise = restartServer(server).finally(() => {
          server._restartPromise = null
          server._forceOptimizeOnRestart = false
        })
      }
      return server._restartPromise
    },

    waitForRequestsIdle(ignoredId?: string): Promise<void> {
      return environments.client.waitForRequestsIdle(ignoredId)
    },

    _setInternalServer(_server: ViteDevServer) {
      // Rebind internal the server variable so functions reference the user
      // server instance after a restart
      server = _server
    },
    _restartPromise: null,
    _forceOptimizeOnRestart: false,
    _shortcutsState: options.previousShortcutsState,
  }

  // maintain consistency with the server instance after restarting.
  const reflexServer = new Proxy(server, {
    get: (_, property: keyof ViteDevServer) => {
      return server[property]
    },
    set: (_, property: keyof ViteDevServer, value: never) => {
      server[property] = value
      return true
    },
  })

  /**
   * 关闭服务器并退出进程
   * @param _ 
   * @param exitCode 退出码
   */
  const closeServerAndExit = async (_: unknown, exitCode?: number) => {
    try {
      // 关闭服务器
      await server.close()
    } finally {
      process.exitCode ??= exitCode ? 128 + exitCode : undefined
      // 退出进程
      process.exit()
    }
  }

  // 非中间件模式下,监听 SIGTERM 信号,关闭服务器并退出进程
  if (!middlewareMode) {
    setupSIGTERMListener(closeServerAndExit)
  }

  /**
   * 处理 HMR 更新
   * @param type 文件操作类型
   * @param file 文件路径
   */
  const onHMRUpdate = async (
    type: 'create' | 'delete' | 'update',
    file: string,
  ) => {
    // 如果 HMR 已启用,则处理 HMR 更新
    if (serverConfig.hmr !== false) {
      await handleHMRUpdate(type, file, server)
    }
  }

  /**
   * 处理文件添加或删除事件
   * @param file 文件路径
   * @param isUnlink 是否删除文件
   */
  const onFileAddUnlink = async (file: string, isUnlink: boolean) => {
    file = normalizePath(file)
    // 「检测文件是否为 tsconfig.json/jsconfig.json，若是则触发服务器重启」
    // 因为这类配置文件变更会影响模块解析规则，必须重启才能生效。
    reloadOnTsconfigChange(server, file)

    await Promise.all(
      // 通知所有环境的插件容器，同步文件变更事件
      Object.values(server.environments).map((environment) =>
        environment.pluginContainer.watchChange(file, {
          event: isUnlink ? 'delete' : 'create',
        }),
      ),
    )

    if (publicDir && publicFiles) {
      if (file.startsWith(publicDir)) {
        const path = file.slice(publicDir.length)
        publicFiles[isUnlink ? 'delete' : 'add'](path)

        // 新增文件时：清理同名模块的 ETag 缓存，保证公共文件优先响应
        // Vite 会为模块生成 ETag（实体标签），用于「ETag 快速路径」—— 客户端请求时，若 ETag 未变，直接返回缓存的模块内容
        if (!isUnlink) {
          const clientModuleGraph = server.environments.client.moduleGraph
          const moduleWithSamePath =
            await clientModuleGraph.getModuleByUrl(path)

          const etag = moduleWithSamePath?.transformResult?.etag
          if (etag) {
            // The public file should win on the next request over a module with the
            // same path. Prevent the transform etag fast path from serving the module
            clientModuleGraph.etagToModuleMap.delete(etag)
          }
        }
      }
    }
    // 文件删除时，清理模块依赖图缓存
    if (isUnlink) {
      // invalidate module graph cache on file change
      for (const environment of Object.values(server.environments)) {
        environment.moduleGraph.onFileDelete(file)
      }
    }
    // 触发 HMR 更新，同步变更到客户端
    await onHMRUpdate(isUnlink ? 'delete' : 'create', file)
  }

  // 监听文件变化事件
  watcher.on('change', async (file) => {
    file = normalizePath(file)
    reloadOnTsconfigChange(server, file)

    await Promise.all(
      Object.values(server.environments).map((environment) =>
        environment.pluginContainer.watchChange(file, { event: 'update' }),
      ),
    )
    // invalidate module graph cache on file change
    for (const environment of Object.values(server.environments)) {
      environment.moduleGraph.onFileChange(file)
    }
    await onHMRUpdate('update', file)
  })

  // 监听文件添加事件
  watcher.on('add', (file) => {
    onFileAddUnlink(file, false)
  })
  // 监听文件删除事件
  watcher.on('unlink', (file) => {
    onFileAddUnlink(file, true)
  })

  // 非中间件模式下,监听 HTTP 服务器启动事件,更新实际端口号
  if (!middlewareMode && httpServer) {
    httpServer.once('listening', () => {
      // update actual port since this may be different from initial value
      serverConfig.port = (httpServer.address() as net.AddressInfo).port
    })
  }

  // Pre applied internal middlewares ------------------------------------------

  // request timer
  if (process.env.DEBUG) {
    // 用于记录请求处理时间
    middlewares.use(timeMiddleware(root))
  }

  // 用于拒绝无效请求，如请求路径包含空格等
  middlewares.use(rejectInvalidRequestMiddleware())
  // 用于拒绝没有 CORS 头的请求
  middlewares.use(rejectInvalidRequestMiddleware())
  middlewares.use(rejectNoCorsRequestMiddleware())

  // cors
  const { cors } = serverConfig
  if (cors !== false) {
    // 配置 CORS 中间件
    middlewares.use(corsMiddleware(typeof cors === 'boolean' ? {} : cors))
  }

  // host check (to prevent DNS rebinding attacks)
  const { allowedHosts } = serverConfig
  // no need to check for HTTPS as HTTPS is not vulnerable to DNS rebinding attacks
  if (allowedHosts !== true && !serverConfig.https) {
    // 配置主机验证中间件
    // 用于防止 DNS 重定向攻击，确保服务器仅响应指定主机的请求
    middlewares.use(hostValidationMiddleware(allowedHosts, false))
  }

  // apply configureServer hooks ------------------------------------------------

  const configureServerContext = new BasicMinimalPluginContext(
    { ...basePluginContextMeta, watchMode: true },
    config.logger,
  )
  const postHooks: ((() => void) | void)[] = []
  // 调用所有插件的 configureServer 钩子函数
  for (const hook of config.getSortedPluginHooks('configureServer')) {
    postHooks.push(await hook.call(configureServerContext, reflexServer))
  }

  // Internal middlewares ------------------------------------------------------

  // 没有配置 bundledDev 时，使用缓存变换中间件
  if (!config.experimental.bundledDev) {
    middlewares.use(cachedTransformMiddleware(server))
  }

  // proxy
  const { proxy } = serverConfig
  // 配置代理中间件
  // 用于将请求转发到其他服务器，如 API 服务器
  if (proxy) {
    const middlewareServer =
      (isObject(middlewareMode) ? middlewareMode.server : null) || httpServer
    middlewares.use(proxyMiddleware(middlewareServer, proxy, config))
  }

  // base
  if (config.base !== '/') {
    // 配置基础路径中间件
    // 用于处理请求路径中的基础路径，确保服务器正确响应请求
    middlewares.use(baseMiddleware(config.rawBase, !!middlewareMode))
  }

  // open in editor support
  // 配置打开编辑器中间件
  // 用于在开发环境下，点击页面上的链接时，自动打开对应的文件在编辑器中编辑
  middlewares.use('/__open-in-editor', launchEditorMiddleware())

  // ping request handler
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  // 配置 HMR 指令中间件
  middlewares.use(function viteHMRPingMiddleware(req, res, next) {
    if (req.headers['accept'] === 'text/x-vite-ping') {
      res.writeHead(204).end()
    } else {
      next()
    }
  })

  // serve static files under /public
  // this applies before the transform middleware so that these files are served
  // as-is without transforms.
  // 配置静态文件中间件
  // 用于处理 /public 目录下的静态文件，如图片、字体等
  if (publicDir) {
    middlewares.use(servePublicMiddleware(server, publicFiles))
  }

  // 配置内存文件中间件
  if (config.experimental.bundledDev) {
    middlewares.use(memoryFilesMiddleware(server))
  } else {
    // main transform middleware
    // 用于处理请求，将请求转换为 Vite 可以处理的格式
    middlewares.use(transformMiddleware(server))

    // serve static files
    // 用于处理静态文件，如图片、字体等
    middlewares.use(serveRawFsMiddleware(server))
    middlewares.use(serveStaticMiddleware(server))
  }

  // html fallback
  // 配置 HTML 回退中间件
  if (config.appType === 'spa' || config.appType === 'mpa') {
    middlewares.use(
      htmlFallbackMiddleware(
        root,
        config.appType === 'spa',
        server.environments.client,
      ),
    )
  }

  // apply configureServer post hooks ------------------------------------------

  // This is applied before the html middleware so that user middleware can
  // serve custom content instead of index.html.
  // 调用所有插件的 configureServer 钩子函数
  postHooks.forEach((fn) => fn && fn())

  if (config.appType === 'spa' || config.appType === 'mpa') {
    // transform index.html
    // 用于处理 index.html 文件，将其中的动态内容替换为 Vite 生成的静态文件
    middlewares.use(indexHtmlMiddleware(root, server))

    // handle 404s
    // 用于处理 404 错误，返回自定义的 HTML 页面
    middlewares.use(notFoundMiddleware())
  }

  // error handler
  // 用于处理服务器错误，返回自定义的 HTML 页面
  middlewares.use(errorMiddleware(server, !!middlewareMode))

  // httpServer.listen can be called multiple times
  // when port when using next port number
  // this code is to avoid calling buildStart multiple times
  let initingServer: Promise<void> | undefined
  let serverInited = false // 标记服务器是否已初始化
  
  const initServer = async (onListen: boolean) => {
    if (serverInited) return // 如果服务器已初始化,直接返回
    if (initingServer) return initingServer // 如果服务器正在初始化,直接返回

    initingServer = (async function () {
      // 如果没有配置 bundledDev,则在初始化服务器时调用 buildStart 方法
      if (!config.experimental.bundledDev) {
        // For backward compatibility, we call buildStart for the client
        // environment when initing the server. For other environments
        // buildStart will be called when the first request is transformed
        await environments.client.pluginContainer.buildStart()
      }

      // ensure ws server started
      // 确保 WebSocket 服务器已启动
      if (onListen || options.listen) {
        await Promise.all(
          // 确保所有环境的服务器都启动
          Object.values(environments).map((e) => e.listen(server)),
        )
      }

      initingServer = undefined // 清空初始化 Promise
      serverInited = true // 标记服务器已初始化
    })()
    return initingServer
  }

  if (!middlewareMode && httpServer) {
    // overwrite listen to init optimizer before server start
    const listen = httpServer.listen.bind(httpServer)
    // 重写 listen 方法，确保在服务器启动前初始化优化器
    httpServer.listen = (async (port: number, ...args: any[]) => {
      try {
        await initServer(true)
      } catch (e) {
        httpServer.emit('error', e)
        return
      }
      // 调用原始 listen 方法启动服务器
      return listen(port, ...args)
    }) as any
  } else {
    await initServer(false)
  }

  return server
}

/**
 * 启动 Vite 开发服务器
 * @param server Vite 开发服务器实例
 * @param hostname 主机名或 IP 地址
 * @param port 端口号
 * @param inlinePort 重写配置口号
 */
async function startServer(
  server: ViteDevServer,
  hostname: Hostname,
  inlinePort?: number,
): Promise<void> {
  const httpServer = server.httpServer
  // 如果 HTTP 服务器实例不存在,直接抛出错误
  if (!httpServer) {
    throw new Error('Cannot call server.listen in middleware mode.')
  }

  const options = server.config.server // 获取服务器配置
  const configPort = inlinePort ?? options.port // 获取配置口号
  // When using non strict port for the dev server, the running port can be different from the config one.
  // When restarting, the original port may be available but to avoid a switch of URL for the running
  // browser tabs, we enforce the previously used port, expect if the config port changed.
  const port =
    (!configPort || configPort === server._configServerPort
      ? server._currentServerPort
      : configPort) ?? DEFAULT_DEV_PORT // 默认端口号为 5173

  server._configServerPort = configPort // 记录配置口号

  // 启动 HTTP 服务器
  const serverPort = await httpServerStart(httpServer, {
    port,
    strictPort: options.strictPort,
    host: hostname.host,
    logger: server.config.logger,
  })
  // 记录实际启动的端口号
  server._currentServerPort = serverPort
}

/**
 * 创建关闭 HTTP 服务器的函数
 * @param server HTTP 服务器实例
 * @returns 关闭函数
 */
export function createServerCloseFn(
  server: HttpServer | null,
): () => Promise<void> {

  // 如果服务器实例不存在,直接返回空函数
  if (!server) {
    return () => Promise.resolve()
  }

  let hasListened = false // 标记服务器是否已启动
  const openSockets = new Set<net.Socket>() // 记录所有打开的套接字

  // 监听连接事件,记录所有打开的套接字
  server.on('connection', (socket) => {
    openSockets.add(socket) // 记录打开的套接字
    // 监听套接字关闭事件,从集合中删除套接字
    socket.on('close', () => {
      openSockets.delete(socket) // 从集合中删除套接字
    })
  })

  // 监听服务器启动事件,只监听一次
  server.once('listening', () => {
    hasListened = true // 标记服务器已启动
  })

  return () =>
    new Promise<void>((resolve, reject) => {
      // 关闭所有打开的套接字
      openSockets.forEach((s) => s.destroy())
      if (hasListened) {
        // 关闭服务器
        server.close((err) => {
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      } else {
        resolve()
      }
    })
}

function resolvedAllowDir(root: string, dir: string): string {
  return normalizePath(path.resolve(root, dir))
}

const _serverConfigDefaults = Object.freeze({
  port: DEFAULT_DEV_PORT,
  strictPort: false,
  host: 'localhost',
  allowedHosts: [],
  https: undefined,
  open: false,
  proxy: undefined,
  cors: { origin: defaultAllowedOrigins },
  headers: {},
  // hmr
  // ws
  warmup: {
    clientFiles: [],
    ssrFiles: [],
  },
  // watch
  middlewareMode: false,
  fs: {
    strict: true,
    // allow
    deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**'],
  },
  // origin
  preTransformRequests: true,
  // sourcemapIgnoreList
  perEnvironmentStartEndDuringDev: false,
  perEnvironmentWatchChangeDuringDev: false,
  // hotUpdateEnvironments
  forwardConsole: undefined,
} satisfies ServerOptions)
export const serverConfigDefaults: Readonly<Partial<ServerOptions>> =
  _serverConfigDefaults

export async function resolveServerOptions(
  root: string,
  raw: ServerOptions | undefined,
  logger: Logger,
): Promise<ResolvedServerOptions> {
  const _server = mergeWithDefaults(
    {
      ..._serverConfigDefaults,
      host: undefined, // do not set here to detect whether host is set or not
      sourcemapIgnoreList: isInNodeModules,
    },
    raw ?? {},
  )

  const server: ResolvedServerOptions = {
    ..._server,
    fs: {
      ..._server.fs,
      // run searchForWorkspaceRoot only if needed
      allow: raw?.fs?.allow ?? [searchForWorkspaceRoot(root)],
    },
    sourcemapIgnoreList:
      _server.sourcemapIgnoreList === false
        ? () => false
        : _server.sourcemapIgnoreList,
    forwardConsole: await resolveForwardConsoleOptions(_server.forwardConsole),
  }

  let allowDirs = server.fs.allow

  if (process.versions.pnp) {
    // running a command fails if cwd doesn't exist and root may not exist
    // search for package root to find a path that exists
    const cwd = searchForPackageRoot(root)
    try {
      const enableGlobalCache =
        execSync('yarn config get enableGlobalCache', { cwd })
          .toString()
          .trim() === 'true'
      const yarnCacheDir = execSync(
        `yarn config get ${enableGlobalCache ? 'globalFolder' : 'cacheFolder'}`,
        { cwd },
      )
        .toString()
        .trim()
      allowDirs.push(yarnCacheDir)
    } catch (e) {
      logger.warn(`Get yarn cache dir error: ${e.message}`, {
        timestamp: true,
      })
    }
  }

  allowDirs = allowDirs.map((i) => resolvedAllowDir(root, i))

  // only push client dir when vite itself is outside-of-root
  const resolvedClientDir = resolvedAllowDir(root, CLIENT_DIR)
  if (!allowDirs.some((dir) => isParentDirectory(dir, resolvedClientDir))) {
    allowDirs.push(resolvedClientDir)
  }

  server.fs.allow = allowDirs

  if (server.origin?.endsWith('/')) {
    server.origin = server.origin.slice(0, -1)
    logger.warn(
      colors.yellow(
        `${colors.bold('(!)')} server.origin should not end with "/". Using "${
          server.origin
        }" instead.`,
      ),
    )
  }

  if (
    process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS &&
    Array.isArray(server.allowedHosts)
  ) {
    const additionalHost = process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS
    server.allowedHosts = [...server.allowedHosts, additionalHost]
  }

  return server
}

/**
 * 重启 Vite 服务器
 * @param server Vite 服务器实例
 * @returns 
 */
async function restartServer(server: ViteDevServer) {
  // 重置服务器启动时间
  global.__vite_start_time = performance.now()

  let inlineConfig = server.config.inlineConfig 
  // 合并配置
  if (server._forceOptimizeOnRestart) {
    inlineConfig = mergeConfig(inlineConfig, {
      forceOptimizeDeps: true, // 强制优化依赖
    })
  }

  // Reinit the server by creating a new instance using the same inlineConfig
  // This will trigger a reload of the config file and re-create the plugins and
  // middlewares. We then assign all properties of the new server to the existing
  // server instance and set the user instance to be used in the new server.
  // This allows us to keep the same server instance for the user.
  {
    let newServer: ViteDevServer | null = null
    try {
      // delay ws server listen
      newServer = await _createServer(inlineConfig, {
        listen: false,
        previousEnvironments: server.environments,
        previousShortcutsState: server._shortcutsState,
      })
    } catch (err: any) {
      server.config.logger.error(err.message, {
        timestamp: true,
      })
      server.config.logger.error('server restart failed', { timestamp: true })
      return
    }

    // Detach readline so close handler skips it. Reused to avoid stdin issues
    server._shortcutsState = undefined

    await server.close()

    // Assign new server props to existing server instance
    const middlewares = server.middlewares
    newServer._configServerPort = server._configServerPort
    newServer._currentServerPort = server._currentServerPort
    newServer._restartPromise = server._restartPromise
    newServer._forceOptimizeOnRestart = server._forceOptimizeOnRestart
    Object.assign(server, newServer)

    // Keep the same connect instance so app.use(vite.middlewares) works
    // after a restart in middlewareMode (.route is always '/')
    middlewares.stack = newServer.middlewares.stack
    server.middlewares = middlewares

    // Rebind internal server variable so functions reference the user server
    newServer._setInternalServer(server)
  }

  const {
    logger,
    server: { port, middlewareMode },
  } = server.config
  if (!middlewareMode) {
    await server.listen(port, true)
  } else {
    await Promise.all(
      Object.values(server.environments).map((e) => e.listen(server)),
    )
  }
  logger.info('server restarted.', { timestamp: true })

  if (
    (server._shortcutsState as ShortcutsState<ViteDevServer> | undefined)
      ?.options
  ) {
    bindCLIShortcuts(
      server,
      { print: false },
      // Skip environment checks since shortcuts were bound before restart
      true,
    )
  }
}

/**
 * Internal function to restart the Vite server and print URLs if changed
 */
export async function restartServerWithUrls(
  server: ViteDevServer,
): Promise<void> {
  if (server.config.server.middlewareMode) {
    await server.restart()
    return
  }

  const { port: prevPort, host: prevHost } = server.config.server
  const prevUrls = server.resolvedUrls

  await server.restart()

  const {
    logger,
    server: { port, host },
  } = server.config
  if (
    (port ?? DEFAULT_DEV_PORT) !== (prevPort ?? DEFAULT_DEV_PORT) ||
    host !== prevHost ||
    diffDnsOrderChange(prevUrls, server.resolvedUrls)
  ) {
    logger.info('')
    server.printUrls()
  }
}
