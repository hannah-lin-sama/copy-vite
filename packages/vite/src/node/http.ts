import fsp from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import type { OutgoingHttpHeaders as HttpServerHeaders } from 'node:http'
import type { ServerOptions as HttpsServerOptions } from 'node:https'
import colors from 'picocolors'
import type { Connect } from '#dep-types/connect'
import type { ProxyOptions } from './server/middlewares/proxy'
import type { Logger } from './logger'
import type { HttpServer } from './server'
import { wildcardHosts } from './constants'

export interface CommonServerOptions {
  /**
   * Specify server port. Note if the port is already being used, Vite will
   * automatically try the next available port so this may not be the actual
   * port the server ends up listening on.
   * 指定服务器监听的端口号。
   */
  port?: number
  /**
   * If enabled, vite will exit if specified port is already in use
   * 是否严格检查端口号是否已被占用。
   */
  strictPort?: boolean
  /**
   * Specify which IP addresses the server should listen on.
   * Set to 0.0.0.0 to listen on all addresses, including LAN and public addresses.
   * 指定服务器监听的 IP 地址。
   */
  host?: string | boolean
  /**
   * The hostnames that Vite is allowed to respond to.
   * `localhost` and subdomains under `.localhost` and all IP addresses are allowed by default.
   * When using HTTPS, this check is skipped.
   *
   * If a string starts with `.`, it will allow that hostname without the `.` and all subdomains under the hostname.
   * For example, `.example.com` will allow `example.com`, `foo.example.com`, and `foo.bar.example.com`.
   *
   * If set to `true`, the server is allowed to respond to requests for any hosts.
   * This is not recommended as it will be vulnerable to DNS rebinding attacks.
   * 限制哪些主机名（Host 头）可以访问开发服务器，用于防范 DNS 重绑定攻击
   */
  allowedHosts?: string[] | true
  /**
   * Enable TLS + HTTP/2.
   * Note: this downgrades to TLS only when the proxy option is also used.
   * 启用 HTTPS（HTTP/2），并配置证书
   */
  https?: HttpsServerOptions
  /**
   * Open browser window on startup
   * 是否在启动时打开浏览器窗口。
   */
  open?: boolean | string
  /**
   * Configure custom proxy rules for the dev server. Expects an object
   * of `{ key: options }` pairs.
   * Uses [`http-proxy-3`](https://github.com/sagemathinc/http-proxy-3).
   * Full options [here](https://github.com/sagemathinc/http-proxy-3#options).
   *
   * Example `vite.config.js`:
   * ``` js
   * module.exports = {
   *   proxy: {
   *     // string shorthand: /foo -> http://localhost:4567/foo
   *     '/foo': 'http://localhost:4567',
   *     // with options
   *     '/api': {
   *       target: 'http://jsonplaceholder.typicode.com',
   *       changeOrigin: true,
   *       rewrite: path => path.replace(/^\/api/, '')
   *     }
   *   }
   * }
   * ```
   */
  proxy?: Record<string, string | ProxyOptions>
  /**
   * Configure CORS for the dev server.
   * Uses https://github.com/expressjs/cors.
   *
   * When enabling this option, **we recommend setting a specific value
   * rather than `true`** to avoid exposing the source code to untrusted origins.
   *
   * Set to `true` to allow all methods from any origin, or configure separately
   * using an object.
   *
   * @default false
   */
  cors?: CorsOptions | boolean
  /**
   * Specify server response headers.
   */
  headers?: HttpServerHeaders
}

/**
 * https://github.com/expressjs/cors#configuration-options
 */
export interface CorsOptions {
  /**
   * Configures the Access-Control-Allow-Origin CORS header.
   *
   * **We recommend setting a specific value rather than
   * `true`** to avoid exposing the source code to untrusted origins.
   */
  origin?:
    | CorsOrigin
    | ((
        origin: string | undefined,
        cb: (err: Error, origins: CorsOrigin) => void,
      ) => void)
  methods?: string | string[]
  allowedHeaders?: string | string[]
  exposedHeaders?: string | string[]
  credentials?: boolean
  maxAge?: number
  preflightContinue?: boolean
  optionsSuccessStatus?: number
}

export type CorsOrigin = boolean | string | RegExp | (string | RegExp)[]

/**
 * 创建 HTTP 服务器
 * 
 * @param app Connect 应用
 * @param httpsOptions HTTPS 服务器选项
 * @returns HTTP 服务器
 */
export async function resolveHttpServer(
  app: Connect.Server,
  httpsOptions?: HttpsServerOptions,
): Promise<HttpServer> {
  // 如果没有 httpsOptions，创建 HTTP 服务器
  if (!httpsOptions) {
    // http 模块在 net 的基础上增加了 HTTP 协议解析和封装能力。
    // 当你创建一个 HTTP 服务器时，实际底层是一个 net.Server
    const { createServer } = await import('node:http')
    return createServer(app) // 创建 HTTP 服务器
  }

  // 如果有 httpsOptions，创建 HTTPS 服务器
  const { createSecureServer } = await import('node:http2')
  return createSecureServer(
    {
      // Manually increase the session memory to prevent 502 ENHANCE_YOUR_CALM
      // errors on large numbers of requests
      maxSessionMemory: 1000, // 增加会话内存，防止 502 错误
      // Increase the stream reset rate limit to prevent net::ERR_HTTP2_PROTOCOL_ERROR
      // errors on large numbers of requests
      streamResetBurst: 100000, // 增加流重置突发量，防止 net::ERR_HTTP2_PROTOCOL_ERROR 错误
      streamResetRate: 33, // 增加流重置速率，防止 net::ERR_HTTP2_PROTOCOL_ERROR 错误
      ...httpsOptions, // 合并 httpsOptions 选项
      allowHTTP1: true, // 允许 HTTP/1 协议
    },
    // @ts-expect-error TODO: is this correct?
    app,
  )
}

