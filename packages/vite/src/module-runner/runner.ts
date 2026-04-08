import type { ViteHotContext } from '#types/hot'
import { HMRClient, HMRContext, type HMRLogger } from '../shared/hmr'
import { cleanUrl, isPrimitive } from '../shared/utils'
import { analyzeImportedModDifference } from '../shared/ssrTransform'
import {
  type NormalizedModuleRunnerTransport,
  normalizeModuleRunnerTransport,
} from '../shared/moduleRunnerTransport'
import { createIsBuiltin } from '../shared/builtin'
import type { EvaluatedModuleNode } from './evaluatedModules'
import { EvaluatedModules } from './evaluatedModules'
import type {
  ModuleEvaluator,
  ModuleRunnerContext,
  ModuleRunnerOptions,
  ResolvedResult,
  SSRImportMetadata,
} from './types'
import { posixDirname, posixPathToFileHref, posixResolve } from './utils'
import {
  ssrDynamicImportKey,
  ssrExportAllKey,
  ssrExportNameKey,
  ssrImportKey,
  ssrImportMetaKey,
  ssrModuleExportsKey,
} from './constants'
import { hmrLogger, silentConsole } from './hmrLogger'
import { createHMRHandlerForRunner } from './hmrHandler'
import { enableSourceMapSupport } from './sourcemap/index'
import { ESModulesEvaluator } from './esmEvaluator'
import { createDefaultImportMeta } from './createImportMeta'

interface ModuleRunnerDebugger {
  (formatter: unknown, ...args: unknown[]): void
}

export class ModuleRunner {
  public evaluatedModules: EvaluatedModules
  public hmrClient?: HMRClient

  private readonly transport: NormalizedModuleRunnerTransport
  private readonly resetSourceMapSupport?: () => void

  // 用于存储正在进行的模块节点解析 Promise
  // 当同一个 URL 被多个 import 同时调用时，第一个调用会创建一个 Promise 并存入 Map，后续调用直接返回这个 Promise，避免重复向服务器请求元数据
  // 确保同一时间对同一个 URL 的请求只被处理一次，避免并发请求导致的重复工作和竞态条件
  private readonly concurrentModuleNodePromises = new Map<
    string, // 模块 URL
    Promise<EvaluatedModuleNode> // 处理该 URL 的 Promise
  >()
  private isBuiltin?: (id: string) => boolean
  private builtinsPromise?: Promise<void>

  private closed = false

  constructor(
    public options: ModuleRunnerOptions, // 模块运行器配置选项
    public evaluator: ModuleEvaluator = new ESModulesEvaluator(), // 模块评估器
    private debug?: ModuleRunnerDebugger | undefined, // 调试器，可选
  ) {
    // 模块存储初始化
    this.evaluatedModules = options.evaluatedModules ?? new EvaluatedModules()

    // 传输系统初始化
    this.transport = normalizeModuleRunnerTransport(options.transport)

    // HMR 配置
    // 未禁用
    if (options.hmr !== false) {
      const optionsHmr = options.hmr ?? true
      // 确定 HMR 日志记录器
      const resolvedHmrLogger: HMRLogger =
        optionsHmr === true || optionsHmr.logger === undefined
          ? hmrLogger
          : optionsHmr.logger === false
            ? silentConsole
            : optionsHmr.logger

      // 创建 HMRClient 实例
      this.hmrClient = new HMRClient(
        resolvedHmrLogger,
        this.transport, // 传输系统
        ({ acceptedPath }) => this.import(acceptedPath), // 模块重新导入函数
      )
      // 抛出错误，提示传输系统不支持 HMR
      if (!this.transport.connect) {
        throw new Error(
          'HMR is not supported by this runner transport, but `hmr` option was set to true',
        )
      }
      // 连接传输并创建 HMR 处理器
      this.transport.connect(createHMRHandlerForRunner(this))
    } else {
      // 禁用 HMR，直接连接传输系统
      this.transport.connect?.()
    }

    // 启用源码映射支持
    if (options.sourcemapInterceptor !== false) {
      this.resetSourceMapSupport = enableSourceMapSupport(this)
    }
  }

  /**
   * URL to execute. Accepts file path, server path or id relative to the root.
   * 用于通过 URL 动态导入模块。
   * 它利用缓存机制提高性能，返回模块的导出对象，并支持泛型类型以增强类型安全性。
   */
  public async import<T = any>(url: string): Promise<T> {
    // 根据 URL 获取或创建一个 EvaluatedModuleNode（模块节点）
    const fetchedModule = await this.cachedModule(url)
    // 真正请求模块的转换后代码并执行，返回模块的导出对象
    return await this.cachedRequest(url, fetchedModule)
  }

