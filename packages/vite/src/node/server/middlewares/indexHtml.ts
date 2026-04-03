import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import MagicString from 'magic-string'
import type { SourceMapInput } from 'rolldown'
import type { DefaultTreeAdapterMap, Token } from 'parse5'
import type { Connect } from '#dep-types/connect'
import type { IndexHtmlTransformHook } from '../../plugins/html'
import {
  addToHTMLProxyCache,
  applyHtmlTransforms,
  extractImportExpressionFromClassicScript,
  findNeedTransformStyleAttribute,
  getScriptInfo,
  htmlEnvHook,
  htmlProxyResult,
  injectCspNonceMetaTagHook,
  injectNonceAttributeTagHook,
  nodeIsElement,
  overwriteAttrValue,
  postImportMapHook,
  preImportMapHook,
  removeViteIgnoreAttr,
  resolveHtmlTransforms,
  traverseHtml,
} from '../../plugins/html'
import type { PreviewServer, ResolvedConfig, ViteDevServer } from '../..'
import { send } from '../send'
import { CLIENT_PUBLIC_PATH, FS_PREFIX } from '../../constants'
import {
  ensureWatchedFile,
  fsPathFromId,
  getHash,
  injectQuery,
  isCSSRequest,
  isDevServer,
  isJSRequest,
  isParentDirectory,
  joinUrlSegments,
  normalizePath,
  processSrcSetSync,
  stripBase,
} from '../../utils'
import { checkPublicFile } from '../../publicDir'
import { getCodeWithSourcemap, injectSourcesContent } from '../sourcemap'
import { cleanUrl, unwrapId, wrapId } from '../../../shared/utils'
import { getNodeAssetAttributes } from '../../assetSource'
import {
  BasicMinimalPluginContext,
  basePluginContextMeta,
} from '../pluginContainer'
import { FullBundleDevEnvironment } from '../environments/fullBundleEnvironment'
import { getHmrImplementation } from '../../plugins/clientInjections'
import { checkLoadingAccess, respondWithAccessDenied } from './static'

interface AssetNode {
  start: number
  end: number
  code: string
}

interface InlineStyleAttribute {
  index: number
  location: Token.Location
  code: string
}

/**
 * 创建一个函数，该函数能够对 HTML 内容应用一系列转换钩子，包括 Vite 内置的转换和插件提供的自定义转换。
 * @param config 解析后的配置对象
 * @returns
 */
export function createDevHtmlTransformFn(
  config: ResolvedConfig,
): (
  server: ViteDevServer,
  url: string,
  html: string,
  originalUrl?: string,
) => Promise<string> {
  // 处理插件 plugin.transformIndexHtml
  // 解析 HTML 钩子函数，包括预钩子、普通钩子和后钩子
  const [preHooks, normalHooks, postHooks] = resolveHtmlTransforms(
    config.plugins,
  )
  // 构建转换钩子链
  const transformHooks = [
    preImportMapHook(config), // 处理 import map 相关的预处理
    injectCspNonceMetaTagHook(config), //注入 CSP nonce 元标签
    ...preHooks,
    htmlEnvHook(config), // 注入环境变量（import.meta.env）
    // Vite 内置的关键钩子，负责注入 HMR 客户端脚本（/@vite/client）、处理 base 路径、添加必要的标签等
    devHtmlHook,
    ...normalHooks,
    ...postHooks,
    injectNonceAttributeTagHook(config), // 注入 nonce 属性到脚本标签
    postImportMapHook(), // 处理 import map 相关的后处理
  ]
  // 创建一个插件上下文，用于在 HTML 转换过程中调用插件钩子函数
  const pluginContext = new BasicMinimalPluginContext(
    { ...basePluginContextMeta, watchMode: true },
    config.logger,
  )
  // 返回一个函数，用于处理 HTML 请求
  return (
    server: ViteDevServer, // 服务器实例
    url: string, // 请求 URL
    html: string, // 原始 HTML 内容
    originalUrl?: string, // 原始请求 URL，用于处理重定向等场景
  ): Promise<string> => {
    // 最终返回转换后的 HTML 内容
    return applyHtmlTransforms(html, transformHooks, pluginContext, {
      path: url,
      filename: getHtmlFilename(url, server),
      server,
      originalUrl,
    })
  }
}

