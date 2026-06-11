import aliasPlugin, { type ResolverFunction } from '@rollup/plugin-alias'
import type { ObjectHook } from 'rolldown'
import {
  viteAliasPlugin as nativeAliasPlugin,
  viteJsonPlugin as nativeJsonPlugin,
  viteWasmFallbackPlugin as nativeWasmFallbackPlugin,
  oxcRuntimePlugin,
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
 * 用于解析 Vite 插件
 * @param config
 * @param prePlugins
 * @param normalPlugins
 * @param postPlugins
 * @returns
 */
export async function resolvePlugins(
  config: ResolvedConfig,
  prePlugins: Plugin[],
  normalPlugins: Plugin[],
  postPlugins: Plugin[],
): Promise<Plugin[]> {
  const isBuild = config.command === 'build' // 是否为构建命令
  const isBundled = config.isBundled // 是否为 Full Bundle 模式
  const isWorker = config.isWorker // 是否为 worker 模式
  const buildPlugins = isBundled
    ? // 如果是捆绑模式，动态导入并解析构建插件
      await (await import('../build')).resolveBuildPlugins(config)
    : { pre: [], post: [] }
  const { modulePreload } = config.build

  return [
    !isBundled ? optimizedDepsPlugin() : null, // 优化依赖插件 (非捆绑模式)
    !isWorker ? watchPackageDataPlugin(config.packageCache) : null, // 包数据监听插件 (非 Worker 环境)
    !isBundled ? preAliasPlugin(config) : null, // 预别名插件 (非捆绑模式)
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

    // 模块预加载 polyfill 插件
    modulePreload !== false && modulePreload.polyfill
      ? modulePreloadPolyfillPlugin(config)
      : null,
    // OXC 解析插件
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
    // HTML 内联代理插件
    htmlInlineProxyPlugin(config),
    // CSS 插件
    cssPlugin(config),
    // ESBuild 兼容性插件
    esbuildBannerFooterCompatPlugin(config),
    // @oxc-project/runtime resolution is handled by rolldown in build
    // OXC 运行时和核心插件
    config.oxc !== false && !isBundled ? oxcRuntimePlugin() : null,
    config.oxc !== false ? oxcPlugin(config) : null,
    // JSON 插件
    nativeJsonPlugin({ ...config.json, minify: isBuild }),
    // WASM 辅助插件
    wasmHelperPlugin(),
    // Web Worker 插件
    webWorkerPlugin(config),
    // 资源插件
    assetPlugin(config),
    // for now client only
    // 控制台转发插件
    config.server.forwardConsole.enabled &&
      forwardConsolePlugin({ environments: ['client'] }),

    ...normalPlugins,

    // WASM 回退插件
    nativeWasmFallbackPlugin(),
    // 定义插件
    definePlugin(config),
    // CSS 后处理插件
    cssPostPlugin(config),
    // 构建 HTML 插件
    isBundled && buildHtmlPlugin(config),
    // Worker 和资源的 import.meta.url 插件
    workerImportMetaUrlPlugin(config),
    assetImportMetaUrlPlugin(config),
    ...buildPlugins.pre,
    // 动态导入变量插件
    dynamicImportVarsPlugin(config),
    // 导入全局插件
    importGlobPlugin(config),

    ...postPlugins,

    ...buildPlugins.post,

    // internal server-only plugins are always applied after everything else
    ...(isBundled
      ? []
      : [
          // 客户端注入插件
          clientInjectionsPlugin(config),
          // CSS 分析插件
          cssAnalysisPlugin(config),
          // 导入分析插件
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
          sortedPlugins.splice(pre++, 0, plugin)
          continue
        }
        if (hook.order === 'post') {
          sortedPlugins.splice(pre + normal + post++, 0, plugin)
          continue
        }
      }
      sortedPlugins.splice(pre + normal++, 0, plugin)
    }
  }

  return sortedPlugins as PluginWithRequiredHook<K>[]
}

export function getHookHandler<T extends ObjectHook<Function>>(
  hook: T,
): HookHandler<T> {
  return (typeof hook === 'object' ? hook.handler : hook) as HookHandler<T>
}

type FilterForPluginValue = {
  // 用于 resolveId 钩子的过滤器
  resolveId?: PluginFilter | undefined
  // 用于 load 钩子的过滤器
  load?: PluginFilter | undefined
  // 用于 transform 钩子的过滤器
  transform?: TransformHookFilter | undefined
}
const filterForPlugin = new WeakMap<Plugin, FilterForPluginValue>()

/**
 * 获取并缓存插件钩子的过滤器
 * 为插件的 resolveId、load 和 transform 钩子创建并缓存相应的过滤器函数
 * @param plugin
 * @param hookName
 * @returns
 */
export function getCachedFilterForPlugin<
  H extends 'resolveId' | 'load' | 'transform',
>(plugin: Plugin, hookName: H): FilterForPluginValue[H] | undefined {
  // 有缓存直接取
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
      // 提取并创建 ID 过滤器
      // extractFilter 提取plugin.resolveId 的 filter属性
      // rawFilter 是一个数组[]
      const rawFilter = extractFilter(plugin.resolveId)?.id
      // 设置 resolveId 缓存，组合过滤器，支持排除和包含过滤
      filters.resolveId = createIdFilter(rawFilter)
      filter = filters.resolveId
      break
    }
    case 'load': {
      // 提取并创建 ID 过滤器
      const rawFilter = extractFilter(plugin.load)?.id
      // 设置 load 缓存
      filters.load = createIdFilter(rawFilter)
      filter = filters.load
      break
    }
    case 'transform': {
      // 提取并创建转换过滤器，支持 ID、代码和模块类型过滤
      const rawFilters = extractFilter(plugin.transform)
      // 设置 transform 缓存
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

// 提取插件钩子的过滤器
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
