import aliasPlugin, { type ResolverFunction } from '@rollup/plugin-alias'
import type { ObjectHook } from 'rolldown'
import {
  viteAliasPlugin as nativeAliasPlugin,
  viteJsonPlugin as nativeJsonPlugin,
  viteWasmFallbackPlugin as nativeWasmFallbackPlugin,
} from 'rolldown/experimental'
import type { PluginHookUtils, ResolvedConfig } from '../config'
import {
  type HookHandler,
  type Plugin,
  type PluginWithRequiredHook,
} from '../plugin'
import { watchPackageDataPlugin } from '../packages'
import { oxcResolvePlugin } from './resolve'
import { optimizedDepsPlugin } from './optimizedDeps'
import { importAnalysisPlugin } from './importAnalysis'
import { cssAnalysisPlugin, cssPlugin, cssPostPlugin } from './css'
import { assetPlugin } from './asset'
import { clientInjectionsPlugin } from './clientInjections'
import { buildHtmlPlugin, htmlInlineProxyPlugin } from './html'
import { wasmHelperPlugin } from './wasm'
import { modulePreloadPolyfillPlugin } from './modulePreloadPolyfill'
import { webWorkerPlugin } from './worker'
import { preAliasPlugin } from './preAlias'
import { definePlugin } from './define'
import { workerImportMetaUrlPlugin } from './workerImportMetaUrl'
import { assetImportMetaUrlPlugin } from './assetImportMetaUrl'
import { dynamicImportVarsPlugin } from './dynamicImportVars'
import { importGlobPlugin } from './importMetaGlob'
import {
  type PluginFilter,
  type TransformHookFilter,
  createFilterForTransform,
  createIdFilter,
} from './pluginFilter'
import { forwardConsolePlugin } from './forwardConsole'
import { oxcPlugin } from './oxc'
import { esbuildBannerFooterCompatPlugin } from './esbuildBannerFooterCompatPlugin'

/**
 * 解析插件
 * @param config 已解析的配置
 * @param prePlugins 预插件
 * @param normalPlugins 预插件 normal
 * @param postPlugins 后插件
 * @returns 插件数组
 */
export async function resolvePlugins(
  config: ResolvedConfig,
  prePlugins: Plugin[],
  normalPlugins: Plugin[],
  postPlugins: Plugin[],
): Promise<Plugin[]> {
  const isBuild = config.command === 'build' // 是否为构建命令
  const isBundled = config.isBundled // 是否为捆绑模式
  const isWorker = config.isWorker // 是否为 Worker 模式
  // 根据是否为捆绑模式，解析不同的插件
  // 如果是捆绑模式，解析构建插件；否则，返回空数组
  const buildPlugins = isBundled
    ? await (await import('../build')).resolveBuildPlugins(config)
    : { pre: [], post: [] }

  const { modulePreload } = config.build

  return [
    // 1、prePlugins 插件
    // 非捆绑模式下，优化依赖项插件
    !isBundled ? optimizedDepsPlugin() : null,
    // 非 Worker 模式下，监听包数据插件
    !isWorker ? watchPackageDataPlugin(config.packageCache) : null,
    // 非捆绑模式下，预别名插件
    !isBundled ? preAliasPlugin(config) : null,
    // 捆绑模式下，根据是否自定义解析器选择不同的别名插件
    isBundled && !config.resolve.alias.some((v) => v.customResolver)
      ? nativeAliasPlugin({
          entries: config.resolve.alias.map((item) => {
            return {
              find: item.find,
              replacement: item.replacement,
            }
          }),
        })
      : aliasPlugin({
          // @ts-expect-error aliasPlugin receives rollup types
          entries: config.resolve.alias,
          customResolver: viteAliasCustomResolver,
        }),

    ...prePlugins,

    // 2、normalPlugins 插件
    // 注入模块预加载 polyfill
    modulePreload !== false && modulePreload.polyfill
      ? modulePreloadPolyfillPlugin(config)
      : null,
    // 基于 Oxc 的模块解析插件，用于处理依赖解析、外部化、优化等
    ...oxcResolvePlugin(
      {
        root: config.root,
        isProduction: config.isProduction,
        isBuild,
        packageCache: config.packageCache,
        asSrc: true,
        optimizeDeps: true,
        externalize: true,
        legacyInconsistentCjsInterop: config.legacy?.inconsistentCjsInterop,
      },
      isWorker
        ? { ...config, consumer: 'client', optimizeDepsPluginNames: [] }
        : undefined,
    ),
    // 处理 HTML 中的内联脚本和样式
    htmlInlineProxyPlugin(config),
    cssPlugin(config), // 处理 CSS 文件（包括预处理器、CSS 模块等）
    // 兼容 esbuild 的 banner/footer 选项
    esbuildBannerFooterCompatPlugin(config),
    // 使用 Oxc 进行 JavaScript/TypeScript/JSX 转换，替代 esbuild
    config.oxc !== false ? oxcPlugin(config) : null,
    // 处理 JSON 文件，支持命名导入等
    nativeJsonPlugin({ ...config.json, minify: isBuild }),
    wasmHelperPlugin(), // 处理 WebAssembly 模块（.wasm）
    webWorkerPlugin(config), // 处理 Web Worker 导入（new Worker 语法）
    assetPlugin(config), // 处理静态资源（图片、字体等），返回 URL
    // for now client only
    // 将浏览器控制台日志转发到服务器终端
    config.server.forwardConsole.enabled &&
      forwardConsolePlugin({ environments: ['client'] }),

    ...normalPlugins,

    // 3、postPlugins 插件
    nativeWasmFallbackPlugin(), // WebAssembly 回退插件
    definePlugin(config), // 处理 define 配置，替换全局常量
    cssPostPlugin(config), // CSS 后处理插件（如压缩、source map）
    // 构建时处理 HTML 文件， 捆绑模式下生效
    isBundled && buildHtmlPlugin(config),
    // 处理 Worker 中的 import.meta.url
    workerImportMetaUrlPlugin(config),
    // 处理静态资源中的 import.meta.url
    assetImportMetaUrlPlugin(config),
    // 构建时插件的前置部分
    ...buildPlugins.pre,
    // 处理动态导入变量（如 import('./${name}.js')）
    dynamicImportVarsPlugin(config),
    importGlobPlugin(config), // 处理 import.meta.glob 语法

    ...postPlugins,

    ...buildPlugins.post, // 构建时插件的后置部分

    // internal server-only plugins are always applied after everything else
    // 非捆绑模式下，注入客户端代码（如分析工具、热更新等）
    ...(isBundled
      ? []
      : [
          // 注入 HMR 客户端代码
          clientInjectionsPlugin(config),
          // 注入 CSS 分析插件
          cssAnalysisPlugin(config),
          // 注入导入分析插件
          importAnalysisPlugin(config),
        ]),
  ].filter(Boolean) as Plugin[]
}