/**
 * 解析 HTTPS 服务器配置
 * 
 * @param https HTTPS 服务器选项
 * @returns 解析后的 HTTPS 服务器选项
 */
export async function resolveHttpsConfig(
  https: HttpsServerOptions | undefined,
): Promise<HttpsServerOptions | undefined> {
  // 如果没有 https 服务器，直接返回 undefined
  if (!https) return undefined

  // 解析 ca、cert、key、pfx 文件
  const [ca, cert, key, pfx] = await Promise.all([
    readFileIfExists(https.ca),
    readFileIfExists(https.cert),
    readFileIfExists(https.key),
    readFileIfExists(https.pfx),
  ])
  // 合并 ca、cert、key、pfx 文件内容到 https 服务器选项
  return { ...https, ca, cert, key, pfx }
}

async function readFileIfExists(value?: string | Buffer | any[]) {
  if (typeof value === 'string') {
    return fsp.readFile(path.resolve(value)).catch(() => value)
  }
  return value
}

// Check if a port is available on wildcard addresses (0.0.0.0, ::)
async function isPortAvailable(port: number): Promise<boolean> {
  for (const host of wildcardHosts) {
    // Gracefully handle errors (e.g., IPv6 disabled on the system)
    const available = await tryListen(port, host).catch(() => true)
    if (!available) return false
  }
  return true
}

/**
 * 尝试监听指定端口号
 * @param port 端口号
 * @param host 主机名
 * @returns 是否监听成功
 */
function tryListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    // 创建 TCP 服务器
    // net 模块：提供最底层的 TCP（传输控制协议）网络通信，可以创建 TCP 服务器和客户端，处理原始的 socket 连接。
    const server = net.createServer()
    server.once('error', (e: NodeJS.ErrnoException) => {
      server.close(() => resolve(e.code !== 'EADDRINUSE'))
    })
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, host)
  })
}

/**
 * 尝试绑定 HTTP 服务器到指定端口号
 * @param httpServer HTTP 服务器实例
 * @param port 端口号
 * @param host 主机名
 * @returns 绑定结果
 */
async function tryBindServer(
  httpServer: HttpServer,
  port: number,
  host: string | undefined,
): Promise<
  { success: true } | { success: false; error: NodeJS.ErrnoException }
> {
  return new Promise((resolve) => {
    const onError = (e: NodeJS.ErrnoException) => {
      httpServer.off('error', onError)
      httpServer.off('listening', onListening)
      resolve({ success: false, error: e })
    }
    const onListening = () => {
      // 监听成功后移除错误监听和监听事件
      httpServer.off('error', onError)
      httpServer.off('listening', onListening)
      resolve({ success: true })
    }

    // 监听错误事件和监听事件
    httpServer.on('error', onError)
    httpServer.on('listening', onListening)

    // 启动 HTTP 服务器监听指定端口号
    httpServer.listen(port, host)
  })
}

const MAX_PORT = 65535

/**
 * 启动 HTTP 服务器
 * @param httpServer HTTP 服务器实例
 * @param serverOptions 服务器选项
 * @returns 实际启动的端口号
 */
export async function httpServerStart(
  httpServer: HttpServer,
  serverOptions: {
    port: number
    strictPort: boolean | undefined
    host: string | undefined
    logger: Logger
  },
): Promise<number> {
  const { port: startPort, strictPort, host, logger } = serverOptions

  // 遍历端口号范围,查找可用端口号
  for (let port = startPort; port <= MAX_PORT; port++) {
    // Pre-check port availability on wildcard addresses (0.0.0.0, ::)
    // so that we avoid conflicts with other servers listening on all interfaces
    if (await isPortAvailable(port)) {
      const result = await tryBindServer(httpServer, port, host)
      if (result.success) {
        return port // 返回实际启动的端口号
      }
      if (result.error.code !== 'EADDRINUSE') {
        throw result.error
      }
    }

    // 如果严格端口号,则抛出错误
    if (strictPort) {
      throw new Error(`Port ${port} is already in use`)
    }

    logger.info(`Port ${port} is in use, trying another one...`)
  }
  throw new Error(
    `No available ports found between ${startPort} and ${MAX_PORT}`,
  )
}

/**
 * 设置 HTTP 客户端错误处理程序
 * @param server HTTP 服务器实例
 * @param logger 日志记录器
 */
export function setClientErrorHandler(
  server: HttpServer,
  logger: Logger,
): void {
  server.on('clientError', (err, socket) => {
    let msg = '400 Bad Request'
    if ((err as any).code === 'HPE_HEADER_OVERFLOW') {
      msg = '431 Request Header Fields Too Large'
      logger.warn(
        colors.yellow(
          'Server responded with status code 431. ' +
            'See https://vite.dev/guide/troubleshooting.html#_431-request-header-fields-too-large.',
        ),
      )
    }
    if ((err as any).code === 'ECONNRESET' || !socket.writable) {
      return
    }
    socket.end(`HTTP/1.1 ${msg}\r\n\r\n`)
  })
}
