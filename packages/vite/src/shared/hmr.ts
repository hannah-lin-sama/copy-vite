import type { HotPayload, Update } from '#types/hmrPayload'
import type { ModuleNamespace, ViteHotContext } from '#types/hot'
import type { InferCustomEventPayload } from '#types/customEvent'
import type { NormalizedModuleRunnerTransport } from './moduleRunnerTransport'

type CustomListenersMap = Map<string, ((data: any) => void)[]>

interface HotModule {
  id: string // 模块 ID
  callbacks: HotCallback[] // 模块的回调函数列表
}

interface HotCallback {
  // the dependencies must be fetchable paths
  deps: string[] // 依赖的模块路径列表
  fn: (modules: Array<ModuleNamespace | undefined>) => void
}

export interface HMRLogger {
  error(msg: string | Error): void
  debug(...msg: unknown[]): void
}

/**
 * HMR 上下文，用于管理热更新的模块和回调函数。
 */
export class HMRContext implements ViteHotContext {
  // 新的自定义事件监听器映射
  private newListeners: CustomListenersMap

  constructor(
    private hmrClient: HMRClient,
    private ownerPath: string, // 模块路径
  ) {
    // 初始化模块数据
    if (!hmrClient.dataMap.has(ownerPath)) {
      hmrClient.dataMap.set(ownerPath, {})
    }

    // when a file is hot updated, a new context is created
    // clear its stale callbacks
    // 清除旧的回调函数
    const mod = hmrClient.hotModulesMap.get(ownerPath)
    if (mod) {
      mod.callbacks = []
    }

    // clear stale custom event listeners
    // 获取模块的旧事件监听器
    const staleListeners = hmrClient.ctxToListenersMap.get(ownerPath)
    if (staleListeners) {
      // staleFns 是当前模块的某个特定事件的所有监听器
      for (const [event, staleFns] of staleListeners) {
        // 从全局的 customListenersMap 中获取该事件的所有监听器
        const listeners = hmrClient.customListenersMap.get(event)
        if (listeners) {
          hmrClient.customListenersMap.set(
            event,
            // 过滤掉当前模块 ownerPath 注册的所有监听器
            // 移除旧的监听器，只保留新的监听器
            listeners.filter((l) => !staleFns.includes(l)),
          )
        }
      }
    }

    // 初始化新的自定义事件监听器映射
    this.newListeners = new Map()
    hmrClient.ctxToListenersMap.set(ownerPath, this.newListeners)
  }

  get data(): any {
    return this.hmrClient.dataMap.get(this.ownerPath)
  }

  // 用于声明模块可以接受哪些依赖的热更新，并指定更新时的回调函数。
  accept(deps?: any, callback?: any): void {
    // 自接受
    // 当 deps 是函数或者未提供时，默认接受当前模块
    if (typeof deps === 'function' || !deps) {
      // self-accept: hot.accept(() => {})
      this.acceptDeps([this.ownerPath], ([mod]) => deps?.(mod))

      // 显式单依赖
    } else if (typeof deps === 'string') {
      // explicit deps
      this.acceptDeps([deps], ([mod]) => callback?.(mod))

      // 显式多依赖
    } else if (Array.isArray(deps)) {
      this.acceptDeps(deps, callback)
    } else {
      throw new Error(`invalid hot.accept() usage.`)
    }
  }

  // export names (first arg) are irrelevant on the client side, they're
  // extracted in the server for propagation
  // 注册一个回调函数，当模块的导出被热更新时执行。
  acceptExports(
    // 表示要监听的导出名称（在客户端此参数被忽略）
    _: string | readonly string[],
    callback?: (data: any) => void,
  ): void {
    this.acceptDeps([this.ownerPath], ([mod]) => callback?.(mod))
  }

  // 注册一个清理函数，当模块被热更新时执行，用于清理模块的副作用
  dispose(cb: (data: any) => void): void {
    this.hmrClient.disposeMap.set(this.ownerPath, cb)
  }

  // 注册一个清理函数，当模块被删除（不再被导入）时执行，用于清理模块的副作用
  prune(cb: (data: any) => void): void {
    this.hmrClient.pruneMap.set(this.ownerPath, cb)
  }

  // Kept for backward compatibility (#11036)
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  decline(): void {}

  // 使当前模块失效，并通过事件通知系统和其他模块。
  invalidate(message: string): void {
    // 确定第一个失效的模块
    const firstInvalidatedBy =
      this.hmrClient.currentFirstInvalidatedBy ?? this.ownerPath

    // 通知本地监听器
    this.hmrClient.notifyListeners('vite:invalidate', {
      path: this.ownerPath,
      message,
      firstInvalidatedBy,
    })
    // 发送全局事件
    this.send('vite:invalidate', {
      path: this.ownerPath,
      message,
      firstInvalidatedBy,
    })
    this.hmrClient.logger.debug(
      `invalidate ${this.ownerPath}${message ? `: ${message}` : ''}`,
    )
  }

