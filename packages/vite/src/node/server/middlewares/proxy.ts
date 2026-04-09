import type * as http from 'node:http'
import * as httpProxy from 'http-proxy-3'
import colors from 'picocolors'
import type { Connect } from '#dep-types/connect'
import { createDebugger } from '../../utils'
import type { CommonServerOptions, ResolvedConfig } from '../..'
import type { HttpServer } from '..'

const debug = createDebugger('vite:proxy')

export interface ProxyOptions extends httpProxy.ServerOptions {
  /**
   * rewrite path 重写请求路径
   * 接收原始路径，返回新路径。常用于去掉代理前缀。
   */
  rewrite?: (path: string) => string
  /**
   * configure the proxy server (e.g. listen to events)
   * 提供一个钩子，允许直接访问底层 http-proxy 实例，用于监听事件或自定义行为。
   */
  configure?: (proxy: httpProxy.ProxyServer, options: ProxyOptions) => void
  /**
   * webpack-dev-server style bypass function
   * 绕过代理，直接由 Vite 开发服务器处理请求
   */
  bypass?: (
    req: http.IncomingMessage,
    /** undefined for WebSocket upgrade requests */
    res: http.ServerResponse | undefined,
    options: ProxyOptions,
  ) =>
    | void
    | null
    | undefined
    | false
    | string
    | Promise<void | null | undefined | boolean | string>
  /**
   * rewrite the Origin header of a WebSocket request to match the target
   * 重写 WebSocket 请求的 Origin 头，使其与代理目标匹配。
   *
   * **Exercise caution as rewriting the Origin can leave the proxying open to [CSRF attacks](https://owasp.org/www-community/attacks/csrf).**
   * 安全警告：官方文档明确警告，重写 Origin 可能导致 CSRF 攻击，应谨慎使用。
   */
  rewriteWsOrigin?: boolean | undefined
}

const rewriteOriginHeader = (
  proxyReq: http.ClientRequest,
  options: ProxyOptions,
  config: ResolvedConfig,
) => {
  // Browsers may send Origin headers even with same-origin
  // requests. It is common for WebSocket servers to check the Origin
  // header, so if rewriteWsOrigin is true we change the Origin to match
  // the target URL.
  if (options.rewriteWsOrigin) {
    const { target } = options

    if (proxyReq.headersSent) {
      config.logger.warn(
        colors.yellow(
          `Unable to rewrite Origin header as headers are already sent.`,
        ),
      )
      return
    }

    if (proxyReq.getHeader('origin') && target) {
      const changedOrigin =
        typeof target === 'object'
          ? `${target.protocol ?? 'http:'}//${target.host}`
          : target

      proxyReq.setHeader('origin', changedOrigin)
    }
  }
}

/**
 * 代理中间件
 *
 * @param httpServer HTTP 服务器实例
 * @param options 代理选项
 * @param config 配置对象
 * @returns 中间件函数
 */
