/**
 * This file is refactored into TypeScript based on
 * https://github.com/preactjs/wmr/blob/main/packages/wmr/src/lib/rollup-plugin-container.js
 */

/**
https://github.com/preactjs/wmr/blob/master/LICENSE

MIT License

Copyright (c) 2020 The Preact Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseAst as rolldownParseAst } from 'rolldown/parseAst'
import type { ESTree } from 'rolldown/utils'
import type {
  AsyncPluginHooks,
  CustomPluginOptions,
  EmittedFile,
  FunctionPluginHooks,
  ImportKind,
  InputOptions,
  LoadResult,
  ModuleInfo,
  ModuleOptions,
  ModuleType,
  NormalizedInputOptions,
  OutputOptions,
  ParallelPluginHooks,
  PartialNull,
  PartialResolvedId,
  PluginContextMeta,
  ResolvedId,
  RollupError,
  RolldownFsModule as RollupFsModule,
  RollupLog,
  MinimalPluginContext as RollupMinimalPluginContext,
  PluginContext as RollupPluginContext,
  TransformPluginContext as RollupTransformPluginContext,
  SourceDescription,
  SourceMap,
  TransformResult,
} from 'rolldown'
import type { RawSourceMap } from '@jridgewell/remapping'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import MagicString from 'magic-string'
import colors from 'picocolors'
import type { FSWatcher } from '#dep-types/chokidar'
import type { Plugin } from '../plugin'
import {
  combineSourcemaps,
  createDebugger,
  ensureWatchedFile,
  generateCodeFrame,
  isExternalUrl,
  isObject,
  normalizePath,
  numberToPos,
  prettifyUrl,
  rolldownVersion,
  rollupVersion,
  timeFrom,
} from '../utils'
import { FS_PREFIX, VERSION as viteVersion } from '../constants'
import {
  createPluginHookUtils,
  getCachedFilterForPlugin,
  getHookHandler,
} from '../plugins'
import { cleanUrl, unwrapId } from '../../shared/utils'
import type { PluginHookUtils } from '../config'
import type { Environment } from '../environment'
import type { Logger } from '../logger'
import {
  isFutureDeprecationEnabled,
  warnFutureDeprecation,
} from '../deprecations'
import type { DevEnvironment } from './environment'
import { buildErrorMessage } from './middlewares/error'
import type {
  EnvironmentModuleGraph,
  EnvironmentModuleNode,
} from './moduleGraph'

// same default value of "moduleInfo.meta" as in Rollup
const EMPTY_OBJECT = Object.freeze({})

const debugSourcemapCombineFilter =
  process.env.DEBUG_VITE_SOURCEMAP_COMBINE_FILTER
const debugSourcemapCombine = createDebugger('vite:sourcemap-combine', {
  onlyWhenFocused: true,
})
const debugResolve = createDebugger('vite:resolve')
const debugPluginResolve = createDebugger('vite:plugin-resolve', {
  onlyWhenFocused: 'vite:plugin',
})
const debugPluginTransform = createDebugger('vite:plugin-transform', {
  onlyWhenFocused: 'vite:plugin',
})
const debugPluginContainerContext = createDebugger(
  'vite:plugin-container-context',
)

export const ERR_CLOSED_SERVER = 'ERR_CLOSED_SERVER'

export function throwClosedServerError(): never {
  const err: any = new Error(
    'The server is being restarted or closed. Request is outdated',
  )
  err.code = ERR_CLOSED_SERVER
  // This error will be caught by the transform middleware that will
  // send a 504 status code request timeout
  throw err
}

export interface PluginContainerOptions {
  cwd?: string
  output?: OutputOptions
  modules?: Map<string, { info: ModuleInfo }>
  writeFile?: (name: string, source: string | Uint8Array) => void
}

/**
 * Create a plugin container with a set of plugins. We pass them as a parameter
 * instead of using environment.plugins to allow the creation of different
 * pipelines working with the same environment (used for createIdResolver).
 */
export async function createEnvironmentPluginContainer<
  Env extends Environment = Environment,
>(
  environment: Env,
  plugins: readonly Plugin[],
  watcher?: FSWatcher,
  autoStart = true,
): Promise<EnvironmentPluginContainer<Env>> {
  // 创建环境插件容器
  const container = new EnvironmentPluginContainer(
    environment,
    plugins,
    watcher,
    autoStart,
  )
  // 解析Rollup选项
  await container.resolveRollupOptions()
  return container
}

export type SkipInformation = {
  id: string
  importer: string | undefined
  plugin: Plugin
  called?: boolean
}

/**
 * 环境插件容器
 */
class EnvironmentPluginContainer<Env extends Environment = Environment> {
  private _pluginContextMap = new Map<Plugin, PluginContext>()
  private _resolvedRollupOptions?: InputOptions
  private _processesing = new Set<Promise<any>>()
  private _seenResolves: Record<string, true | undefined> = {}

  // _addedFiles from the `load()` hook gets saved here so it can be reused in the `transform()` hook
  private _moduleNodeToLoadAddedImports = new WeakMap<
    EnvironmentModuleNode,
    Set<string> | null
  >()

  getSortedPluginHooks: PluginHookUtils['getSortedPluginHooks']
  getSortedPlugins: PluginHookUtils['getSortedPlugins']

  moduleGraph: EnvironmentModuleGraph | undefined
  watchFiles: Set<string> = new Set()
  minimalContext: MinimalPluginContext<Env>

  private _started = false
  private _buildStartPromise: Promise<void> | undefined
  private _closed = false

  /**
   * @internal use `createEnvironmentPluginContainer` instead
   */
  constructor(
    // 环境对象
    public environment: Env,
    // 插件数组
    public plugins: readonly Plugin[],
    // 文件系统监听器对象
    public watcher?: FSWatcher | undefined,
    // 是否自动启动插件容器
    autoStart = true,
  ) {
    // 启动状态
    this._started = !autoStart
    // 最小插件上下文
    this.minimalContext = new MinimalPluginContext(
      {
        ...basePluginContextMeta,
        watchMode: true,
      },
      environment,
    )
    // 创建插件钩子工具
    const utils = createPluginHookUtils(plugins)
    this.getSortedPlugins = utils.getSortedPlugins
    this.getSortedPluginHooks = utils.getSortedPluginHooks

    // 只有在开发模式下，才设置 moduleGraph
    this.moduleGraph =
      environment.mode === 'dev' ? environment.moduleGraph : undefined
  }