/**
 * 获取 HTML 文件的完整路径
 * @param url 请求 URL
 * @param server 服务器实例
 * @returns HTML 文件的完整路径
 */
function getHtmlFilename(url: string, server: ViteDevServer) {
  if (url.startsWith(FS_PREFIX)) {
    return decodeURIComponent(fsPathFromId(url))
  } else {
    return decodeURIComponent(
      normalizePath(path.join(server.config.root, url.slice(1))),
    )
  }
}

/**
 * 判断是否需要预处理 HTML 文件
 * @param url 请求 URL
 * @param config 解析后的配置对象
 * @returns 是否需要预处理 HTML 文件
 */
function shouldPreTransform(url: string, config: ResolvedConfig) {
  return (
    !checkPublicFile(url, config) && (isJSRequest(url) || isCSSRequest(url))
  )
}

const wordCharRE = /\w/

/**
 * 判断是否为裸相对路径
 * @param url 请求 URL
 * @returns 是否为裸相对路径
 */
function isBareRelative(url: string) {
  return wordCharRE.test(url[0]) && !url.includes(':')
}

/**
 * 处理节点 URL，根据配置进行转换
 * @param url 请求 URL
 * @param useSrcSetReplacer
 * @param config 解析后的配置对象
 * @param htmlPath
 * @param originalUrl
 * @param server
 * @param isClassicScriptLink
 * @returns
 */
const processNodeUrl = (
  url: string,
  useSrcSetReplacer: boolean,
  config: ResolvedConfig,
  htmlPath: string,
  originalUrl?: string,
  server?: ViteDevServer,
  isClassicScriptLink?: boolean,
): string => {
  // prefix with base (dev only, base is never relative)
  const replacer = (url: string) => {
    if (
      (url[0] === '/' && url[1] !== '/') ||
      // #3230 if some request url (localhost:3000/a/b) return to fallback html, the relative assets
      // path will add `/a/` prefix, it will caused 404.
      //
      // skip if url contains `:` as it implies a url protocol or Windows path that we don't want to replace.
      //
      // rewrite `./index.js` -> `localhost:5173/a/index.js`.
      // rewrite `../index.js` -> `localhost:5173/index.js`.
      // rewrite `relative/index.js` -> `localhost:5173/a/relative/index.js`.
      ((url[0] === '.' || isBareRelative(url)) &&
        originalUrl &&
        originalUrl !== '/' &&
        htmlPath === '/index.html')
    ) {
      url = path.posix.join(config.base, url)
    }

    let preTransformUrl: string | undefined

    if (!isClassicScriptLink && shouldPreTransform(url, config)) {
      if (url[0] === '/' && url[1] !== '/') {
        preTransformUrl = url
      } else if (url[0] === '.' || isBareRelative(url)) {
        preTransformUrl = path.posix.join(
          config.base,
          path.posix.dirname(htmlPath),
          url,
        )
      }
    }

    if (server) {
      const mod = server.environments.client.moduleGraph.urlToModuleMap.get(
        preTransformUrl || url,
      )
      if (mod && mod.lastHMRTimestamp > 0) {
        url = injectQuery(url, `t=${mod.lastHMRTimestamp}`)
      }
    }

    if (server && preTransformUrl) {
      try {
        preTransformUrl = decodeURI(preTransformUrl)
      } catch {
        // Malformed uri. Skip pre-transform.
        return url
      }
      preTransformRequest(server, preTransformUrl, config.decodedBase)
    }

    return url
  }

  const processedUrl = useSrcSetReplacer
    ? processSrcSetSync(url, ({ url }) => replacer(url))
    : replacer(url)
  return processedUrl
}

