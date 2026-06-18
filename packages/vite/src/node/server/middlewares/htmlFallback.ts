import path from 'node:path'
import fs from 'node:fs'
import type { Connect } from '#dep-types/connect'
import { createDebugger, joinUrlSegments } from '../../utils'
import { cleanUrl } from '../../../shared/utils'
import type { DevEnvironment } from '../environment'
import { FullBundleDevEnvironment } from '../environments/fullBundleEnvironment'

const debug = createDebugger('vite:html-fallback')

/**
 * 将浏览器对页面路径的请求回退(fallback)到对应的 HTML 文件
 * @param root 项目根目录(开发)或 distDir(预览),用于在文件系统查找 HTM
 * @param spaFallback 是否启用 SPA 回退(找不到任何匹配时,最终回退到 /index.html)
 * @param clientEnvironment 客户端环境实例,用于访问内存中的文件
 * @returns
 */
export function htmlFallbackMiddleware(
  root: string,
  spaFallback: boolean,
  clientEnvironment?: DevEnvironment,
): Connect.NextHandleFunction {
  const memoryFiles =
    clientEnvironment instanceof FullBundleDevEnvironment
      ? // 全量打包环境,如预览或 SSR 优化场景),优先从 memoryFiles 这个内存 Map 中查找
        clientEnvironment.memoryFiles
      : undefined

  function checkFileExists(relativePath: string) {
    return (
      memoryFiles?.has(
        relativePath.slice(1), // 去掉前导 /
        // fs.existsSync 在磁盘 root 下查找
      ) ?? fs.existsSync(path.join(root, relativePath))
    )
  }

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteHtmlFallbackMiddleware(req, _res, next) {
    if (
      // Only accept GET or HEAD， 方法必须是 GET 或 HEAD(POST/PUT 等不处理)
      (req.method !== 'GET' && req.method !== 'HEAD') ||
      // Exclude default favicon requests
      // 排除 /favicon.ico(浏览器自动请求的图标,不需要 HTML 回退)
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

    // cleanUrl 去掉 ?query 与 #hash
    const url = cleanUrl(req.url!)
    let pathname
    try {
      // 解码 URL 编码
      pathname = decodeURIComponent(url)
    } catch {
      // ignore malformed URI
      return next()
    }

    // .html files are not handled by serveStaticMiddleware
    // so we need to check if the file exists
    // .html 结尾 —— 直接验证存在性
    if (pathname.endsWith('.html')) {
      if (checkFileExists(pathname)) {
        debug?.(`Rewriting ${req.method} ${req.url} to ${url}`)
        req.url = url
        return next()
      }
    }
    // trailing slash should check for fallback index.html
    // 以 / 结尾 —— 查找目录下的 index.html
    else if (pathname.endsWith('/')) {
      if (checkFileExists(joinUrlSegments(pathname, 'index.html'))) {
        const newUrl = url + 'index.html'
        debug?.(`Rewriting ${req.method} ${req.url} to ${newUrl}`)
        req.url = newUrl
        return next()
      }
    }
    // non-trailing slash should check for fallback .html
    // 无尾斜杠 —— 查找同名 .html 文件
    else {
      if (checkFileExists(pathname + '.html')) {
        const newUrl = url + '.html'
        debug?.(`Rewriting ${req.method} ${req.url} to ${newUrl}`)
        req.url = newUrl
        return next()
      }
    }

    // SPA 终极回退 —— 找不到任何匹配时,最终回退到 /index.html
    if (spaFallback) {
      debug?.(`Rewriting ${req.method} ${req.url} to /index.html`)
      req.url = '/index.html'
    }

    next()
  }
}