  /**
   * 更新指定模块 ID 对应的 "added imports" 集合
   * @param id
   * @param addedImports
   */
  private _updateModuleLoadAddedImports(
    id: string,
    addedImports: Set<string> | null,
  ): void {
    const module = this.moduleGraph?.getModuleById(id)
    if (module) {
      this._moduleNodeToLoadAddedImports.set(module, addedImports)
    }
  }

  /**
   * 用于获取指定模块 ID 对应的 "added imports" 集合
   * "Added imports" 是指模块在加载过程中通过插件的 addWatchFile 方法添加的额外导入路径。
   * 导入：1、依赖文件 2、配置文件 3、资源文件
   * @param id
   * @returns
   */
  private _getAddedImports(id: string): Set<string> | null {
    const module = this.moduleGraph?.getModuleById(id)
    return module
      ? // 存储模块与其添加的导入之间的对应关
        // 键：模块节点对象；值：该模块添加的导入路径集合
        this._moduleNodeToLoadAddedImports.get(module) || null
      : null
  }

  /**
   * 获取模块信息
   * @param id  模块 ID
   * @returns
   */
  getModuleInfo(id: string): ModuleInfo | null {
    // 从模块图中获取指定 ID 的模块
    const module = this.moduleGraph?.getModuleById(id)
    if (!module) {
      return null
    }
    if (!module.info) {
      // 代理
      module.info = new Proxy(
        { id, meta: module.meta || EMPTY_OBJECT } as ModuleInfo,
        // throw when an unsupported ModuleInfo property is accessed,
        // so that incompatible plugins fail in a non-cryptic way.
        {
          get(info: any, key: string) {
            if (key in info) {
              return info[key]
            }
            // Don't throw an error when returning from an async function
            // 特殊处理 then 属性，避免异步函数返回时出错
            if (key === 'then') {
              return undefined
            }
            // 对于不存在的属性，抛出明确的错误
            throw Error(
              `[vite] The "${key}" property of ModuleInfo is not supported.`,
            )
          },
        },
      )
    }
    return module.info ?? null
  }

  // keeps track of hook promises so that we can wait for them all to finish upon closing the server
  /**
   * 用于处理插件钩子返回的可能是 Promise 或非 Promise 的值。
   * 它的主要作用是跟踪正在处理的 Promise，确保在插件容器关闭时能够等待所有正在处理的 Promise 完成。
   * @param maybePromise
   * @returns
   */
  private handleHookPromise<T>(maybePromise: undefined | T | Promise<T>) {
    // 非 Promise 值直接返回
    if (!(maybePromise as any)?.then) {
      return maybePromise
    }
    const promise = maybePromise as Promise<T>
    // 添加到正在处理的 Promise 集合
    this._processesing.add(promise)
    // 当 Promise 完成时，从正在处理的 Promise 集合中删除
    return promise.finally(() => this._processesing.delete(promise))
  }

  /**
   * 用于获取解析后的 Rollup 配置选项
   */
  get options(): InputOptions {
    return this._resolvedRollupOptions!
  }

  /**
   * 解析 Rollup 配置选项
   * @returns Rollup 配置选项
   */
  async resolveRollupOptions(): Promise<InputOptions> {
    if (!this._resolvedRollupOptions) {
      // 初始化 Rollup 配置选项
      // 从环境配置中获取 Rollup 配置选项
      // 如果插件配置了 Rollup 配置选项，会覆盖默认配置
      let options = this.environment.config.build.rollupOptions
      for (const optionsHook of this.getSortedPluginHooks('options')) {
        if (this._closed) {
          throwClosedServerError()
        }
        options =
          (await this.handleHookPromise(
            optionsHook.call(this.minimalContext, options),
          )) || options
      }
      this._resolvedRollupOptions = options
    }
    return this._resolvedRollupOptions
  }

  private _getPluginContext(plugin: Plugin) {
    if (!this._pluginContextMap.has(plugin)) {
      // 创建插件上下文
      this._pluginContextMap.set(plugin, new PluginContext(plugin, this))
    }
    return this._pluginContextMap.get(plugin)!
  }

  // parallel, ignores returns
  /**
   * 用于并行执行插件的钩子。
   * 它支持并行执行多个插件的同一钩子，同时也支持标记为 sequential 的钩子顺序执行。
   * @param hookName
   * @param context
   * @param args
   * @param condition
   */
  private async hookParallel<H extends AsyncPluginHooks & ParallelPluginHooks>(
    hookName: H,
    context: (plugin: Plugin) => ThisType<FunctionPluginHooks[H]>,
    args: (plugin: Plugin) => Parameters<FunctionPluginHooks[H]>,
    condition?: (plugin: Plugin) => boolean | undefined,
  ): Promise<void> {
    // 并行执行的 Promise 集合
    const parallelPromises: Promise<unknown>[] = []
    // 遍历所有符合条件的插件
    for (const plugin of this.getSortedPlugins(hookName)) {
      // Don't throw here if closed, so buildEnd and closeBundle hooks can finish running
      // 确保即使容器关闭，某些钩子也能完成执行
      if (condition && !condition(plugin)) continue

      const hook = plugin[hookName]
      const handler: Function = getHookHandler(hook)

      // 执行模式
      // 1、顺序执行
      if ((hook as { sequential?: boolean }).sequential) {
        // 等待之前所有并行执行的 Promise 完成
        await Promise.all(parallelPromises)
        parallelPromises.length = 0
        // 执行当前插件的钩子
        await handler.apply(context(plugin), args(plugin))
        // 2、并行执行
      } else {
        // 添加到并行执行的 Promise 集合
        parallelPromises.push(handler.apply(context(plugin), args(plugin)))
      }
    }
    // 等待所有并行执行的 Promise 完成
    await Promise.all(parallelPromises)
  }