const devHtmlHook: IndexHtmlTransformHook = async (
  html,
  { path: htmlPath, filename, server, originalUrl },
) => {
  const { config, watcher } = server!
  const base = config.base || '/'
  const decodedBase = config.decodedBase || '/'

  let proxyModulePath: string // 代理模块路径
  let proxyModuleUrl: string // 代理模块 URL

  const trailingSlash = htmlPath.endsWith('/')
  // 如果文件存在且不是以斜杠结尾
  if (!trailingSlash && fs.existsSync(filename)) {
    proxyModulePath = htmlPath // 直接使用 HTML路径
    proxyModuleUrl = proxyModulePath // 直接使用 HTML路径

    // 虚拟 HTML（不存在的文件 / SSR 传入的 HTML）
    /**
     * 为什么要生成代理路径？
        因为：HTML 里的内联 JS、内联 CSS 不是文件，不能被 Vite 编译、缓存、热更。
        解决方案：把整个 HTML 变成一个 “虚拟模块”，内联代码变成它的子模块
     */
  } else {
    // There are users of vite.transformIndexHtml calling it with url '/'
    // for SSR integrations #7993, filename is root for this case
    // A user may also use a valid name for a virtual html file
    // Mark the path as virtual in both cases so sourcemaps aren't processed
    // and ids are properly handled

    const validPath = `${htmlPath}${trailingSlash ? 'index.html' : ''}`
    proxyModulePath = `\0${validPath}`
    proxyModuleUrl = wrapId(proxyModulePath)
  }
  proxyModuleUrl = joinUrlSegments(decodedBase, proxyModuleUrl)

  const s = new MagicString(html) // 可生成 sourcemap 的字符串操作库
  let inlineModuleIndex = -1
  // The key to the proxyHtml cache is decoded, as it will be compared
  // against decoded URLs by the HTML plugins.
  const proxyCacheUrl = decodeURI(
    cleanUrl(proxyModulePath).replace(normalizePath(config.root), ''),
  )
  const styleUrl: AssetNode[] = [] // style标签
  const inlineStyles: InlineStyleAttribute[] = [] // 行内style
  const inlineModulePaths: string[] = [] // 内联 script 转成的外部路径

  /**
   * 把内联 <script type="module"> 变成外部脚本
   * @param node
   * @param ext
   */
  const addInlineModule = (
    node: DefaultTreeAdapterMap['element'],
    ext: 'js',
  ) => {
    inlineModuleIndex++

    const contentNode = node.childNodes[0] as DefaultTreeAdapterMap['textNode']

    const code = contentNode.value

    let map: SourceMapInput | undefined
    if (proxyModulePath[0] !== '\0') {
      map = new MagicString(html)
        .snip(
          contentNode.sourceCodeLocation!.startOffset,
          contentNode.sourceCodeLocation!.endOffset,
        )
        .generateMap({ hires: 'boundary' })
      map.sources = [filename]
      map.file = filename
    }

    // add HTML Proxy to Map
    addToHTMLProxyCache(config, proxyCacheUrl, inlineModuleIndex, { code, map })

    // inline js module. convert to src="proxy" (dev only, base is never relative)
    const modulePath = `${proxyModuleUrl}?html-proxy&index=${inlineModuleIndex}.${ext}`
    inlineModulePaths.push(modulePath)

    s.update(
      node.sourceCodeLocation!.startOffset,
      node.sourceCodeLocation!.endOffset,
      `<script type="module" src="${modulePath}"></script>`,
    )
    preTransformRequest(server!, modulePath, decodedBase)
  }

  await traverseHtml(html, filename, config.logger.warn, (node) => {
    if (!nodeIsElement(node)) {
      return
    }

    // script tags
    if (node.nodeName === 'script') {
      const { src, srcSourceCodeLocation, isModule, isIgnored } =
        getScriptInfo(node)

      if (isIgnored) {
        removeViteIgnoreAttr(s, node.sourceCodeLocation!)
      } else if (src) {
        const processedUrl = processNodeUrl(
          src.value,
          /* useSrcSetReplacer */ false,
          config,
          htmlPath,
          originalUrl,
          server,
          !isModule,
        )
        if (processedUrl !== src.value) {
          overwriteAttrValue(s, srcSourceCodeLocation!, processedUrl)
        }
      } else if (isModule && node.childNodes.length) {
        addInlineModule(node, 'js')
      } else if (node.childNodes.length) {
        const scriptNode = node.childNodes[
          node.childNodes.length - 1
        ] as DefaultTreeAdapterMap['textNode']
        for (const {
          url,
          start,
          end,
        } of extractImportExpressionFromClassicScript(scriptNode)) {
          const processedUrl = processNodeUrl(
            url,
            false,
            config,
            htmlPath,
            originalUrl,
          )
          if (processedUrl !== url) {
            s.update(start, end, processedUrl)
          }
        }
      }
    }

    const inlineStyle = findNeedTransformStyleAttribute(node)
    if (inlineStyle) {
      inlineModuleIndex++
      inlineStyles.push({
        index: inlineModuleIndex,
        location: inlineStyle.location!,
        code: inlineStyle.attr.value,
      })
    }

    if (node.nodeName === 'style' && node.childNodes.length) {
      const children = node.childNodes[0] as DefaultTreeAdapterMap['textNode']
      styleUrl.push({
        start: children.sourceCodeLocation!.startOffset,
        end: children.sourceCodeLocation!.endOffset,
        code: children.value,
      })
    }

    // elements with [href/src] attrs
    const assetAttributes = getNodeAssetAttributes(node)
    for (const attr of assetAttributes) {
      if (attr.type === 'remove') {
        s.remove(attr.location.startOffset, attr.location.endOffset)
      } else {
        const processedUrl = processNodeUrl(
          attr.value,
          attr.type === 'srcset',
          config,
          htmlPath,
          originalUrl,
        )
        if (processedUrl !== attr.value) {
          overwriteAttrValue(s, attr.location, processedUrl)
        }
      }
    }
  })

  // invalidate the module so the newly cached contents will be served
  const clientModuleGraph = server?.environments.client.moduleGraph
  if (clientModuleGraph) {
    await Promise.all(
      inlineModulePaths.map(async (url) => {
        const module = await clientModuleGraph.getModuleByUrl(url)
        if (module) {
          clientModuleGraph.invalidateModule(module)
        }
      }),
    )
  }

  await Promise.all([
    ...styleUrl.map(async ({ start, end, code }, index) => {
      const url = `${proxyModulePath}?html-proxy&direct&index=${index}.css`

      // ensure module in graph after successful load
      const mod =
        await server!.environments.client.moduleGraph.ensureEntryFromUrl(
          url,
          false,
        )
      ensureWatchedFile(watcher, mod.file, config.root)

      const result =
        await server!.environments.client.pluginContainer.transform(
          code,
          mod.id!,
        )
      let content = ''
      if (result.map && 'version' in result.map) {
        if (result.map.mappings) {
          await injectSourcesContent(result.map, proxyModulePath, config.logger)
        }
        content = getCodeWithSourcemap('css', result.code, result.map)
      } else {
        content = result.code
      }
      s.overwrite(start, end, content)
    }),
    ...inlineStyles.map(async ({ index, location, code }) => {
      // will transform with css plugin and cache result with css-post plugin
      const url = `${proxyModulePath}?html-proxy&inline-css&style-attr&index=${index}.css`

      const mod =
        await server!.environments.client.moduleGraph.ensureEntryFromUrl(
          url,
          false,
        )
      ensureWatchedFile(watcher, mod.file, config.root)

      await server?.environments.client.pluginContainer.transform(code, mod.id!)

      const hash = getHash(cleanUrl(mod.id!))
      const result = htmlProxyResult.get(`${hash}_${index}`)
      overwriteAttrValue(s, location, result ?? '')
    }),
  ])

  html = s.toString()

  return {
    html,
    tags: [
      {
        tag: 'script',
        attrs: {
          type: 'module',
          // CLIENT_PUBLIC_PATH = `/@vite/client`
          src: path.posix.join(base, CLIENT_PUBLIC_PATH),
        },
        injectTo: 'head-prepend',
      },
    ],
  }
}

