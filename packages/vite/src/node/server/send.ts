import type {
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from 'node:http'
import path from 'node:path'
import convertSourceMap from 'convert-source-map'
import getEtag from 'etag'
import type { SourceMap } from 'rolldown'
import MagicString from 'magic-string'
import { createDebugger, removeTimestampQuery } from '../utils'
import { getCodeWithSourcemap } from './sourcemap'

const debug = createDebugger('vite:send', {
  onlyWhenFocused: true,
})

const alias: Record<string, string | undefined> = {
  js: 'text/javascript',
  css: 'text/css',
  html: 'text/html',
  json: 'application/json',
}

export interface SendOptions {
  etag?: string
  cacheControl?: string
  headers?: OutgoingHttpHeaders
  map?: SourceMap | { mappings: '' } | null
}

/**
 * 发送响应
 * @param req 请求对象
 * @param res 响应对象
 * @param content 响应内容
 * @param type 响应类型
 * @param options 响应选项
 * @returns
 */
export function send(
  req: IncomingMessage,
  res: ServerResponse,
  content: string | Buffer,
  type: string,
  options: SendOptions,
): void {
  const {
    etag = getEtag(content, { weak: true }),
    cacheControl = 'no-cache',
    headers,
    map,
  } = options

  // 响应已结束，直接返回
  if (res.writableEnded) {
    return
  }

  // 缓存验证，响应未过期，直接返回
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304
    res.end()
    return
  }

  res.setHeader('Content-Type', alias[type] || type)
  res.setHeader('Cache-Control', cacheControl)
  res.setHeader('Etag', etag)

  // 自定义响应头
  if (headers) {
    for (const name in headers) {
      res.setHeader(name, headers[name]!)
    }
  }

  // inject source map reference
  // 源文件映射
  if (map && 'version' in map && map.mappings) {
    if (type === 'js' || type === 'css') {
      content = getCodeWithSourcemap(type, content.toString(), map)
    }
  }
  // inject fallback sourcemap for js for improved debugging
  // https://github.com/vitejs/vite/pull/13514#issuecomment-1592431496
  else if (type === 'js' && (!map || map.mappings !== '')) {
    const code = content.toString()
    // if the code has existing inline sourcemap, assume it's correct and skip
    if (convertSourceMap.mapFileCommentRegex.test(code)) {
      debug?.(`Skipped injecting fallback sourcemap for ${req.url}`)
    } else {
      const urlWithoutTimestamp = removeTimestampQuery(req.url!)
      const ms = new MagicString(code)
      content = getCodeWithSourcemap(
        type,
        code,
        ms.generateMap({
          source: path.basename(urlWithoutTimestamp),
          hires: 'boundary',
          includeContent: true,
        }) as SourceMap,
      )
    }
  }

  res.statusCode = 200
  // 处理 HEAD 请求，只发送响应头，不发送响应体
  if (req.method === 'HEAD') {
    res.end()
  } else {
    res.end(content)
  }
  return
}