  /**
   * Clear all caches including HMR listeners.
   */
  public clearCache(): void {
    this.evaluatedModules.clear()
    this.hmrClient?.clear()
  }

  /**
   * Clears all caches, removes all HMR listeners, and resets source map support.
   * This method doesn't stop the HMR connection.
   */
  public async close(): Promise<void> {
    this.resetSourceMapSupport?.()
    this.clearCache()
    this.hmrClient = undefined
    this.closed = true
    await this.transport.disconnect?.()
  }

  /**
   * Returns `true` if the runtime has been closed by calling `close()` method.
   */
  public isClosed(): boolean {
    return this.closed
  }

  /**
   * 用于处理模块导入结果，特别是针对外部化的 ESM 和 CommonJS 模块。
   * 它通过分析导入模块的差异，确保模块在不同模块系统间的兼容性，是模块运行器中处理模块导入的重要环节。
   * @param exports
   * @param fetchResult
   * @param metadata
   * @returns
   */
  private processImport(
    exports: Record<string, any>,
    fetchResult: ResolvedResult,
    metadata?: SSRImportMetadata,
  ) {
    // 如果不是外部化模块，直接返回 exports，不需要特殊处理
    if (!('externalize' in fetchResult)) {
      return exports
    }
    const { url, type } = fetchResult

    // 如果不是 ESM 或 CommonJS 模块，直接返回导出对象
    if (type !== 'module' && type !== 'commonjs') return exports

    // 分析导入模块的差异
    analyzeImportedModDifference(exports, url, type, metadata)
    return exports
  }

  private isCircularModule(mod: EvaluatedModuleNode) {
    for (const importedFile of mod.imports) {
      if (mod.importers.has(importedFile)) {
        return true
      }
    }
    return false
  }

  private isCircularImport(
    importers: Set<string>,
    moduleUrl: string,
    visited = new Set<string>(),
  ) {
    for (const importer of importers) {
      if (visited.has(importer)) {
        continue
      }
      visited.add(importer)
      if (importer === moduleUrl) {
        return true
      }
      const mod = this.evaluatedModules.getModuleById(importer)
      if (
        mod &&
        mod.importers.size &&
        this.isCircularImport(mod.importers, moduleUrl, visited)
      ) {
        return true
      }
    }
    return false
  }

  /**
   * 用于缓存和处理模块的请求。
   * 它负责模块的加载、执行和循环依赖检测，是模块运行器中处理模块请求的核心方法。
   * @param url
   * @param mod
   * @param callstack
   * @param metadata
   * @returns
   */
  private async cachedRequest(
    url: string,
    mod: EvaluatedModuleNode,
    callstack: string[] = [],
    metadata?: SSRImportMetadata,
  ): Promise<any> {
    // 获取模块元数据
    const meta = mod.meta!
    // 获取模块 ID
    const moduleId = meta.id
    // 获取模块的导入者集合
    const { importers } = mod

    // 取当前调用栈中的上一个模块
    const importee = callstack[callstack.length - 1]

    // 如果存在上一个模块，将其添加到当前模块的导入者集合
    if (importee) importers.add(importee)

    // fast path: already evaluated modules can't deadlock
    // 检查模块是否已评估且有 Promise
    if (mod.evaluated && mod.promise) {
      // 等待 Promise 完成并处理导入
      return this.processImport(await mod.promise, meta, metadata)
    }

    // check circular dependency (only for modules still being evaluated)
    // 循环依赖检测
    if (
      callstack.includes(moduleId) || // 当前模块 ID 是否在调用栈中
      this.isCircularModule(mod) || // 当前模块是否为循环模块
      this.isCircularImport(importers, moduleId) // 导入者集合中是否存在循环导入
    ) {
      // 如果检测到循环依赖且模块已有导出，直接返回导出
      if (mod.exports) return this.processImport(mod.exports, meta, metadata)
    }

    let debugTimer: any
    if (this.debug) {
      debugTimer = setTimeout(() => {
        const getStack = () =>
          `stack:\n${[...callstack, moduleId]
            .reverse()
            .map((p) => `  - ${p}`)
            .join('\n')}`

        this.debug!(
          `[module runner] module ${moduleId} takes over 2s to load.\n${getStack()}`,
        )
      }, 2000)
    }

    try {
      // cached module (in-progress, not yet evaluated)
      // 检查模块是否已有 Promise（正在处理中）
      if (mod.promise)
        // 等待 Promise 完成并处理导入
        return this.processImport(await mod.promise, meta, metadata)

      // 创建新的请求
      const promise = this.directRequest(url, mod, callstack)
      // 设置模块的 Promise 和评估状态
      mod.promise = promise
      mod.evaluated = false
      // 等待请求完成并处理导入
      return this.processImport(await promise, meta, metadata)
    } finally {
      mod.evaluated = true
      if (debugTimer) clearTimeout(debugTimer)
    }
  }