/**
 * 一个中间件函数生成器，用于处理 Vite 开发服务器和预览服务器中的 HTML 请求
 * @param root 根目录路径
 * @param server Vite 服务器实例
 * @returns Connect 中间件函数
 */
export function indexHtmlMiddleware(
  root: string,
  server: ViteDevServer | PreviewServer,
): Connect.NextHandleFunction {
  const isDev = isDevServer(server) // 检查是否为开发环境

  // 检查是否为开发环境且环境为 FullBundleDevEnvironment
  const fullBundleEnv =
    isDev && server.environments.client instanceof FullBundleDevEnvironment
      ? server.environments.client
      : undefined

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return async function viteIndexHtmlMiddleware(req, res, next) {
    if (res.writableEnded) {
      return next()
    }

    const url = req.url && cleanUrl(req.url)
    // htmlFallbackMiddleware appends '.html' to URLs
    if (url?.endsWith('.html') && req.headers['sec-fetch-dest'] !== 'script') {
      // 1、Full Bundle 模式处理
      if (fullBundleEnv) {
        const pathname = decodeURIComponent(url)
        const filePath = pathname.slice(1) // remove first /

        // 从内存文件中获取文件
        let file = fullBundleEnv.memoryFiles.get(filePath)
        if (!file && fullBundleEnv.memoryFiles.size !== 0) {
          return next()
        }
        const secFetchDest = req.headers['sec-fetch-dest']

        if (
          // 只有在请求的资源类型为文档、IFrame、Frame、FencedFrame、空字符串或 undefined 时才触发重新生成
          [
            'document',
            'iframe',
            'frame',
            'fencedframe',
            '',
            undefined,
          ].includes(secFetchDest) &&
          // 只有在文件不存在或文件过期时才触发重新生成
          ((await fullBundleEnv.triggerBundleRegenerationIfStale()) ||
            file === undefined)
        ) {
          // 重新生成文件
          file = { source: await generateFallbackHtml(server as ViteDevServer) }
        }
        if (!file) {
          return next()
        }

        const html =
          typeof file.source === 'string'
            ? file.source
            : Buffer.from(file.source)
        const headers = isDev
          ? server.config.server.headers
          : server.config.preview.headers

        // 发送响应
        return send(req, res, html, 'html', { headers, etag: file.etag })
      }

      // 2、常规模式处理
      let filePath: string
      if (isDev && url.startsWith(FS_PREFIX)) {
        filePath = decodeURIComponent(fsPathFromId(url))
      } else {
        filePath = normalizePath(
          path.resolve(path.join(root, decodeURIComponent(url))),
        )
      }

      if (isDev) {
        const servingAccessResult = checkLoadingAccess(server.config, filePath)
        if (servingAccessResult === 'denied') {
          return respondWithAccessDenied(filePath, server, res)
        }
        if (servingAccessResult === 'fallback') {
          return next()
        }
        servingAccessResult satisfies 'allowed'
      } else {
        // `server.fs` options does not apply to the preview server.
        // But we should disallow serving files outside the output directory.
        if (!isParentDirectory(root, filePath)) {
          return next()
        }
      }

      if (fs.existsSync(filePath)) {
        const headers = isDev
          ? server.config.server.headers
          : server.config.preview.headers

        try {
          let html = await fsp.readFile(filePath, 'utf-8')
          if (isDev) {
            html = await server.transformIndexHtml(url, html, req.originalUrl)
          }
          return send(req, res, html, 'html', { headers })
        } catch (e) {
          return next(e)
        }
      }
    }
    next()
  }
}

