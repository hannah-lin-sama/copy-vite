import { extname } from 'node:path'
import type { ModuleInfo, PartialResolvedId } from 'rolldown'
import { isDirectCSSRequest } from '../plugins/css'
import {
  monotonicDateNow,
  normalizePath,
  removeImportQuery,
  removeTimestampQuery,
} from '../utils'
import { FS_PREFIX } from '../constants'
import { cleanUrl } from '../../shared/utils'
import type { TransformResult } from './transformRequest'

/**
 * 表示一个模块节点，记录模块的元信息、依赖关系、热更新（HMR）状态以及转换结果
 */
export class EnvironmentModuleNode {
  // 字符串类型，表示模块所属的环境（如 'client' 或 'server'）
  environment: string
  /**
   * Public served url path, starts with /
   * 模块的公共访问路径（以 / 开头）
   */
  url: string
  /**
   * Resolved file system path + query
   * 表示模块的唯一 ID（可能与 URL 不同）
   */
  id: string | null = null
  // 表示模块对应的文件路径
  file: string | null = null
  // 表示模块类型
  type: 'js' | 'css' | 'asset'
  // 模块额外元数据（如 lastModified、importers 等，由插件填充）
  info?: ModuleInfo
  // 存储模块的元数据
  meta?: Record<string, any>

  // 依赖当前模块的模块节点（即导入该模块的模块）
  importers: Set<EnvironmentModuleNode> = new Set()

  // 当前模块直接导入的模块节点
  importedModules: Set<EnvironmentModuleNode> = new Set()

  // 该模块通过 import.meta.hot.accept 接受的依赖模块（用于 HMR）
  acceptedHmrDeps: Set<EnvironmentModuleNode> = new Set()
  // 通过 import.meta.hot.acceptExports 接受的导出名称集合
  acceptedHmrExports: Set<string> | null = null

  // 记录从每个导入模块中具体导入了哪些绑定
  importedBindings: Map<string, Set<string>> | null = null
  // 表示模块是否自接受热更新
  isSelfAccepting?: boolean
  // 存储模块的转换结果
  transformResult: TransformResult | null = null

  // ssrModule and ssrError are no longer needed. They are on the module runner module cache.
  // Once `ssrLoadModule` is re-implemented on top of the new APIs, we can delete these.
  // 存储模块的 SSR 模块对象
  ssrModule: Record<string, any> | null = null
  // 存储模块的 SSR 错误
  ssrError: Error | null = null

  // 表示模块最后一次热更新的时间戳
  lastHMRTimestamp = 0
  /**
   * `import.meta.hot.invalidate` is called by the client.
   * If there's multiple clients, multiple `invalidate` request is received.
   * This property is used to dedupe those request to avoid multiple updates happening.
   * @internal
   */
  lastHMRInvalidationReceived = false
  lastInvalidationTimestamp = 0
  /**
   * If the module only needs to update its imports timestamp (e.g. within an HMR chain),
   * it is considered soft-invalidated. In this state, its `transformResult` should exist,
   * and the next `transformRequest` for this module will replace the timestamps.
   *
   * By default the value is `undefined` if it's not soft/hard-invalidated. If it gets
   * soft-invalidated, this will contain the previous `transformResult` value. If it gets
   * hard-invalidated, this will be set to `'HARD_INVALIDATED'`.
   * @internal
   */
  invalidationState: TransformResult | 'HARD_INVALIDATED' | undefined
  /**
   * The module urls that are statically imported in the code. This information is separated
   * out from `importedModules` as only importers that statically import the module can be
   * soft invalidated. Other imports (e.g. watched files) needs the importer to be hard invalidated.
   * @internal
   */
  staticImportedUrls?: Set<string>

  /**
   * 用于创建和初始化模块节点，设置模块的基本属性，包括环境、URL、类型和热更新自接受状
   * @param setIsSelfAccepting - set `false` to set `isSelfAccepting` later. e.g. #7870
   * url：字符串类型，表示模块的 URL 路径
   * environment：字符串类型，表示模块所属环境的类型 client 或 server
   * @param setIsSelfAccepting - 是否设置模块为自接受状态，默认值为 true
   */
  constructor(url: string, environment: string, setIsSelfAccepting = true) {
    this.environment = environment
    this.url = url
    // 检查 URL 是否指向直接的 CSS 请求
    this.type = isDirectCSSRequest(url) ? 'css' : 'js'
    if (setIsSelfAccepting) {
      // isSelfAccepting 表示模块是否自接受热更新，默认值为 false
      // 需要在后续的模块分析中根据实际代码更新
      this.isSelfAccepting = false
    }
  }
}

