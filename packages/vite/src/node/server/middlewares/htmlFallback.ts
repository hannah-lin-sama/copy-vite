import path from 'node:path'
import fs from 'node:fs'
import type { Connect } from '#dep-types/connect'
import { createDebugger, joinUrlSegments } from '../../utils'
import { cleanUrl } from '../../../shared/utils'
import type { DevEnvironment } from '../environment'
import { FullBundleDevEnvironment } from '../environments/fullBundleEnvironment'

const debug = createDebugger('vite:html-fallback')

/**
 * 用于处理 HTML 回退，确保单页应用 (SPA) 能够正常工作，并处理各种 HTML 文件的请求情况。
 * @param root 根目录
 * @param spaFallback 是否开启 SPA fallback
 * @param clientEnvironment 开发环境
 * @returns 中间件函数
 */
export function htmlFallbackMiddleware(
  root: string,
  spaFallback: boolean,
  clientEnvironment?: DevEnvironment,
): Connect.NextHandleFunction {
  // 内存文件系统
  const memoryFiles =
    clientEnvironment instanceof FullBundleDevEnvironment
      ? clientEnvironment.memoryFiles
      : undefined

  // 检测文件是否存在
  function checkFileExists(relativePath: string) {
    return (
      memoryFiles?.has(
        relativePath.slice(1), // remove first /
      ) ?? fs.existsSync(path.join(root, relativePath))
    )
  }

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteHtmlFallbackMiddleware(req, _res, next) {
    // 检查请求是否是 GET 或 HEAD 方法
    // 排除默认的 favicon 请求
    // 要求 Accept: text/html 或 /
    if (
      // Only accept GET or HEAD
      (req.method !== 'GET' && req.method !== 'HEAD') ||
      // Exclude default favicon requests
      req.url === '/favicon.ico' ||
      // Require Accept: text/html or */*
      !(
        req.headers.accept === undefined || // equivalent to `Accept: */*`
        req.headers.accept === '' || // equivalent to `Accept: */*`
        req.headers.accept.includes('text/html') ||
        req.headers.accept.includes('*/*')
      )
    ) {
      return next()
    }

    // 移除查询参数
    const url = cleanUrl(req.url!)
    let pathname
    try {
      pathname = decodeURIComponent(url)
    } catch {
      // ignore malformed URI
      return next()
    }

    // .html files are not handled by serveStaticMiddleware
    // so we need to check if the file exists
    // 以 .html 结尾的路径
    if (pathname.endsWith('.html')) {
      if (checkFileExists(pathname)) {
        debug?.(`Rewriting ${req.method} ${req.url} to ${url}`)
        req.url = url
        return next()
      }
    }
    // trailing slash should check for fallback index.html
    else if (pathname.endsWith('/')) {
      if (checkFileExists(joinUrlSegments(pathname, 'index.html'))) {
        const newUrl = url + 'index.html'
        debug?.(`Rewriting ${req.method} ${req.url} to ${newUrl}`)
        req.url = newUrl
        return next()
      }
    }
    // non-trailing slash should check for fallback .html
    // 其他路径：检查 .html 文件是否存在
    // 如果文件存在，重写 URL 并调用 next() 继续处理
    else {
      if (checkFileExists(pathname + '.html')) {
        const newUrl = url + '.html'
        debug?.(`Rewriting ${req.method} ${req.url} to ${newUrl}`)
        req.url = newUrl
        return next()
      }
    }

    // 如果启用了 spaFallback，重写到 /index.html
    if (spaFallback) {
      debug?.(`Rewriting ${req.method} ${req.url} to /index.html`)
      req.url = '/index.html'
    }

    next()
  }
}
