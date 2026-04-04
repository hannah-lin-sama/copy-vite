import { pathToFileURL } from 'node:url'
import type { FetchResult } from 'vite/module-runner'
import type { EnvironmentModuleNode, TransformResult } from '..'
import { tryNodeResolve } from '../plugins/resolve'
import { isBuiltin, isExternalUrl, isFilePathESM } from '../utils'
import { unwrapId } from '../../shared/utils'
import {
  MODULE_RUNNER_SOURCEMAPPING_SOURCE,
  SOURCEMAPPING_URL,
} from '../../shared/constants'
import { genSourceMapUrl } from '../server/sourcemap'
import type { DevEnvironment } from '../server/environment'

export interface FetchModuleOptions {
  cached?: boolean
  inlineSourceMap?: boolean
  startOffset?: number
}

/**
 * Fetch module information for Vite runner.
 * 在服务端环境中获取和处理模块
 * 它支持多种类型的模块获取，包括内置模块、外部模块和本地模块，并返回处理后的模块信息。
 * @experimental
 */
export async function fetchModule(
  // 开发环境实例
  environment: DevEnvironment,
  // 要获取的模块的 ID 或路径
  url: string,
  // 导入该模块的模块路径（可选）
  importer?: string,
  options: FetchModuleOptions = {},
): Promise<FetchResult> {
  // 1、内置模块与 Data URL 处理
  if (
    url.startsWith('data:') ||
    // 使用 isBuiltin 函数检查是否为内置模块
    isBuiltin(environment.config.resolve.builtins, url)
  ) {
    // 直接返回外部化结果，类型为 'builtin'
    return { externalize: url, type: 'builtin' }
  }

  // 2、 外部 URL 处理
  // handle file urls from not statically analyzable dynamic import
  const isFileUrl = url.startsWith('file://')

  if (isExternalUrl(url) && !isFileUrl) {
    // 返回外部化结果，类型为 'network'
    return { externalize: url, type: 'network' }
  }

  // if there is no importer, the file is an entry point
  // entry points are always internalized
  // 3、第三方依赖处理
  if (!isFileUrl && importer && url[0] !== '.' && url[0] !== '/') {
    const { isProduction, root } = environment.config
    const { externalConditions, dedupe, preserveSymlinks } =
      environment.config.resolve

    // 解析第三方依赖
    const resolved = tryNodeResolve(url, importer, {
      mainFields: ['main'],
      conditions: externalConditions,
      externalConditions,
      external: [],
      noExternal: [],
      extensions: ['.js', '.cjs', '.json'],
      dedupe,
      preserveSymlinks,
      tsconfigPaths: false,
      isBuild: false,
      isProduction,
      root,
      packageCache: environment.config.packageCache,
      builtins: environment.config.resolve.builtins,
    })
    if (!resolved) {
      const err: any = new Error(
        `Cannot find module '${url}' imported from '${importer}'`,
      )
      err.code = 'ERR_MODULE_NOT_FOUND'
      throw err
    }
    const file = pathToFileURL(resolved.id).toString()
    const type = isFilePathESM(resolved.id, environment.config.packageCache)
      ? 'module'
      : 'commonjs'
    return { externalize: file, type }
  }

  // 移除可能的包装
  url = unwrapId(url)

  // 模块获取：从模块图中获取或创建模块实例
  const mod = await environment.moduleGraph.ensureEntryFromUrl(url)
  // 缓存检查：检查模块是否已缓存（是否有转换结果）
  const cached = !!mod.transformResult

  // if url is already cached, we can just confirm it's also cached on the server
  // 缓存处理
  if (options.cached && cached) {
    return { cache: true }
  }

  // 模块转换
  let result = await environment.transformRequest(url)

  // 错误处理：如果转换失败，抛出错误
  if (!result) {
    throw new Error(
      `[vite] transform failed for module '${url}'${
        importer ? ` imported from '${importer}'` : ''
      }.`,
    )
  }

  // 源代码映射：如果选项允许，内联源代码映射
  if (options.inlineSourceMap !== false) {
    result = inlineSourceMap(mod, result, options.startOffset)
  }

  // remove shebang
  // 移除 Shebang：如果代码以 # 开头，移除 shebang 行并保持行长度不变
  if (result.code[0] === '#')
    result.code = result.code.replace(/^#!.*/, (s) => ' '.repeat(s.length))

  return {
    code: result.code, // 转换后的代码
    file: mod.file, // 模块文件路径
    id: mod.id!,
    url: mod.url,
    invalidate: !cached, // 是否需要失效
  }
}

const OTHER_SOURCE_MAP_REGEXP = new RegExp(
  `//# ${SOURCEMAPPING_URL}=data:application/json[^,]+base64,([A-Za-z0-9+/=]+)$`,
  'gm',
)

/**
 * 将源代码映射（source map）内联到转换后的代码中。
 * 它确保在调试时能够正确显示原始源代码位置，提高开发和调试体验。
 * @param mod 模块实例
 * @param result 转换结果
 * @param startOffset 开始偏移量（可选）
 * @returns 内联后的转换结果
 */
function inlineSourceMap(
  mod: EnvironmentModuleNode,
  result: TransformResult,
  startOffset: number | undefined,
) {
  const map = result.map
  let code = result.code

  // 检查是否存在 source map
  // 检查 source map 是否包含 version 属性
  // 检查代码是否已经包含模块运行器的 source mapping 标记
  if (
    !map ||
    !('version' in map) ||
    code.includes(MODULE_RUNNER_SOURCEMAPPING_SOURCE)
  )
    return result

  // to reduce the payload size, we only inline vite node source map, because it's also the only one we use
  // 清理其他 source map 引用
  // 目的：减少代码体积，只保留 Vite 节点需要的 source map
  OTHER_SOURCE_MAP_REGEXP.lastIndex = 0
  if (OTHER_SOURCE_MAP_REGEXP.test(code))
    code = code.replace(OTHER_SOURCE_MAP_REGEXP, '')

  // 偏移量处理：如果提供了 startOffset，则调整 source map 的 mappings
  const sourceMap = startOffset
    ? Object.assign({}, map, {
        mappings: ';'.repeat(startOffset) + map.mappings,
      })
    : map

  // 生成内联 source map
  result.code = `${code.trimEnd()}\n//# sourceURL=${
    mod.id
  }\n${MODULE_RUNNER_SOURCEMAPPING_SOURCE}\n//# ${SOURCEMAPPING_URL}=${genSourceMapUrl(sourceMap)}\n`

  return result
}