  /**
   * 用于在构建开始时触发所有插件的 buildStart 钩子。它确保钩子只执行一次，即使该方法被多次调用
   * @param _options
   * @returns
   */
  async buildStart(_options?: InputOptions): Promise<void> {
    // 确保 buildStart 方法只被调用一次
    if (this._started) {
      if (this._buildStartPromise) {
        await this._buildStartPromise
      }
      return
    }
    this._started = true // 标记为已启动
    const config = this.environment.getTopLevelConfig()
    this._buildStartPromise = this.handleHookPromise(
      // 并行执行所有符合条件的插件的 buildStart 钩子
      this.hookParallel(
        'buildStart',
        (plugin) => this._getPluginContext(plugin),
        () => [this.options as NormalizedInputOptions],
        (plugin) =>
          this.environment.name === 'client' ||
          config.server.perEnvironmentStartEndDuringDev ||
          plugin.perEnvironmentStartEndDuringDev,
      ),
    ) as Promise<void>
    // 等待所有 buildStart 钩子执行完成
    await this._buildStartPromise
    this._buildStartPromise = undefined
  }

  /**
   * 用于解析模块 ID。
   * 它是 Vite 模块解析系统的核心组成部分，负责将原始模块 ID 解析为完整的、可加载的模块路径。
   * @param rawId
   * @param importer
   * @param options
   * @returns
   */
  async resolveId(
    rawId: string,
    importer: string | undefined = join(
      this.environment.config.root,
      'index.html',
    ),
    options?: {
      kind?: ImportKind
      attributes?: Record<string, string>
      custom?: CustomPluginOptions
      /** @deprecated use `skipCalls` instead */
      skip?: Set<Plugin>
      skipCalls?: readonly SkipInformation[]
      /**
       * @internal
       */
      scan?: boolean
      isEntry?: boolean
    },
  ): Promise<PartialResolvedId | null> {
    if (!this._started) {
      // 确保在解析 ID 之前构建已启动
      // 这是 Vite 构建系统的一个重要部分，确保在解析 ID 之前构建已启动
      this.buildStart()
      await this._buildStartPromise
    }
    const skip = options?.skip
    const skipCalls = options?.skipCalls
    const scan = !!options?.scan
    const ssr = this.environment.config.consumer === 'server'
    // 创建解析上下文
    const ctx = new ResolveIdContext(this, skip, skipCalls, scan)
    const topLevelConfig = this.environment.getTopLevelConfig()

    // 需要跳过的插件集合
    const mergedSkip = new Set<Plugin>(skip)
    for (const call of skipCalls ?? []) {
      if (call.called || (call.id === rawId && call.importer === importer)) {
        mergedSkip.add(call.plugin)
      }
    }

    const resolveStart = debugResolve ? performance.now() : 0
    let id: string | null = null
    const partial: Partial<PartialResolvedId> = {}
    // 遍历所有符合条件的插件
    for (const plugin of this.getSortedPlugins('resolveId')) {
      if (this._closed && this.environment.config.dev.recoverable)
        throwClosedServerError()
      if (mergedSkip?.has(plugin)) continue

      const filter = getCachedFilterForPlugin(plugin, 'resolveId')
      if (filter && !filter(rawId)) continue

      ctx._plugin = plugin

      const normalizedOptions = {
        kind: options?.kind,
        attributes: options?.attributes ?? {},
        custom: options?.custom,
        isEntry: !!options?.isEntry,
        ssr,
        scan,
      }
      if (
        isFutureDeprecationEnabled(
          topLevelConfig,
          'removePluginHookSsrArgument',
        )
      ) {
        let ssrTemp = ssr
        Object.defineProperty(normalizedOptions, 'ssr', {
          get() {
            warnFutureDeprecation(
              topLevelConfig,
              'removePluginHookSsrArgument',
              `Used in plugin "${plugin.name}".`,
            )
            return ssrTemp
          },
          set(v) {
            ssrTemp = v
          },
        })
      }

      const pluginResolveStart = debugPluginResolve ? performance.now() : 0
      const handler = getHookHandler(plugin.resolveId)
      // 调用插件的 resolveId 钩子
      const result = await this.handleHookPromise(
        handler.call(ctx as any, rawId, importer, normalizedOptions),
      )
      if (!result) continue

      // 如果返回字符串，直接作为解析后的 ID
      if (typeof result === 'string') {
        id = result

        // 如果返回对象，提取 ID 并合并其他属性
      } else {
        id = result.id
        Object.assign(partial, result)
      }

      debugPluginResolve?.(
        timeFrom(pluginResolveStart),
        plugin.name,
        prettifyUrl(id, this.environment.config.root),
      )

      // resolveId() is hookFirst - first non-null result is returned.
      break
    }

    if (debugResolve && rawId !== id && !rawId.startsWith(FS_PREFIX)) {
      const key = rawId + id
      // avoid spamming
      if (!this._seenResolves[key]) {
        this._seenResolves[key] = true
        debugResolve(
          `${timeFrom(resolveStart)} ${colors.cyan(rawId)} -> ${colors.dim(
            id,
          )}`,
        )
      }
    }

    // 如果成功解析到 ID，规范化路径并返回完整的解析结果
    if (id) {
      partial.id = isExternalUrl(id) || id[0] === '\0' ? id : normalizePath(id)
      return partial as PartialResolvedId
    } else {
      return null
    }
  }

