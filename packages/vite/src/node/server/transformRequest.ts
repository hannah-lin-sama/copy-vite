import fsp from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import getEtag from 'etag'
import MagicString from 'magic-string'
import { init, parse as parseImports } from 'es-module-lexer'
import type {
  ModuleType,
  PartialResolvedId,
  SourceDescription,
  SourceMap,
} from 'rolldown'
import colors from 'picocolors'
import type { EnvironmentModuleNode } from '../server/moduleGraph'
import {
  createDebugger,
  ensureWatchedFile,
  injectQuery,
  isObject,
  monotonicDateNow,
  prettifyUrl,
  removeImportQuery,
  removeTimestampQuery,
  stripBase,
  timeFrom,
} from '../utils'
import { ssrTransform } from '../ssr/ssrTransform'
import { checkPublicFile } from '../publicDir'
import { cleanUrl, slash, unwrapId } from '../../shared/utils'
import {
  applySourcemapIgnoreList,
  extractSourcemapFromFile,
  injectSourcesContent,
} from './sourcemap'
import { isFileLoadingAllowed } from './middlewares/static'
import { throwClosedServerError } from './pluginContainer'
import type { DevEnvironment } from './environment'

export const ERR_LOAD_URL = 'ERR_LOAD_URL'
export const ERR_LOAD_PUBLIC_URL = 'ERR_LOAD_PUBLIC_URL'
export const ERR_DENIED_ID = 'ERR_DENIED_ID'

const debugLoad = createDebugger('vite:load')
const debugTransform = createDebugger('vite:transform')
const debugCache = createDebugger('vite:cache')

export interface TransformResult {
  code: string
  map: SourceMap | { mappings: '' } | null
  ssr?: boolean
  etag?: string
  deps?: string[]
  dynamicDeps?: string[]
}

export interface TransformOptions {
  /**
   * @deprecated inferred from environment
   */
  ssr?: boolean
}

export interface TransformOptionsInternal {
  /**
   * @internal
   */
  allowId?: (id: string) => boolean
}

// TODO: This function could be moved to the DevEnvironment class.
// It was already using private fields from the server before, and it now does
// the same with environment._closing, environment._pendingRequests and
// environment._registerRequestProcessing. Maybe it makes sense to keep it in
// separate file to preserve the history or keep the DevEnvironment class cleaner,
// but conceptually this is: `environment.transformRequest(url, options)`

/**
 * 转换指定 URL 的请求
 * @param environment
 * @param url
 * @param options
 * @returns
 */
export function transformRequest(
  environment: DevEnvironment,
  url: string,
  options: TransformOptionsInternal = {},
): Promise<TransformResult | null> {
  // 检查环境是否已关闭且可恢复
  if (environment._closing && environment.config.dev.recoverable)
    throwClosedServerError()

  // This module may get invalidated while we are processing it. For example
  // when a full page reload is needed after the re-processing of pre-bundled
  // dependencies when a missing dep is discovered. We save the current time
  // to compare it to the last invalidation performed to know if we should
  // cache the result of the transformation or we should discard it as stale.
  //
  // A module can be invalidated due to:
  // 1. A full reload because of pre-bundling newly discovered deps
  // 2. A full reload after a config change
  // 3. The file that generated the module changed
  // 4. Invalidation for a virtual module
  //
  // For 1 and 2, a new request for this module will be issued after
  // the invalidation as part of the browser reloading the page. For 3 and 4
  // there may not be a new request right away because of HMR handling.
  // In all cases, the next time this module is requested, it should be
  // re-processed.
  //
  // We save the timestamp when we start processing and compare it with the
  // last time this module is invalidated
  const timestamp = monotonicDateNow()

  url = removeTimestampQuery(url)

  const pending = environment._pendingRequests.get(url)

  if (pending) {
    // 获取模块
    return environment.moduleGraph.getModuleByUrl(url).then((module) => {
      if (!module || pending.timestamp > module.lastInvalidationTimestamp) {
        // The pending request is still valid, we can safely reuse its result
        return pending.request
      } else {
        // Request 1 for module A     (pending.timestamp)
        // Invalidate module A        (module.lastInvalidationTimestamp)
        // Request 2 for module A     (timestamp)

        // First request has been invalidated, abort it to clear the cache,
        // then perform a new doTransform.
        // 终止
        pending.abort()
        return transformRequest(environment, url, options)
      }
    })
  }

  // 执行转换
  const request = doTransform(environment, url, options, timestamp)

  // Avoid clearing the cache of future requests if aborted
  let cleared = false
  const clearCache = () => {
    if (!cleared) {
      environment._pendingRequests.delete(url)
      cleared = true
    }
  }

  // Cache the request and clear it once processing is done
  environment._pendingRequests.set(url, {
    request,
    timestamp,
    abort: clearCache,
  })

  return request.finally(clearCache)
}