export type ResolvedUrl = [
  url: string,
  resolvedId: string,
  meta: object | null | undefined,
]

/**
 *  Vite 模块图（Module Graph）的环境专属实现，
 * 负责管理某个特定环境（如 client 或 ssr）下所有模块节点的索引、查找和依赖解析
 */
export class EnvironmentModuleGraph {
  // 模块图所属的环境名称（如 'client' 或 'server'）
  environment: string

  // 以模块的 URL（例如 /src/main.js）为键，存储模块节点
  urlToModuleMap: Map<string, EnvironmentModuleNode> = new Map()
  // 以模块的 ID（可能不同于 URL，例如带查询参数的虚拟模块 \0virtual）为键存储模块节点
  idToModuleMap: Map<string, EnvironmentModuleNode> = new Map()
  // 以模块转换结果的 ETag 为键存储模块节点，用于 HTTP 协商缓存（If-None-Match）
  etagToModuleMap: Map<string, EnvironmentModuleNode> = new Map()
  // a single file may corresponds to multiple modules with different queries
  // 以磁盘文件绝对路径为键，存储该文件对应的所有模块节点。一个文件可能对应多个模块
  fileToModulesMap: Map<string, Set<EnvironmentModuleNode>> = new Map()

  /**
   * @internal
   * 内部映射，用于处理正在解析中的模块请求。
   * 当多个请求同时解析同一个 URL 时，避免重复调用 _resolveId。
   * 键为 URL，值为已存在的模块节点或一个 Promise。
   */
  _unresolvedUrlToModuleMap: Map<
    string,
    EnvironmentModuleNode | Promise<EnvironmentModuleNode>
  > = new Map()

  /**
   * @internal
   * 异步函数，将给定的 URL（或标识符）解析为最终的 PartialResolvedId
   */
  _resolveId: (url: string) => Promise<PartialResolvedId | null>

  /** @internal 记录解析失败的模块节点，用于错误报告或后续重试 */
  _hasResolveFailedErrorModules: Set<EnvironmentModuleNode> = new Set()

  constructor(
    environment: string,
    resolveId: (url: string) => Promise<PartialResolvedId | null>,
  ) {
    this.environment = environment
    this._resolveId = resolveId
  }

  /**
   * 根据 URL 获取对应的模块节点
   * @param rawUrl
   * @returns
   */
  async getModuleByUrl(
    rawUrl: string,
  ): Promise<EnvironmentModuleNode | undefined> {
    // Quick path, if we already have a module for this rawUrl (even without extension)

    // 移除导入查询参数和时间戳
    rawUrl = removeImportQuery(removeTimestampQuery(rawUrl))
    // 1、快速路径查找
    // 直接通过清理后的原始 URL 查找模块
    // 这种方式支持无扩展名的 URL 查找，提高性能
    const mod = this._getUnresolvedUrlToModule(rawUrl)
    if (mod) {
      return mod
    }
    // 2、完整URL 解析
    const [url] = await this._resolveUrl(rawUrl)
    return this.urlToModuleMap.get(url)
  }

  /**
   * 根据模块 ID 获取对应的模块节点
   * @param id 模块 ID
   * @returns 模块节点
   */
  getModuleById(id: string): EnvironmentModuleNode | undefined {
    // 移除 ID 中的时间戳查询参数，避免因时间戳不同导致的查找失败
    return this.idToModuleMap.get(removeTimestampQuery(id))
  }

  /**
   * 根据文件路径获取对应的模块节点集合
   * @param file 文件路径
   * @returns 模块节点集合
   */
  getModulesByFile(file: string): Set<EnvironmentModuleNode> | undefined {
    return this.fileToModulesMap.get(file)
  }