  /**
   * 用于加载模块内容。
   * 它通过遍历插件的 load 钩子，尝试让插件处理指定的模块 ID，返回模块的内容或 null。
   * @param id  要加载的模块 ID
   * @returns 返回模块加载结果或 null
   */
  async load(id: string): Promise<LoadResult | null> {
    // 确定 SSR 状态
    let ssr = this.environment.config.consumer === 'server'
    // 获取顶部配置
    const topLevelConfig = this.environment.getTopLevelConfig()
    const options = { ssr }
    // 创建加载插件上下文
    const ctx = new LoadPluginContext(this)

    // 遍历排序后的插件
    for (const plugin of this.getSortedPlugins('load')) {
      if (this._closed && this.environment.config.dev.recoverable)
        throwClosedServerError()

      // 获取插件的缓存过滤器
      const filter = getCachedFilterForPlugin(plugin, 'load')
      // 检查是否应该处理当前 ID
      if (filter && !filter(id)) continue

      ctx._plugin = plugin

      // 处理 SSR 参数的未来弃用警告
      if (
        isFutureDeprecationEnabled(
          topLevelConfig,
          'removePluginHookSsrArgument',
        )
      ) {
        Object.defineProperty(options, 'ssr', {
          get() {
            warnFutureDeprecation(
              topLevelConfig,
              'removePluginHookSsrArgument',
              `Used in plugin "${plugin.name}".`,
            )
            return ssr
          },
          set(v) {
            ssr = v
          },
        })
      }

      // 获取插件的 load 钩子处理函数
      const handler = getHookHandler(plugin.load)
      // 执行钩子并处理结果
      const result = await this.handleHookPromise(
        handler.call(ctx as any, id, options),
      )
      if (result != null) {
        // 如果结果是对象，更新模块信
        if (isObject(result)) {
          ctx._updateModuleInfo(id, result)
        }
        // 更新模块加载添加的导入
        this._updateModuleLoadAddedImports(id, ctx._addedImports)
        return result
      }
    }
    // 如果所有插件都没有处理，更新模块加载添加的导入
    this._updateModuleLoadAddedImports(id, ctx._addedImports)
    return null
  }

  /**
   * 用于转换模块代码。
   * 它遍历所有插件的 transform 钩子，依次对代码进行转换，并合并转换结果和 source map
   * @param code
   * @param id
   * @param options
   * @returns
   */
  async transform(
    code: string, // 原始源代码
    id: string, // 模块的绝对路径或虚拟模块标识符
    options?: {
      inMap?: SourceDescription['map']
      moduleType?: string
    },
  ): Promise<{
    code: string
    map: SourceMap | { mappings: '' } | null
    moduleType?: ModuleType
  }> {
    // SSR 模式检测：根据环境配置判断是否为服务端渲染模式
    let ssr = this.environment.config.consumer === 'server'

    const topLevelConfig = this.environment.getTopLevelConfig()
    const optionsWithSSR = options
      ? {
          ...options,
          ssr,
          moduleType: options.moduleType ?? 'js',
        }
      : { ssr, moduleType: 'js' }

    const inMap = options?.inMap

    // 创建 TransformPluginContext 实例，提供插件执行上下文
    const ctx = new TransformPluginContext(this, id, code, inMap as SourceMap)
    ctx._addedImports = this._getAddedImports(id)

    // 插件遍历：遍历排序后的插件，确保插件按正确顺序执行
    for (const plugin of this.getSortedPlugins('transform')) {
      if (this._closed && this.environment.config.dev.recoverable)
        throwClosedServerError()

      // 插件过滤：根据插件的 transform 钩子，判断是否需要执行该插件
      const filter = getCachedFilterForPlugin(plugin, 'transform')
      if (filter && !filter(id, code, optionsWithSSR.moduleType)) continue

      if (
        isFutureDeprecationEnabled(
          topLevelConfig,
          'removePluginHookSsrArgument',
        )
      ) {
        Object.defineProperty(optionsWithSSR, 'ssr', {
          get() {
            warnFutureDeprecation(
              topLevelConfig,
              'removePluginHookSsrArgument',
              `Used in plugin "${plugin.name}".`,
            )
            return ssr
          },
          set(v) {
            ssr = v
          },
        })
      }

      ctx._updateActiveInfo(plugin, id, code)
      const start = debugPluginTransform ? performance.now() : 0
      let result: TransformResult | string | undefined

      // 调用插件的 transform 钩子
      const handler = getHookHandler(plugin.transform)
      try {
        result = await this.handleHookPromise(
          handler.call(ctx as any, code, id, optionsWithSSR),
        )
      } catch (e) {
        ctx.error(e)
      }
      if (!result) continue
      debugPluginTransform?.(
        timeFrom(start),
        plugin.name,
        prettifyUrl(id, this.environment.config.root),
      )
      // 对象格式处理
      if (isObject(result)) {
        if (result.code !== undefined) {
          code = result.code as string
          if (result.map) {
            if (debugSourcemapCombine) {
              // @ts-expect-error inject plugin name for debug purpose
              result.map.name = plugin.name
            }
            ctx.sourcemapChain.push(result.map)
          }
        }
        if (result.moduleType !== undefined) {
          optionsWithSSR.moduleType = result.moduleType
        }
        ctx._updateModuleInfo(id, result)

        // 字符串格式处理
      } else {
        code = result
      }
    }
    return {
      code,
      map: ctx._getCombinedSourcemap(),
      moduleType: optionsWithSSR.moduleType,
    }
  }

  /**
   * 用于在文件发生变化时（创建、更新或删除）触发插件的 watchChange 钩子。
   * 它是 Vite 插件系统中处理文件变化的重要机制，允许插件对文件变化做出响应。
   * @param id  发生变化的文件路径
   * @param change
   */
  async watchChange(
    id: string,
    change: { event: 'create' | 'update' | 'delete' },
  ): Promise<void> {
    const config = this.environment.getTopLevelConfig()

    // 并行触发所有插件的 watchChange 钩子
    await this.hookParallel(
      'watchChange', // 钩子名称：'watchChange'
      (plugin) => this._getPluginContext(plugin), // 插件上下文获取函数
      () => [id, change], // 钩子参数获取函数
      // 目的：控制哪些插件的 watchChange 钩子会被触发，避免不必要的钩子调用
      (plugin) =>
        // 如果当前环境是 'client'，则触发所有插件的钩子
        this.environment.name === 'client' ||
        // 如果配置中启用了 perEnvironmentWatchChangeDuringDev，则触发所有插件的钩子
        config.server.perEnvironmentWatchChangeDuringDev ||
        // 如果插件本身设置了 perEnvironmentWatchChangeDuringDev，则触发该插件的钩子
        plugin.perEnvironmentWatchChangeDuringDev,
    )
  }