/**
 * 执行模块的转换处理，包括缓存检查、模块解析、转换执行和请求注册，确保模块能够被正确转换并缓存结果以提高性能
 * @param environment
 * @param url
 * @param options
 * @param timestamp
 * @returns
 */
async function doTransform(
  environment: DevEnvironment,
  url: string,
  options: TransformOptionsInternal,
  timestamp: number,
) {
  // 获取插件容器
  const { pluginContainer } = environment

  // 通过 URL 从模块图中获取模块
  let module = await environment.moduleGraph.getModuleByUrl(url)
  if (module) {
    // try use cache from url
    // 尝试从缓存获取转换结果
    const cached = await getCachedTransformResult(
      environment,
      url,
      module,
      timestamp,
    )
    if (cached) return cached
  }

  const resolved = module
    ? undefined
    : // 解析 url
      ((await pluginContainer.resolveId(url, undefined)) ?? undefined)

  // resolve
  // 确定模块 ID
  // 模块ID > 解析ID > URL
  const id = module?.id ?? resolved?.id ?? url

  // 尝试通过 ID 从模块图中获取模块
  module ??= environment.moduleGraph.getModuleById(id)
  if (module) {
    // if a different url maps to an existing loaded id,  make sure we relate this url to the id
    // 确保 URL 与模块 ID 相关联
    await environment.moduleGraph._ensureEntryFromUrl(url, undefined, resolved)
    // try use cache from id
    // 尝试从缓存获取转换结果
    const cached = await getCachedTransformResult(
      environment,
      url,
      module,
      timestamp,
    )
    if (cached) return cached
  }

  // 加载并转换模块
  const result = loadAndTransform(
    environment,
    id,
    url,
    options,
    timestamp,
    module,
    resolved,
  )

  const { depsOptimizer } = environment

  // 检查模块是否为优化依赖文件
  // 如果不是优化依赖文件，注册请求处理函数
  if (!depsOptimizer?.isOptimizedDepFile(id)) {
    environment._registerRequestProcessing(id, () => result)
  }

  return result
}

/**
 *
 * @param environment
 * @param url
 * @param module
 * @param timestamp
 * @returns
 */
async function getCachedTransformResult(
  environment: DevEnvironment,
  url: string,
  module: EnvironmentModuleNode,
  timestamp: number,
) {
  const prettyUrl = debugCache ? prettifyUrl(url, environment.config.root) : ''

  // tries to handle soft invalidation of the module if available,
  // returns a boolean true is successful, or false if no handling is needed
  const softInvalidatedTransformResult = await handleModuleSoftInvalidation(
    environment,
    module,
    timestamp,
  )
  if (softInvalidatedTransformResult) {
    debugCache?.(`[memory-hmr] ${prettyUrl}`)
    return softInvalidatedTransformResult
  }

  // check if we have a fresh cache
  const cached = module.transformResult
  if (cached) {
    debugCache?.(`[memory] ${prettyUrl}`)
    return cached
  }
}