  /**
   * 为给定的 URL 获取或创建一个模块节点（EvaluatedModuleNode），并确保多个并发请求不会重复创建
   * @param importer
   * @returns
   */
  private async cachedModule(
    url: string,
    importer?: string,
  ): Promise<EvaluatedModuleNode> {
    // 获取指定 URL 的缓存模块信息
    let cached = this.concurrentModuleNodePromises.get(url)

    // 如果缓存中没有模块信息
    if (!cached) {
      // 获取已评估的模块
      const cachedModule = this.evaluatedModules.getModuleByUrl(url)
      // 取模块信息
      cached = this.getModuleInformation(url, importer, cachedModule).finally(
        () => {
          // 从 "正在处理" 状态中移除，避免积累大量已完成的 Promise
          this.concurrentModuleNodePromises.delete(url)
        },
      )
      // 缓存模块信息
      this.concurrentModuleNodePromises.set(url, cached)
    } else {
      this.debug?.('[module runner] using cached module info for', url)
    }

    // 返回缓存模块信息
    return cached
  }

  private ensureBuiltins(): Promise<void> | undefined {
    if (this.isBuiltin) return

    this.builtinsPromise ??= (async () => {
      try {
        this.debug?.('[module runner] fetching builtins from server')
        const serializedBuiltins = await this.transport.invoke(
          'getBuiltins',
          [],
        )
        const builtins = serializedBuiltins.map((builtin) =>
          typeof builtin === 'object' && builtin && 'type' in builtin
            ? builtin.type === 'string'
              ? builtin.value
              : new RegExp(builtin.source, builtin.flags)
            : // NOTE: Vitest returns raw values instead of serialized ones
              builtin,
        )
        this.isBuiltin = createIsBuiltin(builtins)
        this.debug?.('[module runner] builtins loaded:', builtins)
      } finally {
        this.builtinsPromise = undefined
      }
    })()

    return this.builtinsPromise
  }

  /**
   * 负责获取模块元数据
   * 过 RPC 调用 Vite 服务器，获取模块的解析结果（ID、URL、类型等），并同步到本地的 EvaluatedModules 缓存中
   * @param url
   * @param importer
   * @param cachedModule
   * @returns
   */
  private async getModuleInformation(
    url: string,
    importer: string | undefined,
    cachedModule: EvaluatedModuleNode | undefined,
  ): Promise<EvaluatedModuleNode> {
    // 状态判断：如果模块运行器已被关闭，抛出错误
    if (this.closed) {
      throw new Error(`Vite module runner has been closed.`)
    }

    // 确保内置模块已加载
    // 原因：在处理模块信息时，需要访问内置模块的元数据，而这些元数据在模块运行器启动时加载。
    await this.ensureBuiltins()

    this.debug?.('[module runner] fetching', url)

    // 缓存检查
    const isCached = !!(typeof cachedModule === 'object' && cachedModule.meta)

    // 获取模块信息：优先处理 data: 或内置模块，否则远程调用
    const fetchedModule = // fast return for established externalized pattern
      // 1、data: URL 或者 内置模块
      (
        url.startsWith('data:') || this.isBuiltin?.(url)
          ? // 直接创建外部化模块
            { externalize: url, type: 'builtin' }
          : // 2、其他情况：从远程获取模块信息
            await this.transport.invoke('fetchModule', [
              url,
              importer,
              {
                cached: isCached,
                startOffset: this.evaluator.startOffset,
              },
            ])
      ) as ResolvedResult

    // 如果返回的是 { cache: true } 表示服务端确认缓存有效，直接返回 cachedModule
    if ('cache' in fetchedModule) {
      if (!cachedModule || !cachedModule.meta) {
        throw new Error(
          `Module "${url}" was mistakenly invalidated during fetch phase.`,
        )
      }
      return cachedModule
    }

    // 确定模块 ID
    const moduleId =
      'externalize' in fetchedModule
        ? fetchedModule.externalize
        : fetchedModule.id
    // 确定模块 URL
    const moduleUrl = 'url' in fetchedModule ? fetchedModule.url : url

    // 确保模块节点存在（从缓存中获取或创建）
    const module = this.evaluatedModules.ensureModule(moduleId, moduleUrl)

    // 如果需要失效（如服务端检测到模块已过时），标记失效
    if ('invalidate' in fetchedModule && fetchedModule.invalidate) {
      this.evaluatedModules.invalidateModule(module)
    }

    // 将获取到的元数据附加到模块节点
    fetchedModule.url = moduleUrl
    fetchedModule.id = moduleId
    module.meta = fetchedModule

    return module
  }

