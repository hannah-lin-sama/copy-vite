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
 * 构建了一个包含多个转换钩子的管道，用于处理开发环境中的 HTML 文件
 * @param config
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
  // 从配置的插件中解析出 HTML 转换钩子
  const [preHooks, normalHooks, postHooks] = resolveHtmlTransforms(
    config.plugins,
  )

  // 构建转换钩子管道
  const transformHooks = [
    preImportMapHook(config), // 处理导入映射的前置钩子
    injectCspNonceMetaTagHook(config), // 注入 CSP nonce 元标签
    ...preHooks,
    htmlEnvHook(config), // 注入环境变量到 HTML 中
    devHtmlHook, // 开发环境特定的 HTML 转换
    ...normalHooks,
    ...postHooks,
    injectNonceAttributeTagHook(config), // 注入 nonce 属性到标签中
    postImportMapHook(), // 处理导入映射的后置钩子
  ]

  // 创建插件上下文
  const pluginContext = new BasicMinimalPluginContext(
    { ...basePluginContextMeta, watchMode: true },
    config.logger,
  )
  return (
    server: ViteDevServer,
    url: string,
    html: string,
    originalUrl?: string,
  ): Promise<string> => {
    // 将所有转换钩子应用到 HTML 内容上
    return applyHtmlTransforms(html, transformHooks, pluginContext, {
      path: url,
      filename: getHtmlFilename(url, server),
      server,
      originalUrl,
    })
  }
}

function getHtmlFilename(url: string, server: ViteDevServer) {
  if (url.startsWith(FS_PREFIX)) {
    return decodeURIComponent(fsPathFromId(url))
  } else {
    return decodeURIComponent(
      normalizePath(path.join(server.config.root, url.slice(1))),
    )
  }
}

function shouldPreTransform(url: string, config: ResolvedConfig) {
  return (
    !checkPublicFile(url, config) && (isJSRequest(url) || isCSSRequest(url))
  )
}

const wordCharRE = /\w/

function isBareRelative(url: string) {
  return wordCharRE.test(url[0]) && !url.includes(':')
}

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

/**
 * 在 HTML 响应被发送给浏览器之前，对其进行动态转换和资源处理
 * @param html
 * @param param1 htmlPath：请求的路径（如 /index.html）
 * @param param1 filename：磁盘上的实际文件路径
 * @returns
 */