  /**
   * 处理文件变更事件，使所有依赖该文件的模块失效
   * @param file 文件路径
   */
  onFileChange(file: string): void {
    // 通过文件路径获取所有依赖该模块的模块节点
    const mods = this.getModulesByFile(file)
    if (mods) {
      // 跟踪已处理的模块节点，避免重复无效化
      const seen = new Set<EnvironmentModuleNode>()
      mods.forEach((mod) => {
        this.invalidateModule(mod, seen)
      })
    }
  }

  /**
   * 当文件被删除时，触发模块的无效化
   * @param file 文件路径
   */
  onFileDelete(file: string): void {
    const mods = this.getModulesByFile(file)
    if (mods) {
      mods.forEach((mod) => {
        mod.importedModules.forEach((importedMod) => {
          importedMod.importers.delete(mod)
        })
      })
    }
  }

  /**
   * 使模块失效，确保模块在下次加载时能够被重新处理
   * 支持两种失效模式：硬失效和软失效，并会递归处理模块的所有导入者。
   * @param mod 要失效的模块节点
   * @param seen 已无效化的模块节点集合，用于避免重复无效化
   * @param timestamp 无效化时间戳，用于记录 HMR 无效化
   * @param isHmr 是否为 HMR 无效化
   * @param softInvalidate 是否为软无效化
   */
  invalidateModule(
    mod: EnvironmentModuleNode,
    seen: Set<EnvironmentModuleNode> = new Set(),
    timestamp: number = monotonicDateNow(),
    isHmr: boolean = false,
    /** @internal */
    softInvalidate = false,
  ): void {
    const prevInvalidationState = mod.invalidationState

    // Handle soft invalidation before the `seen` check, as consecutive soft/hard invalidations can
    // cause the final soft invalidation state to be different.
    // If soft invalidated, save the previous `transformResult` so that we can reuse and transform the
    // import timestamps only in `transformRequest`. If there's no previous `transformResult`, hard invalidate it.
    //  * 软失效：保存之前的 transformResult，仅更新导入时间戳
    //  * 硬失效：完全清空模块的缓存，强制重新处理
    if (softInvalidate) {
      mod.invalidationState ??= mod.transformResult ?? 'HARD_INVALIDATED'
    }
    // If hard invalidated, further soft invalidations have no effect until it's reset to `undefined`
    else {
      mod.invalidationState = 'HARD_INVALIDATED'
    }

    // Skip updating the module if it was already invalidated before and the invalidation state has not changed
    if (seen.has(mod) && prevInvalidationState === mod.invalidationState) {
      return
    }
    seen.add(mod)

    // 时间戳更新
    if (isHmr) {
      // 热更新时间戳
      mod.lastHMRTimestamp = timestamp
      mod.lastHMRInvalidationReceived = false
    } else {
      // Save the timestamp for this invalidation, so we can avoid caching the result of possible already started
      // processing being done for this module
      // 普通失效时间戳
      mod.lastInvalidationTimestamp = timestamp
    }

    // Don't invalidate mod.info and mod.meta, as they are part of the processing pipeline
    // Invalidating the transform result is enough to ensure this module is re-processed next time it is requested
    // 缓存清理
    // ETag清理
    const etag = mod.transformResult?.etag
    if (etag) this.etagToModuleMap.delete(etag)

    // 转换结果清理：清空 transformResult，确保模块下次被请求时重新处理
    mod.transformResult = null

    // SSR 状态清理：清空 ssrModule 和 ssrError，确保 SSR 模块也被重新处理
    mod.ssrModule = null
    mod.ssrError = null

    // 递归
    // importers 依赖当前模块的导入者
    mod.importers.forEach((importer) => {
      if (!importer.acceptedHmrDeps.has(mod)) {
        // If the importer statically imports the current module, we can soft-invalidate the importer
        // to only update the import timestamps. If it's not statically imported, e.g. watched/glob file,
        // we can only soft invalidate if the current module was also soft-invalidated. A soft-invalidation
        // doesn't need to trigger a re-load and re-transform of the importer.
        // But we exclude direct CSS files as those cannot be soft invalidated.
        // 软失效判断：根据导入类型和当前失效模式决定是否软失效导入者
        const shouldSoftInvalidateImporter =
          (importer.staticImportedUrls?.has(mod.url) || softInvalidate) &&
          importer.type === 'js'

        this.invalidateModule(
          importer,
          seen,
          timestamp,
          isHmr,
          shouldSoftInvalidateImporter,
        )
      }
    })

    // 错误状态清理：从错误模块集合中移除当前模块，确保模块能够被重新解析
    this._hasResolveFailedErrorModules.delete(mod)
  }