// NOTE: We usually don't prefix `url` and `base` with `decoded`, but in this file particularly
// we're dealing with mixed encoded/decoded paths often, so we make this explicit for now.
function preTransformRequest(
  server: ViteDevServer,
  decodedUrl: string,
  decodedBase: string,
) {
  if (!server.config.server.preTransformRequests) return

  // transform all url as non-ssr as html includes client-side assets only
  decodedUrl = unwrapId(stripBase(decodedUrl, decodedBase))
  server.warmupRequest(decodedUrl)
}

/**
 * 生成回退 HTML 页面
 * @param server ViteDevServer 实例
 * @returns 回退 HTML 页面内容
 */
async function generateFallbackHtml(server: ViteDevServer) {
  const hmrRuntime = await getHmrImplementation(server.config)
  return /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
  <script type="module">
    ${hmrRuntime.replaceAll('</script>', '<\\/script>')}
  </script>
  <style>
    :root {
      --page-bg: #ffffff;
      --text-color: #1d1d1f;
      --spinner-track: #f5f5f7;
      --spinner-accent: #0071e3;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --page-bg: #1e1e1e;
        --text-color: #f5f5f5;
        --spinner-track: #424242;
      }
    }

    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      background-color: var(--page-bg);
      color: var(--text-color);
    }

    .container {
      margin: auto;
      padding: 2rem;
      text-align: center;
      border-radius: 1rem;
    }

    .spinner {
      width: 3rem;
      height: 3rem;
      margin: 2rem auto;
      border: 3px solid var(--spinner-track);
      border-top-color: var(--spinner-accent);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg) } }
  </style>
</head>
<body>
  <div class="container">
    <h1>Bundling in progress</h1>
    <p>The page will automatically reload when ready.</p>
    <div class="spinner"></div>
  </div>
</body>
</html>
`
}