  /**
   * 用于关闭插件容器并触发相关插件钩子。
   * 它是 Vite 服务器关闭过程中的重要组成部分，确保所有插件能够正确清理资源并完成最后的操作。
   * @returns
   */
  async close(): Promise<void> {
    if (this._closed) return
    // 标记容器已关闭，防止后续操作继续执行
    this._closed = true
    // 等待所有正在处理的 Promise 完成，确保所有正在进行的操作能够正常结束
    await Promise.allSettled(Array.from(this._processesing))
    const config = this.environment.getTopLevelConfig()
    // 并行触发所有符合条件的插件的 buildEnd 钩子
    await this.hookParallel(
      'buildEnd', // 钩子名称：'buildEnd'
      (plugin) => this._getPluginContext(plugin), // 插件上下文获取函数
      () => [], // 钩子参数获取函数
      // 目的：控制哪些插件的 buildEnd 钩子会被触发，避免不必要的钩子调用
      (plugin) =>
        // 如果当前环境是 'client'，则触发所有插件的 buildEnd 钩子
        this.environment.name === 'client' ||
        // 果配置中启用了 perEnvironmentStartEndDuringDev，则触发所有插件的 buildEnd 钩子
        config.server.perEnvironmentStartEndDuringDev ||
        // 如果插件本身设置了 perEnvironmentStartEndDuringDev，则触发该插件的 buildEnd 钩子
        plugin.perEnvironmentStartEndDuringDev,
    )

    // 触发 closeBundle 钩子
    // 并行触发所有插件的 closeBundle 钩子
    await this.hookParallel(
      'closeBundle', // 钩子名称：'closeBundle'
      (plugin) => this._getPluginContext(plugin), // 插件上下文获取函数
      () => [], // 钩子参数获取函数
    )
  }
}

// 用于存储 Vite 及其核心依赖的版本信息，作为插件上下文元数据的基础部分。
export const basePluginContextMeta: {
  viteVersion: string
  rollupVersion: string
  rolldownVersion: string
} = {
  viteVersion, // Vite 版本号
  rollupVersion, // Rollup 版本号
  rolldownVersion, // Rollldown 版本号
}

export class BasicMinimalPluginContext<Meta = PluginContextMeta> {
  constructor(
    public meta: Meta,
    private _logger: Logger,
  ) {}

  // FIXME: properly support this later
  // eslint-disable-next-line @typescript-eslint/class-literal-property-style
  get pluginName(): string {
    return ''
  }

  debug(rawLog: string | RollupLog | (() => string | RollupLog)): void {
    const log = this._normalizeRawLog(rawLog)
    const msg = buildErrorMessage(log, [`debug: ${log.message}`], false)
    debugPluginContainerContext?.(msg)
  }

  info(rawLog: string | RollupLog | (() => string | RollupLog)): void {
    const log = this._normalizeRawLog(rawLog)
    const msg = buildErrorMessage(log, [`info: ${log.message}`], false)
    this._logger.info(msg, { clear: true, timestamp: true })
  }

  warn(rawLog: string | RollupLog | (() => string | RollupLog)): void {
    const log = this._normalizeRawLog(rawLog)
    const msg = buildErrorMessage(
      log,
      [colors.yellow(`warning: ${log.message}`)],
      false,
    )
    this._logger.warn(msg, { clear: true, timestamp: true })
  }

  error(e: string | RollupError): never {
    const err = (typeof e === 'string' ? new Error(e) : e) as RollupError
    throw err
  }

  private _normalizeRawLog(
    rawLog: string | RollupLog | (() => string | RollupLog),
  ): RollupLog {
    const logValue = typeof rawLog === 'function' ? rawLog() : rawLog
    return typeof logValue === 'string' ? new Error(logValue) : logValue
  }
}

class MinimalPluginContext<T extends Environment = Environment>
  extends BasicMinimalPluginContext
  implements RollupMinimalPluginContext
{
  public environment: T
  constructor(meta: PluginContextMeta, environment: T) {
    super(meta, environment.logger)
    // 环境实例
    this.environment = environment
  }
}

// fs 模块 promise 版本，用于在插件中异步操作文件
const fsModule: RollupFsModule = {
  appendFile: fsp.appendFile,
  copyFile: fsp.copyFile,
  mkdir: fsp.mkdir as RollupFsModule['mkdir'],
  mkdtemp: fsp.mkdtemp,
  readdir: fsp.readdir,
  readFile: fsp.readFile as RollupFsModule['readFile'],
  realpath: fsp.realpath,
  rename: fsp.rename,
  rmdir: fsp.rmdir,
  stat: fsp.stat,
  lstat: fsp.lstat,
  unlink: fsp.unlink,
  writeFile: fsp.writeFile,
}

/**
 * 插件上下文类
 */