  /**
   * 使所有模块失效，确保整个模块系统在下次加载时能够被完全重新处理
   */
  invalidateAll(): void {
    // 获取当前单调递增的时间戳
    const timestamp = monotonicDateNow()
    // 用于跟踪已处理的模块
    const seen = new Set<EnvironmentModuleNode>()
    // 遍历 idToModuleMap 中的所有模块节点，使每个模块失效
    this.idToModuleMap.forEach((mod) => {
      this.invalidateModule(mod, seen, timestamp)
    })
  }

  /**
   * Update the module graph based on a module's updated imports information
   * If there are dependencies that no longer have any importers, they are
   * returned as a Set.
   *
   * @param staticImportedUrls Subset of `importedModules` where they're statically imported in code.
   *   This is only used for soft invalidations so `undefined` is fine but may cause more runtime processing.
   */
  // 更新模块的依赖关系和热更新配置
  async updateModuleInfo(
    // 要更新信息的模块节点
    mod: EnvironmentModuleNode,
    // 模块导入的依赖集合（URL 字符串或模块节点
    importedModules: Set<string | EnvironmentModuleNode>,
    // 导入的绑定信息（从哪个模块导入了哪些绑定）
    importedBindings: Map<string, Set<string>> | null,
    // 模块接受热更新的依赖集合
    acceptedModules: Set<string | EnvironmentModuleNode>,
    // 模块接受热更新的导出集合
    acceptedExports: Set<string> | null,
    // 模块是否自接受热更新
    isSelfAccepting: boolean,
    /** @internal 静态导入的 URL 集合（可选） */
    staticImportedUrls?: Set<string>,
  ): Promise<Set<EnvironmentModuleNode> | undefined> {
    // 自接受状态更新
    mod.isSelfAccepting = isSelfAccepting
    // 保存之前的导入
    const prevImports = mod.importedModules
    // 存储不再被导入的模块
    let noLongerImported: Set<EnvironmentModuleNode> | undefined

    let resolvePromises = []
    let resolveResults = new Array(importedModules.size)
    let index = 0
    // update import graph
    // 遍历所有导入的模块
    for (const imported of importedModules) {
      const nextIndex = index++
      // 对于字符串形式的导入（URL）
      if (typeof imported === 'string') {
        resolvePromises.push(
          this.ensureEntryFromUrl(imported).then((dep) => {
            dep.importers.add(mod)
            resolveResults[nextIndex] = dep
          }),
        )
      } else {
        imported.importers.add(mod)
        resolveResults[nextIndex] = imported
      }
    }

    if (resolvePromises.length) {
      await Promise.all(resolvePromises)
    }

    const nextImports = new Set(resolveResults)
    mod.importedModules = nextImports

    // remove the importer from deps that were imported but no longer are.
    // 遍历之前的导入集合
    prevImports.forEach((dep) => {
      // 对于不再导入的依赖，从其 importers 集合中移除当前模块
      if (!mod.importedModules.has(dep)) {
        dep.importers.delete(mod)
        if (!dep.importers.size) {
          // dependency no longer imported
          ;(noLongerImported || (noLongerImported = new Set())).add(dep)
        }
      }
    })

    // update accepted hmr deps
    // 更新接受的热更新依赖
    resolvePromises = []
    resolveResults = new Array(acceptedModules.size)
    index = 0
    for (const accepted of acceptedModules) {
      const nextIndex = index++
      if (typeof accepted === 'string') {
        resolvePromises.push(
          this.ensureEntryFromUrl(accepted).then((dep) => {
            resolveResults[nextIndex] = dep
          }),
        )
      } else {
        resolveResults[nextIndex] = accepted
      }
    }

    if (resolvePromises.length) {
      await Promise.all(resolvePromises)
    }

    mod.acceptedHmrDeps = new Set(resolveResults)
    mod.staticImportedUrls = staticImportedUrls

    // update accepted hmr exports
    mod.acceptedHmrExports = acceptedExports
    mod.importedBindings = importedBindings

    // 返回不再被导入的模块集合
    return noLongerImported
  }