export function createPluginHookUtils(
  plugins: readonly Plugin[],
): PluginHookUtils {
  // sort plugins per hook
  const sortedPluginsCache = new Map<keyof Plugin, Plugin[]>()
  function getSortedPlugins<K extends keyof Plugin>(
    hookName: K,
  ): PluginWithRequiredHook<K>[] {
    if (sortedPluginsCache.has(hookName))
      return sortedPluginsCache.get(hookName) as PluginWithRequiredHook<K>[]
    const sorted = getSortedPluginsByHook(hookName, plugins)
    sortedPluginsCache.set(hookName, sorted)
    return sorted
  }
  function getSortedPluginHooks<K extends keyof Plugin>(
    hookName: K,
  ): NonNullable<HookHandler<Plugin[K]>>[] {
    const plugins = getSortedPlugins(hookName)
    return plugins.map((p) => getHookHandler(p[hookName])).filter(Boolean)
  }

  return {
    getSortedPlugins,
    getSortedPluginHooks,
  }
}

/**
 * 根据插件钩子名称排序插件
 * @param hookName 插件钩子名称
 * @param plugins 插件数组
 * @returns
 */
export function getSortedPluginsByHook<K extends keyof Plugin>(
  hookName: K,
  plugins: readonly Plugin[],
): PluginWithRequiredHook<K>[] {
  const sortedPlugins: Plugin[] = []
  // Use indexes to track and insert the ordered plugins directly in the
  // resulting array to avoid creating 3 extra temporary arrays per hook
  let pre = 0,
    normal = 0,
    post = 0
  for (const plugin of plugins) {
    const hook = plugin[hookName]
    if (hook) {
      if (typeof hook === 'object') {
        if (hook.order === 'pre') {
          // 插入 pre 插件
          sortedPlugins.splice(pre++, 0, plugin)
          continue
        }
        if (hook.order === 'post') {
          // 插入 post 插件
          sortedPlugins.splice(pre + normal + post++, 0, plugin)
          continue
        }
      }
      // 插入普通插件
      sortedPlugins.splice(pre + normal++, 0, plugin)
    }
  }

  return sortedPlugins as PluginWithRequiredHook<K>[]
}

/**
 * 获取插件钩子函数的处理函数
 * @param hook 插件钩子函数
 * @returns
 */
export function getHookHandler<T extends ObjectHook<Function>>(
  hook: T,
): HookHandler<T> {
  return (typeof hook === 'object' ? hook.handler : hook) as HookHandler<T>
}

type FilterForPluginValue = {
  resolveId?: PluginFilter | undefined
  load?: PluginFilter | undefined
  transform?: TransformHookFilter | undefined
}
const filterForPlugin = new WeakMap<Plugin, FilterForPluginValue>()

export function getCachedFilterForPlugin<
  H extends 'resolveId' | 'load' | 'transform',
>(plugin: Plugin, hookName: H): FilterForPluginValue[H] | undefined {
  let filters = filterForPlugin.get(plugin)
  if (filters && hookName in filters) {
    return filters[hookName]
  }

  if (!filters) {
    filters = {}
    filterForPlugin.set(plugin, filters)
  }

  let filter: PluginFilter | TransformHookFilter | undefined
  switch (hookName) {
    case 'resolveId': {
      const rawFilter = extractFilter(plugin.resolveId)?.id
      filters.resolveId = createIdFilter(rawFilter)
      filter = filters.resolveId
      break
    }
    case 'load': {
      const rawFilter = extractFilter(plugin.load)?.id
      filters.load = createIdFilter(rawFilter)
      filter = filters.load
      break
    }
    case 'transform': {
      const rawFilters = extractFilter(plugin.transform)
      filters.transform = createFilterForTransform(
        rawFilters?.id,
        rawFilters?.code,
        rawFilters?.moduleType,
      )
      filter = filters.transform
      break
    }
  }
  return filter as FilterForPluginValue[H] | undefined
}

function extractFilter<T extends Function, F>(
  hook: ObjectHook<T, { filter?: F }> | undefined,
) {
  return hook && 'filter' in hook && hook.filter ? hook.filter : undefined
}

// Same as `@rollup/plugin-alias` default resolver, but we attach additional meta
// if we can't resolve to something, which will error in `importAnalysis`
export const viteAliasCustomResolver: ResolverFunction = async function (
  id,
  importer,
  options,
) {
  const resolved = await this.resolve(id, importer, options)
  return resolved || { id, meta: { 'vite:alias': { noResolved: true } } }
}
