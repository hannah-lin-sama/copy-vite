import type { Connect } from '#dep-types/connect'
import { joinUrlSegments, stripBase } from '../../utils'
import { cleanUrl, withTrailingSlash } from '../../../shared/utils'

// this middleware is only active when (base !== '/')
/**
 *
 * @param rawBase 原始 base 路径(如 /my-app/
 * @param middlewareMode 是否处于中间件模式(Vite 作为后端框架的中间件嵌入时为 true)
 * @returns
 */
export function baseMiddleware(
  rawBase: string,
  middlewareMode: boolean,
): Connect.NextHandleFunction {
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteBaseMiddleware(req, res, next) {
    const url = req.url!
    const pathname = cleanUrl(url)
    const base = rawBase

    if (pathname.startsWith(base)) {
      // rewrite url to remove base. this ensures that other middleware does
      // not need to consider base being prepended or not
      // 重写 URL，移除 base路径
      req.url = stripBase(url, base)
      return next()
    }

    // skip redirect and error fallback on middleware mode, #4057
    if (middlewareMode) {
      return next()
    }

    // 根路径访问 —— 302 重定向到 base
    if (pathname === '/' || pathname === '/index.html') {
      // redirect root visit to based url with search and hash
      res.writeHead(302, {
        Location: base + url.slice(pathname.length),
      })
      res.end()
      return
    }

    // non-based page visit
    // 非 base 的页面访问 —— 404 友好提示
    const redirectPath =
      withTrailingSlash(url) !== base ? joinUrlSegments(base, url) : base

    if (req.headers.accept?.includes('text/html')) {
      res.writeHead(404, {
        'Content-Type': 'text/html',
      })
      res.end(
        `The server is configured with a public base URL of ${base} - ` +
          `did you mean to visit <a href="${redirectPath}">${redirectPath}</a> instead?`,
      )
      return
    } else {
      // not found for resources
      res.writeHead(404, {
        'Content-Type': 'text/plain',
      })
      res.end(
        `The server is configured with a public base URL of ${base} - ` +
          `did you mean to visit ${redirectPath} instead?`,
      )
      return
    }
  }
}