  /**
   * 确保 URL 对应的模块节点存在
   * 如果模块节点不存在，会创建一个新的模块节点并将其添加到模块图中
   * @param rawUrl 模块的原始 URL
   * @param setIsSelfAccepting 是否为自接受热更新的模块
   * @returns 模块节点
   */
  async ensureEntryFromUrl(
    rawUrl: string,
    setIsSelfAccepting = true,
  ): Promise<EnvironmentModuleNode> {
    return this._ensureEntryFromUrl(rawUrl, setIsSelfAccepting)
  }

  /**
   * 确保从给定的 URL 创建或获取对应的模块节点
   * 它是模块加载和解析的核心函数，支持快速路径查找、URL 解析、模块创建和映射维护
   * @internal
   */
  async _ensureEntryFromUrl(
    rawUrl: string, // 模块的原始 URL
    // 是否为自接受热更新的模块
    setIsSelfAccepting = true,
    // Optimization, avoid resolving the same url twice if the caller already did it
    // 已解析的 ID
    resolved?: PartialResolvedId,
  ): Promise<EnvironmentModuleNode> {
    // Quick path, if we already have a module for this rawUrl (even without extension)
    // URL清理：移除导入查询参数和时间戳查询参数
    rawUrl = removeImportQuery(removeTimestampQuery(rawUrl))
    // 尝试通过未解析的 URL 查找模块
    let mod = this._getUnresolvedUrlToModule(rawUrl)
    if (mod) {
      return mod
    }
    const modPromise = (async () => {
      // 解析原始 URL，获取处理后的 URL、解析后的 ID 和元数据
      const [url, resolvedId, meta] = await this._resolveUrl(rawUrl, resolved)
      // 尝试通过解析后的 ID 查找模块
      mod = this.idToModuleMap.get(resolvedId)
      if (!mod) {
        // 如果模块不存在，创建新的 EnvironmentModuleNode 实例
        mod = new EnvironmentModuleNode(
          url,
          this.environment,
          setIsSelfAccepting,
        )
        if (meta) mod.meta = meta
        // 设置 URL 到模块的映射
        this.urlToModuleMap.set(url, mod)
        mod.id = resolvedId
        // 设置 ID 到模块的映射
        this.idToModuleMap.set(resolvedId, mod)
        const file = (mod.file = cleanUrl(resolvedId))
        let fileMappedModules = this.fileToModulesMap.get(file)
        if (!fileMappedModules) {
          fileMappedModules = new Set()
          // 设置文件路径到模块的映射
          this.fileToModulesMap.set(file, fileMappedModules)
        }
        fileMappedModules.add(mod)
      }
      // multiple urls can map to the same module and id, make sure we register
      // the url to the existing module in that case
      // 重复 URL 处理：如果多个 URL 映射到同一个模块，确保所有 URL 都能找到该模块
      else if (!this.urlToModuleMap.has(url)) {
        this.urlToModuleMap.set(url, mod)
      }
      // 快速路径设置：设置未解析 URL 到模块的映射
      this._setUnresolvedUrlToModule(rawUrl, mod)
      return mod
    })()

    // Also register the clean url to the module, so that we can short-circuit
    // resolving the same url twice
    this._setUnresolvedUrlToModule(rawUrl, modPromise)
    return modPromise
  }

  // some deps, like a css file referenced via @import, don't have its own
  // url because they are inlined into the main css import. But they still
  // need to be represented in the module graph so that they can trigger
  // hmr in the importing css file.
  /**
   * 为指定文件创建一个仅文件的入口模块，类型为 'asset'。
   * 它确保每个文件对应一个唯一的资源模块，避免重复创建
   * @param file 文件路径
   * @returns 模块节点
   */
  createFileOnlyEntry(file: string): EnvironmentModuleNode {
    file = normalizePath(file)
    // 取该文件对应的模块集合
    let fileMappedModules = this.fileToModulesMap.get(file)

    if (!fileMappedModules) {
      // 如果文件没有对应的模块集合，创建一个新的 Set 实例
      // 并设置到文件路径到模块的映射中
      fileMappedModules = new Set()
      this.fileToModulesMap.set(file, fileMappedModules)
    }

    // URL 构建：使用 FS_PREFIX（文件系统前缀）和规范化后的文件路径构建资源 URL
    const url = `${FS_PREFIX}${file}`
    // 遍历文件的模块集合，寻找类型为 'asset' 的模块
    for (const m of fileMappedModules) {
      if ((m.url === url || m.id === file) && m.type === 'asset') {
        // 如果找到匹配的资源模块，直接返回，避免重复创建
        return m
      }
    }

    // 创建新的 EnvironmentModuleNode 实例
    const mod = new EnvironmentModuleNode(url, this.environment)
    mod.type = 'asset'
    mod.file = file
    // 将新模块添加到文件的模块集合中
    fileMappedModules.add(mod)
    return mod
  }

