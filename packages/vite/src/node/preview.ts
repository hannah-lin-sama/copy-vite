import fs from 'node:fs'
import path from 'node:path'
import sirv from 'sirv'
import compression from '@polka/compression'
import connect from 'connect'
import corsMiddleware from 'cors'
import type { Connect } from '#dep-types/connect'
import type {
  HttpServer,
  ResolvedServerOptions,
  ResolvedServerUrls,
} from './server'
import { createServerCloseFn } from './server'
import type { CommonServerOptions } from './http'
import {
  httpServerStart,
  resolveHttpServer,
  resolveHttpsConfig,
  setClientErrorHandler,
} from './http'
import { openBrowser } from './server/openBrowser'
import { baseMiddleware } from './server/middlewares/base'
import { htmlFallbackMiddleware } from './server/middlewares/htmlFallback'
import { indexHtmlMiddleware } from './server/middlewares/indexHtml'
import { notFoundMiddleware } from './server/middlewares/notFound'
import { proxyMiddleware } from './server/middlewares/proxy'
import {
  getServerUrlByHost,
  normalizePath,
  resolveHostname,
  resolveServerUrls,
  setupSIGTERMListener,
  shouldServeFile,
  teardownSIGTERMListener,
} from './utils'
import { printServerUrls } from './logger'
import { bindCLIShortcuts } from './shortcuts'
import type { BindCLIShortcutsOptions, ShortcutsState } from './shortcuts'
import { resolveConfig } from './config'
import type { InlineConfig, ResolvedConfig } from './config'
import { DEFAULT_PREVIEW_PORT } from './constants'
import type { RequiredExceptFor } from './typeUtils'
import { hostValidationMiddleware } from './server/middlewares/hostCheck'
import {
  BasicMinimalPluginContext,
  basePluginContextMeta,
} from './server/pluginContainer'
import type { MinimalPluginContextWithoutEnvironment } from './plugin'

export interface PreviewOptions extends CommonServerOptions {}

export interface ResolvedPreviewOptions extends RequiredExceptFor<
  PreviewOptions,
  'host' | 'https' | 'proxy'
> {}

export function resolvePreviewOptions(
  preview: PreviewOptions | undefined,
  server: ResolvedServerOptions,
): ResolvedPreviewOptions {
  // The preview server inherits every CommonServerOption from the `server` config
  // except for the port to enable having both the dev and preview servers running
  // at the same time without extra configuration
  return {
    port: preview?.port ?? DEFAULT_PREVIEW_PORT,
    strictPort: preview?.strictPort ?? server.strictPort,
    host: preview?.host ?? server.host,
    allowedHosts: preview?.allowedHosts ?? server.allowedHosts,
    https: preview?.https ?? server.https,
    open: preview?.open ?? server.open,
    proxy: preview?.proxy ?? server.proxy,
    cors: preview?.cors ?? server.cors,
    headers: preview?.headers ?? server.headers,
  }
}

export interface PreviewServer {
  /**
   * The resolved vite config object
   */
  config: ResolvedConfig
  /**
   * Stop the server.
   */
  close(): Promise<void>
  /**
   * A connect app instance.
   * - Can be used to attach custom middlewares to the preview server.
   * - Can also be used as the handler function of a custom http server
   *   or as a middleware in any connect-style Node.js frameworks
   *
   * https://github.com/senchalabs/connect#use-middleware
   */
  middlewares: Connect.Server
  /**
   * native Node http server instance
   */
  httpServer: HttpServer
  /**
   * The resolved urls Vite prints on the CLI (URL-encoded). Returns `null`
   * if the server is not listening on any port.
   */
  resolvedUrls: ResolvedServerUrls | null
  /**
   * Print server urls
   */
  printUrls(): void
  /**
   * Bind CLI shortcuts
   */
  bindCLIShortcuts(options?: BindCLIShortcutsOptions<PreviewServer>): void
  /**
   * @internal
   */
  _shortcutsState?: ShortcutsState<PreviewServer>
}

export type PreviewServerHook = (
  this: MinimalPluginContextWithoutEnvironment,
  server: PreviewServer,
) => (() => void) | void | Promise<(() => void) | void>

/**
 * Starts the Vite server in preview mode, to simulate a production deployment
 */