class PluginContext
  extends MinimalPluginContext
  implements Omit<RollupPluginContext, 'cache'>
{
  ssr = false
  _scan = false
  _activeId: string | null = null
  _activeCode: string | null = null
  _resolveSkips?: Set<Plugin>
  _resolveSkipCalls?: readonly SkipInformation[]

  override get pluginName(): string {
    return this._plugin.name
  }

  constructor(
    public _plugin: Plugin, // 插件实例
    public _container: EnvironmentPluginContainer, // 环境容器实例
  ) {
    super(_container.minimalContext.meta, _container.environment)
  }

  fs: RollupFsModule = fsModule

  /**
   * 用于将 JavaScript 代码解析为抽象语法树（AST）
   * @param code 要解析的 JavaScript 代码字符串
   * @param opts 解析选项，用于配置解析行为
   * @returns
   */
  parse(code: string, opts: any): ESTree.Program {
    // 代码解析，生成符合 ESTree 规范的 AST
    return rolldownParseAst(code, opts)
  }

  /**
   * 用于解析模块 ID。
   * 它是 Vite 插件系统中模块解析的核心机制，允许插件参与模块解析过程，处理特殊的模块 ID 或路径。
   * @param id 要解析的模块 ID
   * @param importer 导入该模块的文件路径（可选）
   * @param options
   * @returns
   */
  async resolve(
    id: string,
    importer?: string,
    options?: {
      attributes?: Record<string, string> // 模块属性
      custom?: CustomPluginOptions // 自定义插件选项
      isEntry?: boolean // 是否为入口模块
      skipSelf?: boolean // 是否跳过当前插件
    },
  ): Promise<ResolvedId | null> {
    // 1、构建 skipCalls 数组
    let skipCalls: readonly SkipInformation[] | undefined

    if (options?.skipSelf === false) {
      skipCalls = this._resolveSkipCalls
    } else if (this._resolveSkipCalls) {
      // 创建副本 skipCallsTemp
      const skipCallsTemp = [...this._resolveSkipCalls]
      // 查找是否存在相同的调用记录
      const sameCallIndex = this._resolveSkipCalls.findIndex(
        (c) =>
          c.id === id && c.importer === importer && c.plugin === this._plugin,
      )
      if (sameCallIndex !== -1) {
        skipCallsTemp[sameCallIndex] = {
          ...skipCallsTemp[sameCallIndex],
          called: true, // 标记为已调用
        }
      } else {
        // 添加新的调用记录
        skipCallsTemp.push({ id, importer, plugin: this._plugin })
      }
      skipCalls = skipCallsTemp
    } else {
      skipCalls = [{ id, importer, plugin: this._plugin }]
    }

    // 调用容器的 resolveId 方法
    let out = await this._container.resolveId(id, importer, {
      attributes: options?.attributes,
      custom: options?.custom,
      isEntry: !!options?.isEntry,
      skip: this._resolveSkips,
      skipCalls,
      scan: this._scan,
    })
    if (typeof out === 'string') out = { id: out }
    return out as ResolvedId | null
  }

  /**
   * 用于加载并处理指定模块。
   * 它确保模块存在于模块图中，加载模块内容，执行转换，并返回完整的模块信息。
   * @param options
   * @returns
   */
  async load(
    options: {
      id: string // 要加载的模块 ID
      resolveDependencies?: boolean // 是否解析依赖
    } & Partial<PartialNull<ModuleOptions>>,
  ): Promise<ModuleInfo> {
    // We may not have added this to our module graph yet, so ensure it exists
    // 确保模块存在于模块图中
    await this._container.moduleGraph?.ensureEntryFromUrl(unwrapId(options.id))
    // Not all options passed to this function make sense in the context of loading individual files,
    // but we can at least update the module info properties we support
    // 更新模块信息
    this._updateModuleInfo(options.id, options)

    // 加载模块代码
    const loadResult = await this._container.load(options.id)
    const code = typeof loadResult === 'object' ? loadResult?.code : loadResult
    if (code != null) {
      // 对模块代码进行转换
      await this._container.transform(code, options.id)
    }

    // 获取模块信息
    const moduleInfo = this.getModuleInfo(options.id)
    // This shouldn't happen due to calling ensureEntryFromUrl, but 1) our types can't ensure that
    // and 2) moduleGraph may not have been provided (though in the situations where that happens,
    // we should never have plugins calling this.load)
    if (!moduleInfo) throw Error(`Failed to load module with id ${options.id}`)
    return moduleInfo
  }

  getModuleInfo(id: string): ModuleInfo | null {
    // 获取模块信息
    return this._container.getModuleInfo(id)
  }

  _updateModuleInfo(id: string, { meta }: { meta?: object | null }): void {
    if (meta) {
      const moduleInfo = this.getModuleInfo(id)
      if (moduleInfo) {
        moduleInfo.meta = { ...moduleInfo.meta, ...meta }
      }
    }
  }

  getModuleIds(): IterableIterator<string> {
    return this._container.moduleGraph
      ? // 如果模块图存在，返回所有模块 ID 的迭代器
        this._container.moduleGraph.idToModuleMap.keys()
      : Array.prototype[Symbol.iterator]()
  }

  addWatchFile(id: string): void {
    // 添加监听文件 ID 到容器的监听列表
    this._container.watchFiles.add(id)
    if (this._container.watcher)
      // 确保文件被监听
      ensureWatchedFile(
        this._container.watcher,
        id,
        this.environment.config.root,
      )
  }

  /**
   * 获取当前插件正在监听的文件 ID 列表
   * @returns 已添加到监听列表的文件 ID 列表
   */
  getWatchFiles(): string[] {
    return [...this._container.watchFiles]
  }

  // 警告：emitFile 方法在开发模式下不支持
  emitFile(_assetOrFile: EmittedFile): string {
    this._warnIncompatibleMethod(`emitFile`)
    return ''
  }

  // 警告：setAssetSource 方法在开发模式下不支持
  setAssetSource(): void {
    this._warnIncompatibleMethod(`setAssetSource`)
  }

  // 警告：getFileName 方法在开发模式下不支持
  getFileName(): string {
    this._warnIncompatibleMethod(`getFileName`)
    return ''
  }

  override debug(log: string | RollupLog | (() => string | RollupLog)): void {
    const err = this._formatLog(typeof log === 'function' ? log() : log)
    super.debug(err)
  }

  override info(log: string | RollupLog | (() => string | RollupLog)): void {
    const err = this._formatLog(typeof log === 'function' ? log() : log)
    super.info(err)
  }

  override warn(
    log: string | RollupLog | (() => string | RollupLog),
    position?: number | { column: number; line: number },
  ): void {
    const err = this._formatLog(
      typeof log === 'function' ? log() : log,
      position,
    )
    super.warn(err)
  }

  override error(
    e: string | RollupError,
    position?: number | { column: number; line: number },
  ): never {
    // error thrown here is caught by the transform middleware and passed on
    // the error middleware.
    throw this._formatLog(e, position)
  }

  private _formatLog<E extends RollupLog>(
    e: string | E,
    position?: number | { column: number; line: number } | undefined,
  ): E {
    const err = (typeof e === 'string' ? new Error(e) : e) as E
    if (err.pluginCode) {
      return err // The plugin likely called `this.error`
    }
    err.plugin = this._plugin.name
    if (this._activeId && !err.id) err.id = this._activeId
    if (this._activeCode) {
      err.pluginCode = this._activeCode

      // some rollup plugins, e.g. json, sets err.position instead of err.pos
      const pos = position ?? err.pos ?? (err as any).position

      if (pos != null) {
        let errLocation
        try {
          errLocation = numberToPos(this._activeCode, pos)
        } catch (err2) {
          this.environment.logger.error(
            colors.red(
              `Error in error handler:\n${err2.stack || err2.message}\n`,
            ),
            // print extra newline to separate the two errors
            { error: err2 },
          )
          throw err
        }
        err.loc = err.loc || {
          file: err.id,
          ...errLocation,
        }
        err.frame = err.frame || generateCodeFrame(this._activeCode, pos)
      } else if (err.loc) {
        // css preprocessors may report errors in an included file
        if (!err.frame) {
          let code = this._activeCode
          if (err.loc.file) {
            err.id = normalizePath(err.loc.file)
            try {
              code = fs.readFileSync(err.loc.file, 'utf-8')
            } catch {}
          }
          err.frame = generateCodeFrame(code, err.loc)
        }
      } else if ((err as any).line && (err as any).column) {
        err.loc = {
          file: err.id,
          line: (err as any).line,
          column: (err as any).column,
        }
        err.frame = err.frame || generateCodeFrame(this._activeCode, err.loc)
      }

      // TODO: move it to overrides
      if (
        this instanceof TransformPluginContext &&
        typeof err.loc?.line === 'number' &&
        typeof err.loc.column === 'number'
      ) {
        const rawSourceMap = this._getCombinedSourcemap()
        if (rawSourceMap && 'version' in rawSourceMap) {
          const traced = new TraceMap(rawSourceMap as any)
          const { source, line, column } = originalPositionFor(traced, {
            line: Number(err.loc.line),
            column: Number(err.loc.column),
          })
          if (source) {
            err.loc = { file: source, line, column }
          }
        }
      }
    } else if (err.loc) {
      if (!err.frame) {
        let code = err.pluginCode
        if (err.loc.file) {
          err.id = normalizePath(err.loc.file)
          if (!code) {
            try {
              code = fs.readFileSync(err.loc.file, 'utf-8')
            } catch {}
          }
        }
        if (code) {
          err.frame = generateCodeFrame(`${code}`, err.loc)
        }
      }
    }

    if (
      typeof err.loc?.column !== 'number' &&
      typeof err.loc?.line !== 'number' &&
      !err.loc?.file
    ) {
      delete err.loc
    }

    return err
  }

  /**
   * 警告插件使用不兼容的上下文方法
   * @param method 警告的上下文方法名
   */
  _warnIncompatibleMethod(method: string): void {
    this.environment.logger.warn(
      colors.cyan(`[plugin:${this._plugin.name}] `) +
        colors.yellow(
          `context method ${colors.bold(
            `${method}()`,
          )} is not supported in serve mode. This plugin is likely not vite-compatible.`,
        ),
    )
  }
}