/**
 * 加载模块内容并通过插件系统对其进行转换，生成浏览器可执行的代码和相应的源码映射
 * @param environment
 * @param id
 * @param url
 * @param options
 * @param timestamp
 * @param mod
 * @param resolved
 * @returns
 */
async function loadAndTransform(
  environment: DevEnvironment,
  id: string,
  url: string,
  options: TransformOptionsInternal,
  timestamp: number,
  mod?: EnvironmentModuleNode,
  resolved?: PartialResolvedId,
) {
  const { config, pluginContainer, logger } = environment
  const prettyUrl =
    debugLoad || debugTransform ? prettifyUrl(url, config.root) : ''

  // 获取模块图
  const moduleGraph = environment.moduleGraph

  // 检查 ID 是否被允许转换，不允许则抛出错误
  if (options.allowId && !options.allowId(id)) {
    const err: any = new Error(`Denied ID ${id}`)
    err.code = ERR_DENIED_ID
    err.id = id
    throw err
  }

  let code: string | null = null
  let map: SourceDescription['map'] = null
  let moduleType: ModuleType | undefined

  // load
  const loadStart = debugLoad ? performance.now() : 0
  // 尝试加载模块
  const loadResult = await pluginContainer.load(id)

  // 如果插件没有加载结果
  if (loadResult == null) {
    const file = cleanUrl(id)

    // try fallback loading it from fs as string
    // if the file is a binary, there should be a plugin that already loaded it
    // as string
    // only try the fallback if access is allowed, skip for out of root url
    // like /service-worker.js or /api/users
    if (
      environment.config.consumer === 'server' ||
      isFileLoadingAllowed(environment.getTopLevelConfig(), slash(file))
    ) {
      try {
        // 尝试从文件系统加载
        code = await fsp.readFile(file, 'utf-8')
        debugLoad?.(`${timeFrom(loadStart)} [fs] ${prettyUrl}`)
      } catch (e) {
        if (e.code !== 'ENOENT' && e.code !== 'EISDIR') {
          throw e
        }
      }
      // 确保加载的文件被监视（如果有文件监视器）
      if (code != null && environment.pluginContainer.watcher) {
        ensureWatchedFile(
          environment.pluginContainer.watcher,
          file,
          config.root,
        )
      }
    }
    if (code) {
      try {
        // 尝试从文件中提取源码映射
        const extracted = extractSourcemapFromFile(code, file)
        if (extracted) {
          code = extracted.code
          map = extracted.map
        }
      } catch (e) {
        logger.warn(`Failed to load source map for ${file}.\n${e}`, {
          timestamp: true,
        })
      }
    }
  } else {
    // 如果插件加载了模块
    debugLoad?.(`${timeFrom(loadStart)} [plugin] ${prettyUrl}`)
    if (isObject(loadResult)) {
      code = loadResult.code
      map = loadResult.map
      moduleType = loadResult.moduleType
    } else {
      code = loadResult
    }
  }

  // 抛出错误，区分公共文件和普通文件的错误信息
  if (code == null) {
    const isPublicFile = checkPublicFile(url, environment.getTopLevelConfig())
    let publicDirName = path.relative(config.root, config.publicDir)
    if (publicDirName[0] !== '.') publicDirName = '/' + publicDirName
    const msg = isPublicFile
      ? `This file is in ${publicDirName} and will be copied as-is during ` +
        `build without going through the plugin transforms, and therefore ` +
        `should not be imported from source code. It can only be referenced ` +
        `via HTML tags.`
      : `Does the file exist?`
    const importerMod: EnvironmentModuleNode | undefined =
      moduleGraph.idToModuleMap.get(id)?.importers.values().next().value
    const importer = importerMod?.file || importerMod?.url
    const err: any = new Error(
      `Failed to load url ${url} (resolved id: ${id})${
        importer ? ` in ${importer}` : ''
      }. ${msg}`,
    )
    err.code = isPublicFile ? ERR_LOAD_PUBLIC_URL : ERR_LOAD_URL
    throw err
  }

  // 如果模块类型未定义，尝试从 ID 推断模块类型
  if (moduleType === undefined) {
    const guessedModuleType = getModuleTypeFromId(id)
    if (guessedModuleType && guessedModuleType !== 'js') {
      moduleType = guessedModuleType
    }
  }

  // 如果环境正在关闭且配置为可恢复，抛出服务器关闭错误
  if (environment._closing && environment.config.dev.recoverable)
    throwClosedServerError()

  // ensure module in graph after successful load
  // 确保模块在模块图中，如果不存在则创建
  mod ??= await moduleGraph._ensureEntryFromUrl(url, undefined, resolved)

  // transform
  const transformStart = debugTransform ? performance.now() : 0
  // 转换模块内容
  const transformResult = await pluginContainer.transform(code, id, {
    inMap: map,
    moduleType,
  })
  const originalCode = code
  if (transformResult.code === originalCode) {
    // no transform applied, keep code as-is
    debugTransform?.(
      timeFrom(transformStart) + colors.dim(` [skipped] ${prettyUrl}`),
    )
  } else {
    debugTransform?.(`${timeFrom(transformStart)} ${prettyUrl}`)
    code = transformResult.code!
    map = transformResult.map
  }

  let normalizedMap: SourceMap | { mappings: '' } | null
  if (typeof map === 'string') {
    // 从字符串解析源码映射
    normalizedMap = JSON.parse(map)
  } else if (map) {
    // 直接使用映射对象
    normalizedMap = map as SourceMap | { mappings: '' }
  } else {
    // 无源码映射
    normalizedMap = null
  }

  if (normalizedMap && 'version' in normalizedMap && mod.file) {
    // 注入源码内容到模块文件
    if (normalizedMap.mappings) {
      await injectSourcesContent(normalizedMap, mod.file, logger)
    }

    const sourcemapPath = `${mod.file}.map`
    // 根据配置的忽略列表处理源码映射
    // 允许用户通过配置忽略某些文件的源码映射，提高构建性能和安全性
    applySourcemapIgnoreList(
      normalizedMap,
      sourcemapPath,
      config.server.sourcemapIgnoreList,
      logger,
    )

    if (path.isAbsolute(mod.file)) {
      let modDirname
      for (
        let sourcesIndex = 0;
        sourcesIndex < normalizedMap.sources.length;
        ++sourcesIndex
      ) {
        const sourcePath = normalizedMap.sources[sourcesIndex]
        if (sourcePath) {
          // Rewrite sources to relative paths to give debuggers the chance
          // to resolve and display them in a meaningful way (rather than
          // with absolute paths).
          if (path.isAbsolute(sourcePath)) {
            modDirname ??= path.dirname(mod.file)
            // 转换为相对于模块文件目录的相对路径
            normalizedMap.sources[sourcesIndex] = path.relative(
              modDirname,
              sourcePath,
            )
          }
        }
      }
    }
  }

  // 如果正在关闭且配置为可恢复，抛出服务器关闭错误
  if (environment._closing && environment.config.dev.recoverable)
    throwClosedServerError()

  const topLevelConfig = environment.getTopLevelConfig()

  // moduleRunnerTransform 是否需要使用“模块运行器转换”
  // ssr 需要；client 不需要
  const result = environment.config.dev.moduleRunnerTransform
    ? await ssrTransform(code, normalizedMap, url, originalCode, {
        json: {
          stringify:
            topLevelConfig.json.stringify === true &&
            topLevelConfig.json.namedExports !== true,
        },
      })
    : ({
        code, // 保持原始代码
        map: normalizedMap, // sourcemap
        etag: getEtag(code, { weak: true }), // 生成弱 ETag
      } satisfies TransformResult)

  // Only cache the result if the module wasn't invalidated while it was
  // being processed, so it is re-processed next time if it is stale
  if (timestamp > mod.lastInvalidationTimestamp)
    // 更新模块图中的模块转换结果
    moduleGraph.updateModuleTransformResult(mod, result)

  return result
}