export async function preview(
  inlineConfig: InlineConfig = {},
): Promise<PreviewServer> {
  // 解析配置
  const config = await resolveConfig(
    inlineConfig,
    'serve',
    'production',
    'production',
    true,
  )

  // 检查输出目录是否存在
  const clientOutDir = config.environments.client.build.outDir
  // 检查输出目录是否存在
  const distDir = path.resolve(config.root, clientOutDir)

  // 如果不存在，抛出错误
  if (
    !fs.existsSync(distDir) &&
    // error if no plugins implement `configurePreviewServer`
    config.plugins.every((plugin) => !plugin.configurePreviewServer) &&
    // error if called in CLI only. programmatic usage could access `httpServer`
    // and affect file serving
    process.argv[1]?.endsWith(path.normalize('bin/vite.js')) &&
    process.argv[2] === 'preview'
  ) {
    throw new Error(
      `The directory "${clientOutDir}" does not exist. Did you build your project?`,
    )
  }

  const httpsOptions = await resolveHttpsConfig(config.preview.https)
  const app = connect() as Connect.Server // 创建 connect 应用实例
  // 创建 HTTP 服务器
  const httpServer = await resolveHttpServer(app, httpsOptions)
  setClientErrorHandler(httpServer, config.logger)

  const options = config.preview
  const logger = config.logger

  const closeHttpServer = createServerCloseFn(httpServer)

  // Promise used by `server.close()` to ensure `closeServer()` is only called once
  let closeServerPromise: Promise<void> | undefined
  const closeServer = async () => {
    teardownSIGTERMListener(closeServerAndExit)
    await closeHttpServer()
    server.resolvedUrls = null
  }

  const server: PreviewServer = {
    config,
    middlewares: app,
    httpServer,
    async close() {
      if (!closeServerPromise) {
        closeServerPromise = closeServer()
      }
      return closeServerPromise
    },
    resolvedUrls: null,
    printUrls() {
      if (server.resolvedUrls) {
        printServerUrls(server.resolvedUrls, options.host, logger.info)
      } else {
        throw new Error('cannot print server URLs before server is listening.')
      }
    },
    bindCLIShortcuts(options) {
      bindCLIShortcuts(server as PreviewServer, options)
    },
  }

  const closeServerAndExit = async (_: unknown, exitCode?: number) => {
    try {
      await server.close()
    } finally {
      process.exitCode ??= exitCode ? 128 + exitCode : undefined
      process.exit()
    }
  }

  setupSIGTERMListener(closeServerAndExit)

  // cors
  const { cors } = config.preview
  if (cors !== false) {
    app.use(corsMiddleware(typeof cors === 'boolean' ? {} : cors))
  }

  // host check (to prevent DNS rebinding attacks)
  const { allowedHosts } = config.preview
  // no need to check for HTTPS as HTTPS is not vulnerable to DNS rebinding attacks
  if (allowedHosts !== true && !config.preview.https) {
    app.use(hostValidationMiddleware(allowedHosts, true))
  }

  // apply server hooks from plugins
  const configurePreviewServerContext = new BasicMinimalPluginContext(
    { ...basePluginContextMeta, watchMode: false },
    config.logger,
  )
  const postHooks: ((() => void) | void)[] = []
  for (const hook of config.getSortedPluginHooks('configurePreviewServer')) {
    postHooks.push(await hook.call(configurePreviewServerContext, server))
  }

  // proxy
  const { proxy } = config.preview
  if (proxy) {
    app.use(proxyMiddleware(httpServer, proxy, config))
  }

  // 压缩
  app.use(compression())

  // base
  if (config.base !== '/') {
    // base 路径
    app.use(baseMiddleware(config.rawBase, false))
  }

  // static assets
  const headers = config.preview.headers

  /**
   * 负责从构建产物目录 distDir 中读取并返回静态文件(JS、CSS、图片、字体等)
   * @param args
   * @param args sirv 中间件的参数
   * @param args[0] 目录路径
   * @param args[1] 选项对象
   * @param args[2] 回调函数
   * @returns
   */
  const viteAssetMiddleware = (...args: readonly [any, any?, any?]) =>
    // 每次请求都会重新调用 sirv(...),创建一个新的 sirv 实例
    sirv(distDir, {
      etag: true, // 启用 ETag 缓存协商,客户端缓存有效时返回 304,减少带宽
      dev: true, // 开发模式,禁用长期缓存头
      extensions: [], // 不自动补全扩展名
      ignores: false, // 不忽略任何文件
      setHeaders(res) {
        // 自定义响应头
        if (headers) {
          for (const name in headers) {
            res.setHeader(name, headers[name]!)
          }
        }
      },
      shouldServe(filePath) {
        // 自定义是否服务的判断
        return shouldServeFile(filePath, distDir)
      },
    })(...args)

  app.use(viteAssetMiddleware)

  // html fallback
  if (config.appType === 'spa' || config.appType === 'mpa') {
    app.use(htmlFallbackMiddleware(distDir, config.appType === 'spa'))
  }

  // apply post server hooks from plugins
  postHooks.forEach((fn) => fn && fn())

  if (config.appType === 'spa' || config.appType === 'mpa') {
    // transform index.html
    const normalizedDistDir = normalizePath(distDir)
    app.use(indexHtmlMiddleware(normalizedDistDir, server))

    // handle 404s
    // 直接终结响应:把状态码设为 404 并结束响应,不再调用 next()
    app.use(notFoundMiddleware())
  }

  const hostname = await resolveHostname(options.host)

  await httpServerStart(httpServer, {
    port: options.port,
    strictPort: options.strictPort,
    host: hostname.host,
    logger,
  })

  server.resolvedUrls = resolveServerUrls(
    httpServer,
    config.preview,
    hostname,
    httpsOptions,
    config,
  )

  if (options.open) {
    const url = getServerUrlByHost(server.resolvedUrls, options.host)
    if (url) {
      const path =
        typeof options.open === 'string' ? new URL(options.open, url).href : url
      openBrowser(path, true, logger)
    }
  }

  return server as PreviewServer
}