/**
 * 用于创建一个专门用于模块解析过程的上下文对象
 */
class ResolveIdContext extends PluginContext {
  constructor(
    // 插件容器实例，提供插件系统的核心功能
    container: EnvironmentPluginContainer,
    // 要跳过的插件集合，用于避免某些插件参与解析过程
    skip: Set<Plugin> | undefined,
    // 要跳过的调用信息数组，用于避免循环调用
    skipCalls: readonly SkipInformation[] | undefined,
    // 是否为扫描模式，用于控制解析过程的行为
    scan: boolean,
  ) {
    super(null!, container)
    this._resolveSkips = skip
    this._resolveSkipCalls = skipCalls
    this._scan = scan
  }
}

/**
 * 创建一个专门用于插件 load 钩子的上下文对象。
 */
class LoadPluginContext extends PluginContext {
  _addedImports: Set<string> | null = null

  constructor(container: EnvironmentPluginContainer) {
    super(null!, container)
  }
  /**
   * 一个重写方法，用于在添加文件到监视列表的同时，将文件路径添加到 _addedImports 集合中
   * @param id  要添加到监视列表的文件路径
   */
  override addWatchFile(id: string): void {
    if (!this._addedImports) {
      this._addedImports = new Set()
    }
    this._addedImports.add(id)
    // 确保文件被添加到 Vite 的文件监视列表中，以便在文件变化时触发相应的更新
    super.addWatchFile(id)
  }
}

/**
 *
 */
class TransformPluginContext
  extends LoadPluginContext
  implements Omit<RollupTransformPluginContext, 'cache'>
{
  filename: string
  originalCode: string
  originalSourcemap: SourceMap | null = null
  sourcemapChain: NonNullable<SourceDescription['map']>[] = []
  combinedMap: SourceMap | { mappings: '' } | null = null

  constructor(
    container: EnvironmentPluginContainer,
    id: string,
    code: string,
    inMap?: SourceMap | string,
  ) {
    super(container)

    this.filename = id
    this.originalCode = code
    if (inMap) {
      if (debugSourcemapCombine) {
        // @ts-expect-error inject name for debug purpose
        inMap.name = '$inMap'
      }
      this.sourcemapChain.push(inMap)
    }
  }

  _getCombinedSourcemap(): SourceMap | { mappings: '' } | null {
    if (
      debugSourcemapCombine &&
      debugSourcemapCombineFilter &&
      this.filename.includes(debugSourcemapCombineFilter)
    ) {
      debugSourcemapCombine('----------', this.filename)
      debugSourcemapCombine(this.combinedMap)
      debugSourcemapCombine(this.sourcemapChain)
      debugSourcemapCombine('----------')
    }

    let combinedMap = this.combinedMap
    // { mappings: '' }
    if (
      combinedMap &&
      !('version' in combinedMap) &&
      combinedMap.mappings === ''
    ) {
      this.sourcemapChain.length = 0
      return combinedMap
    }

    for (let m of this.sourcemapChain) {
      if (typeof m === 'string') m = JSON.parse(m)
      if (!('version' in (m as SourceMap))) {
        // { mappings: '' }
        if ((m as SourceMap).mappings === '') {
          combinedMap = { mappings: '' }
          break
        }
        // empty, nullified source map
        combinedMap = null
        break
      }
      if (!combinedMap) {
        const sm = m as SourceMap
        // sourcemap should not include `sources: [null]` (because `sources` should be string) nor
        // `sources: ['']` (because `''` means the path of sourcemap)
        // but MagicString generates this when `filename` option is not set.
        // Rollup supports these and therefore we support this as well
        if (sm.sources.length === 1 && !sm.sources[0]) {
          combinedMap = {
            ...sm,
            sources: [this.filename],
            sourcesContent: [this.originalCode],
          }
        } else {
          combinedMap = sm
        }
      } else {
        combinedMap = combineSourcemaps(cleanUrl(this.filename), [
          m as RawSourceMap,
          combinedMap as RawSourceMap,
        ]) as SourceMap
      }
    }
    if (combinedMap !== this.combinedMap) {
      this.combinedMap = combinedMap
      this.sourcemapChain.length = 0
    }
    return this.combinedMap
  }

  getCombinedSourcemap(): SourceMap {
    const map = this._getCombinedSourcemap()
    if (!map || (!('version' in map) && map.mappings === '')) {
      return new MagicString(this.originalCode).generateMap({
        includeContent: true,
        hires: 'boundary',
        source: cleanUrl(this.filename),
      }) as SourceMap
    }
    return map
  }

  _updateActiveInfo(plugin: Plugin, id: string, code: string): void {
    this._plugin = plugin
    this._activeId = id
    this._activeCode = code
  }
}