/**
 * When a module is soft-invalidated, we can preserve its previous `transformResult` and
 * return similar code to before:
 *
 * - Client: We need to transform the import specifiers with new timestamps
 * - SSR: We don't need to change anything as `ssrLoadModule` controls it
 */
async function handleModuleSoftInvalidation(
  environment: DevEnvironment,
  mod: EnvironmentModuleNode,
  timestamp: number,
) {
  const transformResult = mod.invalidationState

  // Reset invalidation state
  mod.invalidationState = undefined

  // Skip if not soft-invalidated
  if (!transformResult || transformResult === 'HARD_INVALIDATED') return

  if (mod.transformResult) {
    throw new Error(
      `Internal server error: Soft-invalidated module "${mod.url}" should not have existing transform result`,
    )
  }

  let result: TransformResult
  // For SSR soft-invalidation, no transformation is needed
  if (transformResult.ssr) {
    result = transformResult
  }
  // We need to transform each imports with new timestamps if available
  else {
    await init
    const source = transformResult.code
    const s = new MagicString(source)
    const [imports] = parseImports(source, mod.id || undefined)

    for (const imp of imports) {
      let rawUrl = source.slice(imp.s, imp.e)
      if (rawUrl === 'import.meta') continue

      const hasQuotes = rawUrl[0] === '"' || rawUrl[0] === "'"
      if (hasQuotes) {
        rawUrl = rawUrl.slice(1, -1)
      }

      const urlWithoutTimestamp = removeTimestampQuery(rawUrl)
      // hmrUrl must be derived the same way as importAnalysis
      const hmrUrl = unwrapId(
        stripBase(
          removeImportQuery(urlWithoutTimestamp),
          environment.config.base,
        ),
      )
      for (const importedMod of mod.importedModules) {
        if (importedMod.url !== hmrUrl) continue
        if (importedMod.lastHMRTimestamp > 0) {
          const replacedUrl = injectQuery(
            urlWithoutTimestamp,
            `t=${importedMod.lastHMRTimestamp}`,
          )
          const start = hasQuotes ? imp.s + 1 : imp.s
          const end = hasQuotes ? imp.e - 1 : imp.e
          s.overwrite(start, end, replacedUrl)
        }

        if (imp.d === -1 && environment.config.dev.preTransformRequests) {
          // pre-transform known direct imports
          environment.warmupRequest(hmrUrl)
        }

        break
      }
    }

    // Update `transformResult` with new code. We don't have to update the sourcemap
    // as the timestamp changes doesn't affect the code lines (stable).
    const code = s.toString()
    result = {
      ...transformResult,
      code,
      etag: getEtag(code, { weak: true }),
    }
  }

  // Only cache the result if the module wasn't invalidated while it was
  // being processed, so it is re-processed next time if it is stale
  if (timestamp > mod.lastInvalidationTimestamp)
    environment.moduleGraph.updateModuleTransformResult(mod, result)

  return result
}

// https://github.com/rolldown/rolldown/blob/cc66f4b7189dfb3a248608d02f5962edb09b11f8/crates/rolldown/src/utils/normalize_options.rs#L95-L111
const defaultModuleTypes: Record<string, ModuleType | undefined> = {
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'jsx',
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'tsx',
  json: 'json',
  txt: 'text',
  css: 'css',
}

// https://github.com/rolldown/rolldown/blob/bf53a100edf1780d5a5aa41f0bc0459c5696543e/crates/rolldown/src/utils/load_source.rs#L53-L89
export function getModuleTypeFromId(id: string): ModuleType | undefined {
  let pos = -1
  while ((pos = id.indexOf('.', pos + 1)) >= 0) {
    const ext = id.slice(pos + 1)
    const moduleType = defaultModuleTypes[ext]
    if (moduleType) {
      return moduleType
    }
  }
}