  // 注册自定义 HMR 事件的监听器，当指定事件被触发时执行回调函数。
  on<T extends string>(
    event: T,
    cb: (payload: InferCustomEventPayload<T>) => void,
  ): void {
    const addToMap = (map: Map<string, any[]>) => {
      const existing = map.get(event) || []
      existing.push(cb)
      map.set(event, existing)
    }
    // 向全局监听器映射中添加
    addToMap(this.hmrClient.customListenersMap)
    // 向当前上下文监听器映射中添加
    addToMap(this.newListeners)
  }

  // 从事件监听器映射中移除指定的事件监听器，停止监听特定的自定义事件。
  off<T extends string>(
    event: T,
    cb: (payload: InferCustomEventPayload<T>) => void,
  ): void {
    const removeFromMap = (map: Map<string, any[]>) => {
      // 从映射中获取指定事件的所有监听器
      const existing = map.get(event)
      // 如果监听器数组不存在，则直接返回
      if (existing === undefined) {
        return
      }
      // 过滤掉与传入回调函数相同的监听器
      const pruned = existing.filter((l) => l !== cb)
      // 如果过滤后数组为空，则从映射中删除该事件
      if (pruned.length === 0) {
        map.delete(event)
        return
      }
      // 否则，将过滤后的数组设置回映射中
      map.set(event, pruned)
    }
    // 从全局的 customListenersMap 中移除指定事件的所有监听器
    removeFromMap(this.hmrClient.customListenersMap)
    // 从当前模块的自定义事件监听器映射中移除指定事件的所有监听器
    removeFromMap(this.newListeners)
  }

  // 发送自定义 HMR 事件，允许模块在热更新过程中与其他模块或 HMR 系统进行通信
  send<T extends string>(event: T, data?: InferCustomEventPayload<T>): void {
    this.hmrClient.send({ type: 'custom', event, data })
  }

  // 注册模块的热更新回调，将依赖路径和回调函数关联到模块信息中。
  private acceptDeps(
    deps: string[],
    callback: HotCallback['fn'] = () => {},
  ): void {
    // 取当前模块的信息
    const mod: HotModule = this.hmrClient.hotModulesMap.get(this.ownerPath) || {
      id: this.ownerPath, // 模块路径
      callbacks: [], // 热更新回调列表
    }
    // 添加新的热更新回调
    mod.callbacks.push({
      deps,
      fn: callback,
    })
    this.hmrClient.hotModulesMap.set(this.ownerPath, mod)
  }
}

/**
 * 初始化热模块替换 (HMR) 客户端实例。
 * 登记模块、管理更新队列、执行销毁与替换、触发回调、清理资源。
 */
export class HMRClient {
  // 存储：模块路径 → 模块热更新信息（accept 回调）
  public hotModulesMap: Map<string, HotModule> = new Map()
  // 存储：模块路径 → dispose 销毁函数（清理副作用）
  public disposeMap: Map<string, (data: any) => void | Promise<void>> =
    new Map()
  // 存储：模块路径 → prune 清理函数（文件删除时）
  public pruneMap: Map<string, (data: any) => void | Promise<void>> = new Map()
  // 存储：模块间传递的自定义数据（dispose 数据）
  public dataMap: Map<string, any> = new Map()
  // 存储：全局自定义事件监听
  public customListenersMap: CustomListenersMap = new Map()
  public ctxToListenersMap: Map<string, CustomListenersMap> = new Map()
  public currentFirstInvalidatedBy: string | undefined

  constructor(
    public logger: HMRLogger,
    // 用于传输 HMR 消息的传输层实现
    private transport: NormalizedModuleRunnerTransport,
    // This allows implementing reloading via different methods depending on the environment
    // 用于下载和导入更新后的模块的函数
    private importUpdatedModule: (update: Update) => Promise<ModuleNamespace>,
  ) {}

  /**
   * 触发自定义事件监听
   * @param event 事件名称
   * @param data 事件数据
   */
  public async notifyListeners<T extends string>(
    event: T,
    data: InferCustomEventPayload<T>,
  ): Promise<void>
  public async notifyListeners(event: string, data: any): Promise<void> {
    // 获取监听函数
    const cbs = this.customListenersMap.get(event)
    if (cbs) {
      // 执行监听函数
      await Promise.allSettled(cbs.map((cb) => cb(data)))
    }
  }

  /**
   * 发送 HMR 消息
   * @param payload HMR 消息 payload
   */
  public send(payload: HotPayload): void {
    this.transport.send(payload).catch((err) => {
      this.logger.error(err)
    })
  }

  /**
   * 清理所有资源
   */
  public clear(): void {
    this.hotModulesMap.clear()
    this.disposeMap.clear()
    this.pruneMap.clear()
    this.dataMap.clear()
    this.customListenersMap.clear()
    this.ctxToListenersMap.clear()
  }