export type {
  EnvironmentPluginContainer,
  TransformPluginContext,
  TransformResult,
}

// Backward compatibility
/**
 * 插件容器
 */
class PluginContainer {
  // 接收一个环境映射对象并将其存储为私有属性 environments
  constructor(private environments: Record<string, Environment>) {}

  // Backward compatibility
  // Users should call pluginContainer.resolveId (and load/transform) passing the environment they want to work with
  // But there is code that is going to call it without passing an environment, or with the ssr flag to get the ssr environment
  private _getEnvironment(options?: {
    ssr?: boolean
    environment?: Environment
  }) {
    return options?.environment
      ? options.environment
      : this.environments[options?.ssr ? 'ssr' : 'client']
  }

  private _getPluginContainer(options?: {
    ssr?: boolean
    environment?: Environment
  }) {
    // 调用容器的 pluginContainer 属性
    return (this._getEnvironment(options) as DevEnvironment).pluginContainer
  }

  getModuleInfo(id: string): ModuleInfo | null {
    // 调用容器的 getModuleInfo 方法
    const clientModuleInfo = (
      this.environments.client as DevEnvironment
    ).pluginContainer.getModuleInfo(id)
    // 调用容器的 getModuleInfo 方法
    const ssrModuleInfo = (
      this.environments.ssr as DevEnvironment
    ).pluginContainer.getModuleInfo(id)

    if (clientModuleInfo == null && ssrModuleInfo == null) return null

    // 建一个代理对象，用于合并两个环境的模块信息
    return new Proxy({} as any, {
      get: (_, key: string) => {
        // `meta` refers to `ModuleInfo.meta` of both environments, so we also
        // need to merge it here
        if (key === 'meta') {
          const meta: Record<string, any> = {}
          // 先合并 SSR 环境的 meta 信息
          if (ssrModuleInfo) {
            Object.assign(meta, ssrModuleInfo.meta)
          }
          // 再合并客户端环境的 meta 信息（客户端优先）
          if (clientModuleInfo) {
            Object.assign(meta, clientModuleInfo.meta)
          }
          return meta
        }
        if (clientModuleInfo) {
          // 优先检查客户端环境的模块信息是否包含该属性
          if (key in clientModuleInfo) {
            return clientModuleInfo[key as keyof ModuleInfo]
          }
        }
        if (ssrModuleInfo) {
          // 检查 SSR 环境的模块信息是否包含该属性
          if (key in ssrModuleInfo) {
            return ssrModuleInfo[key as keyof ModuleInfo]
          }
        }
      },
    })
  }

  get options(): InputOptions {
    // 调用容器的 options 属性
    return (this.environments.client as DevEnvironment).pluginContainer.options
  }

  // For backward compatibility, buildStart and watchChange are called only for the client environment
  // buildStart is called per environment for a plugin with the perEnvironmentStartEndDuringDev flag
  // watchChange is called per environment for a plugin with the perEnvironmentWatchChangeDuringDev flag

  async buildStart(_options?: InputOptions): Promise<void> {
    // 调用容器的 buildStart 方法
    return (
      this.environments.client as DevEnvironment
    ).pluginContainer.buildStart(_options)
  }

  async watchChange(
    id: string,
    change: { event: 'create' | 'update' | 'delete' },
  ): Promise<void> {
    // 调用容器的 watchChange 方法
    return (
      this.environments.client as DevEnvironment
    ).pluginContainer.watchChange(id, change)
  }

  /**
   * 用于解析模块 ID。
   * 它是 Vite 插件系统中模块解析的核心机制，允许插件参与模块解析过程，处理特殊的模块 ID 或路径。
   * @param rawId  要解析的模块 ID
   * @param importer 导入该模块的文件路径（可选）
   * @param options
   * @returns
   */
  async resolveId(
    rawId: string,
    importer?: string,
    options?: {
      attributes?: Record<string, string> // 模块属性
      custom?: CustomPluginOptions // 自定义插件选项
      /** @deprecated use `skipCalls` instead */
      skip?: Set<Plugin>
      skipCalls?: readonly SkipInformation[]
      ssr?: boolean
      /**
       * @internal
       */
      scan?: boolean
      isEntry?: boolean // 是否为入口模块
    },
  ): Promise<PartialResolvedId | null> {
    // 调用容器的 resolveId 方法
    return this._getPluginContainer(options).resolveId(rawId, importer, options)
  }

  async load(
    id: string,
    options?: {
      ssr?: boolean
    },
  ): Promise<LoadResult | null> {
    // 调用容器的 load 方法
    return this._getPluginContainer(options).load(id)
  }

  async transform(
    code: string,
    id: string,
    options?: {
      ssr?: boolean
      environment?: Environment
      inMap?: SourceDescription['map']
    },
  ): Promise<{ code: string; map: SourceMap | { mappings: '' } | null }> {
    // 调用容器的 transform 方法
    return this._getPluginContainer(options).transform(code, id, options)
  }

  async close(): Promise<void> {
    // noop, close will be called for each environment
  }
}

/**
 * server.pluginContainer compatibility
 *
 * The default environment is in buildStart, buildEnd, watchChange, and closeBundle hooks,
 * which are called once for all environments, or when no environment is passed in other hooks.
 * The ssrEnvironment is needed for backward compatibility when the ssr flag is passed without
 * an environment. The defaultEnvironment in the main pluginContainer in the server should be
 * the client environment for backward compatibility.
 **/
export function createPluginContainer(
  environments: Record<string, Environment>,
): PluginContainer {
  return new PluginContainer(environments)
}

export type { PluginContainer }