  // override is allowed, consider this a public API
  /**
   * 用于直接处理模块请求。
   * 它是模块运行器中执行模块代码的核心方法，负责处理模块的加载、执行、依赖管理和热模块替换（HMR）支持。
   * @param url
   * @param mod
   * @param _callstack
   * @returns
   */
  protected async directRequest(
    url: string,
    mod: EvaluatedModuleNode,
    _callstack: string[],
  ): Promise<any> {
    // 模块元数据
    const fetchResult = mod.meta!
    // 模块 ID
    const moduleId = fetchResult.id
    // 调用栈
    const callstack = [..._callstack, moduleId]

    // 请求函数创建，仅处理模块的静态导入
    const request = async (dep: string, metadata?: SSRImportMetadata) => {
      // 确定导入者
      const importer = ('file' in fetchResult && fetchResult.file) || moduleId
      // 获取依赖
      const depMod = await this.cachedModule(dep, importer)
      // 记录依赖导入者
      depMod.importers.add(moduleId)
      mod.imports.add(depMod.id)

      // 依赖请求
      return this.cachedRequest(dep, depMod, callstack, metadata)
    }

    // 请求函数创建，处理动态导入的模块
    const dynamicRequest = async (dep: string) => {
      // it's possible to provide an object with toString() method inside import()
      dep = String(dep)
      if (dep[0] === '.') {
        dep = posixResolve(posixDirname(url), dep)
      }
      return request(dep, { isDynamicImport: true })
    }

    // 外部模块处理
    if ('externalize' in fetchResult) {
      const { externalize } = fetchResult
      this.debug?.('[module runner] externalizing', externalize)
      const exports = await this.evaluator.runExternalModule(externalize)
      mod.exports = exports
      return exports
    }

    const { code, file } = fetchResult

    if (code == null) {
      const importer = callstack[callstack.length - 2]
      throw new Error(
        `[module runner] Failed to load "${url}"${
          importer ? ` imported from ${importer}` : ''
        }`,
      )
    }

    const createImportMeta =
      this.options.createImportMeta ?? createDefaultImportMeta

    const modulePath = cleanUrl(file || moduleId)
    // disambiguate the `<UNIT>:/` on windows: see nodejs/node#31710
    const href = posixPathToFileHref(modulePath)
    const meta = await createImportMeta(modulePath)
    const exports = Object.create(null)

    // 添加 Symbol.toStringTag 属性，标记为模块对象
    Object.defineProperty(exports, Symbol.toStringTag, {
      value: 'Module',
      enumerable: false,
      configurable: false,
    })

    // 储导出：mod.exports = exports
    mod.exports = exports

    let hotContext: ViteHotContext | undefined
    if (this.hmrClient) {
      // 添加 hot 属性，用于 HMR 上下文管理
      Object.defineProperty(meta, 'hot', {
        enumerable: true,
        get: () => {
          if (!this.hmrClient) {
            throw new Error(`[module runner] HMR client was closed.`)
          }
          this.debug?.('[module runner] creating hmr context for', mod.url)
          hotContext ||= new HMRContext(this.hmrClient, mod.url)
          return hotContext
        },
        set: (value) => {
          hotContext = value
        },
      })
    }

    // 模块运行器上下文创建
    const context: ModuleRunnerContext = {
      [ssrImportKey]: request, // 静态导入函数
      [ssrDynamicImportKey]: dynamicRequest, // 动态导入函数
      [ssrModuleExportsKey]: exports, // 模块导出对象
      // 导出所有对象
      [ssrExportAllKey]: (obj: any) => exportAll(exports, obj),
      // 命名导出函数
      [ssrExportNameKey]: (name, getter) =>
        Object.defineProperty(exports, name, {
          enumerable: true,
          configurable: true,
          get: getter,
        }),
      // 导入元数据
      [ssrImportMetaKey]: meta,
    }

    this.debug?.('[module runner] executing', href)

    // 执行模块代码
    await this.evaluator.runInlinedModule(context, code, mod)

    return exports
  }
}

function exportAll(exports: any, sourceModule: any) {
  // when a module exports itself it causes
  // call stack error
  if (exports === sourceModule) return

  if (
    isPrimitive(sourceModule) ||
    Array.isArray(sourceModule) ||
    sourceModule instanceof Promise
  )
    return

  for (const key in sourceModule) {
    if (key !== 'default' && key !== '__esModule' && !(key in exports)) {
      try {
        Object.defineProperty(exports, key, {
          enumerable: true,
          configurable: true,
          get: () => sourceModule[key],
        })
      } catch {}
    }
  }
}