  // After an HMR update, some modules are no longer imported on the page
  // but they may have left behind side effects that need to be cleaned up
  // (e.g. style injections)
  /**
   * 清理指定模块路径的副作用
   * @param paths 模块路径列表
   */
  public async prunePaths(paths: string[]): Promise<void> {
    await Promise.all(
      paths.map((path) => {
        // 获取要清理的模块路径的销毁函数
        const disposer = this.disposeMap.get(path)
        // 执行销毁函数
        if (disposer) return disposer(this.dataMap.get(path))
      }),
    )
    await Promise.all(
      paths.map((path) => {
        // 获取要清理的模块路径的清理函数
        const fn = this.pruneMap.get(path)
        // 执行清理函数
        if (fn) {
          return fn(this.dataMap.get(path))
        }
      }),
    )
  }

  /**
   * 当热模块替换失败时，记录错误信息并发出警告，帮助开发者了解热更新失败的原因。
   * @param err 错误信息
   * @param path 模块路径或路径列表
   */
  protected warnFailedUpdate(err: Error, path: string | string[]): void {
    // 如果错误不是 Error 实例，或者错误消息不包含 'fetch' 字符串，则记录该错误
    // 这意味着 fetch 相关的错误（如网络请求失败）不会被单独记录，避免重复记录相同的错误
    if (!(err instanceof Error) || !err.message.includes('fetch')) {
      this.logger.error(err)
    }
    // 记录热更新失败的警告信息
    this.logger.error(
      `Failed to reload ${path}. ` +
        `This could be due to syntax errors or importing non-existent ` +
        `modules. (see errors above)`,
    )
  }

  // 存储：热更新队列
  private updateQueue: Promise<(() => void) | undefined>[] = []
  private pendingUpdateQueue = false // 标记当前是否有热更新正在执行

  /**
   * buffer multiple hot updates triggered by the same src change
   * so that they are invoked in the same order they were sent.
   * (otherwise the order may be inconsistent because of the http request round trip)
   */
  /**
   * 缓存多个热更新任务，确保它们按照发送顺序执行，避免因网络请求往返导致的执行顺序不一致问题。
   * @param payload 更新 payload
   */
  public async queueUpdate(payload: Update): Promise<void> {
    // 将更新任务加入队列
    this.updateQueue.push(this.fetchUpdate(payload))
    // 如果当前没有热更新正在执行，则开始执行队列中的任务
    if (!this.pendingUpdateQueue) {
      this.pendingUpdateQueue = true // 标记正在处理队列

      // 等待一个微任务完成，
      // 这样可以确保所有同步的 queueUpdate 调用都已完成，所有更新任务都已加入队列
      await Promise.resolve()
      this.pendingUpdateQueue = false // 标记队列处理完成
      const loading = [...this.updateQueue]
      this.updateQueue = [] // 清空队列
      // 并行执行所有更新任务
      ;(await Promise.all(loading)).forEach((fn) => fn && fn())
    }
  }

  /**
   * 处理热模块替换的更新过程，包括获取更新的模块、执行清理操作，并返回一个函数用于应用更新。
   * @param update 更新 payload
   * @returns
   */
  private async fetchUpdate(update: Update): Promise<(() => void) | undefined> {
    // 从更新 payload中提取相关字段
    // path 触发更新的模块路径
    // acceptedPath 被接受更新的模块路径
    // firstInvalidatedBy 第一个被标记为失效的模块路径
    const { path, acceptedPath, firstInvalidatedBy } = update

    // 从热模块映射中获取触发更新的模块
    const mod = this.hotModulesMap.get(path)
    // 如果触发更新的模块不存在，则直接返回
    if (!mod) {
      // In a code-splitting project,
      // it is common that the hot-updating module is not loaded yet.
      // https://github.com/vitejs/vite/issues/721
      return
    }

    // 初始化更新模块的变量
    let fetchedModule: ModuleNamespace | undefined
    // 标记是否是自更新（即触发更新的模块路径与被接受更新的模块路径相同）
    const isSelfUpdate = path === acceptedPath

    // determine the qualified callbacks before we re-import the modules
    const qualifiedCallbacks = mod.callbacks.filter(({ deps }) =>
      // 过滤出依赖于被接受更新模块路径的回调函数
      deps.includes(acceptedPath),
    )

    // 如果是自更新，或者有依赖于被接受更新模块路径的回调函数，则执行更新
    if (isSelfUpdate || qualifiedCallbacks.length > 0) {
      // 执行被更新模块的清理函数（如果存在）
      const disposer = this.disposeMap.get(acceptedPath)
      if (disposer) await disposer(this.dataMap.get(acceptedPath))
      try {
        // 尝试获取更新的模块实例
        fetchedModule = await this.importUpdatedModule(update)
      } catch (e) {
        // 如果获取更新模块失败，则记录错误信息并发出警告
        this.warnFailedUpdate(e, acceptedPath)
      }
    }

    return () => {
      try {
        this.currentFirstInvalidatedBy = firstInvalidatedBy
        for (const { deps, fn } of qualifiedCallbacks) {
          // 执行所有相关的回调函数
          fn(
            deps.map((dep) =>
              dep === acceptedPath ? fetchedModule : undefined,
            ),
          )
        }
        const loggedPath = isSelfUpdate ? path : `${acceptedPath} via ${path}`
        this.logger.debug(`hot updated: ${loggedPath}`)
      } finally {
        this.currentFirstInvalidatedBy = undefined
      }
    }
  }
}