const devHtmlHook: IndexHtmlTransformHook = async (
  html, // 原始 HTML 字符串
  { path: htmlPath, filename, server, originalUrl },
) => {
  const { config, watcher } = server!
  const base = config.base || '/'
  const decodedBase = config.decodedBase || '/'

  // 生成代理模块路径
  let proxyModulePath: string
  let proxyModuleUrl: string

  const trailingSlash = htmlPath.endsWith('/')
  if (!trailingSlash && fs.existsSync(filename)) {
    proxyModulePath = htmlPath
    proxyModuleUrl = proxyModulePath
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

  // 初始化 MagicString 与数据结构
  const s = new MagicString(html)
  let inlineModuleIndex = -1
  // The key to the proxyHtml cache is decoded, as it will be compared
  // against decoded URLs by the HTML plugins.
  const proxyCacheUrl = decodeURI(
    cleanUrl(proxyModulePath).replace(normalizePath(config.root), ''),
  )
  const styleUrl: AssetNode[] = []
  const inlineStyles: InlineStyleAttribute[] = []
  const inlineModulePaths: string[] = []

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

  // 使用 traverseHtml 函数（基于 parse5）遍历 HTML 的 AST
  await traverseHtml(html, filename, config.logger.warn, (node) => {
    // 只处理元素节点
    // 跳过文本节点、注释节点等
    if (!nodeIsElement(node)) {
      return
    }

    // script tags
    // 处理 <script> 节点，根据 src 属性值进行处理
    if (node.nodeName === 'script') {
      // 获取脚本信息
      const { src, srcSourceCodeLocation, isModule, isIgnored } =
        getScriptInfo(node)

      // 忽略脚本：如果脚本带有 vite-ignore 属性，移除该属性（但不处理其内容）
      if (isIgnored) {
        removeViteIgnoreAttr(s, node.sourceCodeLocation!)

        // 外部脚本：通过 processNodeUrl 重写 src 属性（例如添加 ?import 或处理绝对路径）
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

        // 内联模块脚本：调用 addInlineModule 转换为虚拟模块
      } else if (isModule && node.childNodes.length) {
        addInlineModule(node, 'js')

        // 传统脚本：提取其中的动态 import() 表达式，并重写内部的 URL
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
    // 处理资源属性（href / src / srcset）
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
  // 处理收集的内联模块路径（使缓存失效）
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
    // 处理 <style> 标签内容
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

    // 处理内联 style 属性
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

  // 返回一个对象，包含 html 和 tags 数组
  // tags 中指定了需要额外注入的 <script> 标签，
  // 即 Vite 的 client 脚本（/@vite/client），
  // 注入位置为 head-prepend（<head> 的最前面）
  return {
    html,
    tags: [
      {
        tag: 'script',
        attrs: {
          type: 'module',
          src: path.posix.join(base, CLIENT_PUBLIC_PATH),
        },
        injectTo: 'head-prepend',
      },
    ],
  }
}

/**
 * 用于处理 HTML 请求。
 * 它支持两种模式的 HTML 处理：Full Bundle 模式和普通模式，确保 HTML 文件能够正确加载和转换
 * @param root
 * @param server
 * @returns
 */
export function indexHtmlMiddleware(
  root: string,
  server: ViteDevServer | PreviewServer,
): Connect.NextHandleFunction {
  const isDev = isDevServer(server)
  const fullBundleEnv =
    isDev && server.environments.client instanceof FullBundleDevEnvironment
      ? server.environments.client
      : undefined

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return async function viteIndexHtmlMiddleware(req, res, next) {
    // 当响应已经结束（即所有数据已发送完毕）时，该属性值为 true
    if (res.writableEnded) {
      // 调用 next() 直接传递给下一个中间件
      // 这样可以避免在已经结束的响应上尝试再次写入数据，从而防止产生错误
      return next()
    }

    const url = req.url && cleanUrl(req.url)
    // htmlFallbackMiddleware appends '.html' to URLs
    if (url?.endsWith('.html') && req.headers['sec-fetch-dest'] !== 'script') {
      if (fullBundleEnv) {
        const pathname = decodeURIComponent(url)
        // 打包根目录的文件路径 index.html
        const filePath = pathname.slice(1) // remove first /

        let file = fullBundleEnv.memoryFiles.get(filePath)
        if (!file && fullBundleEnv.memoryFiles.size !== 0) {
          return next()
        }
        const secFetchDest = req.headers['sec-fetch-dest']
        // 处理文档类请求（SPA 回退）
        if (
          [
            'document',
            'iframe',
            'frame',
            'fencedframe',
            '',
            undefined,
          ].includes(secFetchDest) &&
          // 检查当前 bundle 是否过期
          ((await fullBundleEnv.triggerBundleRegenerationIfStale()) ||
            file === undefined)
        ) {
          // 生成一个 fallback HTML 作为文件内容
          // 生成一个默认的 HTML 入口
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
        return send(req, res, html, 'html', { headers, etag: file.etag })
      }

      // 根据请求 URL 确定 HTML 文件的实际文件系统路径
      let filePath: string

      // 如果是开发服务器且 URL 以 FS_PREFIX 开头（表示直接访问文件系统路径）
      if (isDev && url.startsWith(FS_PREFIX)) {
        filePath = decodeURIComponent(fsPathFromId(url))
      } else {
        // 将 URL 与服务器根目录连接，解析为绝对路径
        filePath = normalizePath(
          path.resolve(path.join(root, decodeURIComponent(url))),
        )
      }

      if (isDev) {
        const servingAccessResult = checkLoadingAccess(server.config, filePath)
        // 如果路径被拒绝访问，返回 403 错误
        if (servingAccessResult === 'denied') {
          return respondWithAccessDenied(filePath, server, res)
        }
        //
        if (servingAccessResult === 'fallback') {
          return next()
        }
        // 确保路径被允许访问
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
          // 读取 HTML 文件内容
          let html = await fsp.readFile(filePath, 'utf-8')
          if (isDev) {
            // 开发环境下，对 HTML 进行转换
            html = await server.transformIndexHtml(url, html, req.originalUrl)
          }
          // 发送 HTML 内容
          // 这里使用 send() 方法，而不是 res.end()，因为它会自动处理响应头和编码
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