  // for incoming urls, it is important to:
  // 1. remove the HMR timestamp query (?t=xxxx) and the ?import query
  // 2. resolve its extension so that urls with or without extension all map to
  // the same module
  /**
   * 解析 URL 为模块节点
   * 如果模块节点不存在，会创建一个新的模块节点并将其添加到模块图中
   * @param url URL
   * @returns 解析后的 URL、模块 ID、元数据
   */
  async resolveUrl(url: string): Promise<ResolvedUrl> {
    url = removeImportQuery(removeTimestampQuery(url))
    const mod = await this._getUnresolvedUrlToModule(url)
    if (mod?.id) {
      return [mod.url, mod.id, mod.meta]
    }
    return this._resolveUrl(url)
  }

  /**
   * 更新模块节点的转换结果
   * @param mod 模块节点
   * @param result 转换结果
   */
  updateModuleTransformResult(
    mod: EnvironmentModuleNode,
    result: TransformResult | null,
  ): void {
    if (this.environment === 'client') {
      const prevEtag = mod.transformResult?.etag
      if (prevEtag) this.etagToModuleMap.delete(prevEtag)
      if (result?.etag) this.etagToModuleMap.set(result.etag, mod)
    }

    mod.transformResult = result
  }

  /**
   * 根据 ETag 查找模块节点
   * @param etag 模块的 ETag
   * @returns 模块节点
   */
  getModuleByEtag(etag: string): EnvironmentModuleNode | undefined {
    return this.etagToModuleMap.get(etag)
  }

  /**
   * @internal
   * 根据未解析的 URL 快速查找对应的模块节点
   * @param url 未解析的模块 URL
   * @returns 模块节点
   */
  _getUnresolvedUrlToModule(
    url: string,
  ): Promise<EnvironmentModuleNode> | EnvironmentModuleNode | undefined {
    // 这个 Map 存储了未解析 URL 到模块节点的映射
    return this._unresolvedUrlToModuleMap.get(url)
  }
  /**
   * @internal
   * 设置未解析 URL 对应的模块节点
   * @param url URL
   * @param mod 模块节点
   */
  _setUnresolvedUrlToModule(
    url: string,
    mod: Promise<EnvironmentModuleNode> | EnvironmentModuleNode,
  ): void {
    this._unresolvedUrlToModuleMap.set(url, mod)
  }

  /**
   * @internal
   * 用于解析模块 URL，处理扩展名，并返回解析结果
   */
  async _resolveUrl(
    // 原始导入路径
    url: string,
    // 可选的预解析结果
    alreadyResolved?: PartialResolvedId,
  ): Promise<ResolvedUrl> {
    // URL解析
    // _resolveId 是插件链的 resolveId 钩子
    const resolved = alreadyResolved ?? (await this._resolveId(url))
    // 获取ID
    const resolvedId = resolved?.id || url

    // 原始 URL 与解析后的 ID 不同
    // 且 URL 不包含 \0 或 virtual: 前缀
    if (
      url !== resolvedId &&
      !url.includes('\0') &&
      !url.startsWith(`virtual:`)
    ) {
      // 扩展名处理
      const ext = extname(cleanUrl(resolvedId))
      if (ext) {
        const pathname = cleanUrl(url)
        if (!pathname.endsWith(ext)) {
          url = pathname + ext + url.slice(pathname.length)
        }
      }
    }
    // 处理后的 URL、模块 ID、元数据
    return [url, resolvedId, resolved?.meta]
  }
}