export function proxyMiddleware(
  httpServer: HttpServer | null,
  options: NonNullable<CommonServerOptions['proxy']>,
  config: ResolvedConfig,
): Connect.NextHandleFunction {
  
  // lazy require only when proxy is used
  const proxies: Record<string, [httpProxy.ProxyServer, ProxyOptions]> = {}

  // 1、为每个代理规则创建实例
  Object.keys(options).forEach((context) => {
    // 每个代理规则
    // 每个键 context 是路径匹配模式（字符串或正则），值可以是字符串（简写）或对象（完整配置）。
    let opts = options[context]
    if (!opts) {
      return
    }
    // 如果是字符串，自动转换为对象并设置 changeOrigin: true（默认开启）
    if (typeof opts === 'string') {
      opts = { 
        target: opts, 
        changeOrigin: true 
      }
    }
    // 创建代理服务器
    // 代理服务器负责将请求转发到目标服务器，同时处理响应并将其返回给客户端。
    const proxy = httpProxy.createProxyServer(opts)

    if (opts.configure) {
      opts.configure(proxy, opts)
    }

    // 每个实例监听错误事件，记录错误信息并返回错误响应
    proxy.on('error', (err, _req, res) => {
      // When it is ws proxy, res is net.Socket
      if ('req' in res) {
        config.logger.error(
          `${colors.red(`http proxy error: ${res.req.url}`)}\n${err.stack}`,
          {
            timestamp: true,
            error: err,
          },
        )
        if (!res.headersSent && !res.writableEnded) {
          res
            .writeHead(502, {
              'Content-Type': 'text/plain',
            })
            .end()
        }
      } else {
        config.logger.error(`${colors.red(`ws proxy error:`)}\n${err.stack}`, {
          timestamp: true,
          error: err,
        })
        res.end()
      }
    })

    // 绑定 proxyReqWs 事件
    proxy.on('proxyReqWs', (proxyReq, _req, socket, options) => {
      // 在转发 WebSocket 请求前，调用 rewriteOriginHeader 可能修改 Origin 
      rewriteOriginHeader(proxyReq, options, config)

      // 监听 WebSocket 连接错误事件
      socket.on('error', (err) => {
        config.logger.error(
          `${colors.red(`ws proxy socket error:`)}\n${err.stack}`,
          {
            timestamp: true,
            error: err,
          },
        )
      })
    })

    // clone before saving because http-proxy mutates the options
    proxies[context] = [proxy, { ...opts }]
  })

  // WebSocket 升级处理
  if (httpServer) {
    httpServer.on('upgrade', async (req, socket, head) => {
      const url = req.url!

      // 遍历所有代理规则
      for (const context in proxies) {
        // 检查当前代理规则是否匹配请求 URL
        if (doesProxyContextMatchUrl(context, url)) {
          const [proxy, opts] = proxies[context]

          // 检查当前代理规则是否为 WebSocket 代理
          if (
            opts.ws ||
            opts.target?.toString().startsWith('ws:') ||
            opts.target?.toString().startsWith('wss:')
          ) {
            if (opts.bypass) {
              try {
                const bypassResult = await opts.bypass(req, undefined, opts)
                if (typeof bypassResult === 'string') {
                  debug?.(`bypass: ${req.url} -> ${bypassResult}`)
                  req.url = bypassResult
                  return
                }
                if (bypassResult === false) {
                  debug?.(`bypass: ${req.url} -> 404`)
                  socket.end('HTTP/1.1 404 Not Found\r\n\r\n', '')
                  return
                }
              } catch (err) {
                config.logger.error(
                  `${colors.red(`ws proxy bypass error:`)}\n${err.stack}`,
                  {
                    timestamp: true,
                    error: err,
                  },
                )
                return
              }
            }

            // 重写URL
            if (opts.rewrite) {
              req.url = opts.rewrite(url)
            }
            debug?.(`${req.url} -> ws ${opts.target}`)
            // 转发
            proxy.ws(req, socket, head)
            return
          }
        }
      }
    })
  }

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return async function viteProxyMiddleware(req, res, next) {
    const url = req.url!
    // 遍历所有代理规则
    for (const context in proxies) {
      // 检查当前代理规则是否匹配请求 URL
      if (doesProxyContextMatchUrl(context, url)) {
        const [proxy, opts] = proxies[context]
        const options: httpProxy.ServerOptions = {}

        // bypass 机制：允许开发者绕过代理，返回静态文件或 mock 数据，非常灵活
        if (opts.bypass) {
          try {
            const bypassResult = await opts.bypass(req, res, opts)

            // 如果 bypass 返回字符串，则修改 req.url 并继续下一个中间件
            if (typeof bypassResult === 'string') {
              debug?.(`bypass: ${req.url} -> ${bypassResult}`)
              req.url = bypassResult
              if (res.writableEnded) {
                return
              }
              return next()
            }

            // 如果返回 false，直接返回 404
            if (bypassResult === false) {
              debug?.(`bypass: ${req.url} -> 404`)
              res.statusCode = 404
              return res.end()
            }
            // 如果抛出异常，则传递给 next(e)
          } catch (e) {
            debug?.(`bypass: ${req.url} -> ${e}`)
            return next(e)
          }
        }

        debug?.(`${req.url} -> ${opts.target || opts.forward}`)
        if (opts.rewrite) {
          req.url = opts.rewrite(req.url!)
        }
        // 求转发给目标服务器
        proxy.web(req, res, options)
        return
      }
    }
    next()
  }
}

/**
 * 
 * @param context 用户配置的代理规则键，例如 '/api' 或 '^/api/.*'
 * @param url  当前请求的路径（如 /api/users）
 * @returns 
 */
function doesProxyContextMatchUrl(context: string, url: string): boolean {
  return (
    // 正则表达式匹配
    (context[0] === '^' && new RegExp(context).test(url)) ||
    // 前缀匹配
    url.startsWith(context)
  )
}
