/** @deprecated use HotPayload */
export type HMRPayload = HotPayload
export type HotPayload =
  | ConnectedPayload
  | PingPayload
  | UpdatePayload
  | FullReloadPayload
  | CustomPayload
  | ErrorPayload
  | PrunePayload

// 当 WebSocket 连接成功建立后，服务器发送的第一条消息，表示连接就绪。
export interface ConnectedPayload {
  type: 'connected' // 连接成功
}

// 用于保持连接活跃的心跳消息。客户端收到后通常不需要做任何处理，但可用来检测连接是否正常。
export interface PingPayload {
  type: 'ping' // 
}

// 热更新消息，告知客户端哪些模块需要更新。
export interface UpdatePayload {
  type: 'update' // 更新
  // 列出了每个需要更新的模块及其信息，客户端会据此请求新模块并执行 HMR。
  updates: Update[]
}

export interface Update {
  //  标识更新类型，决定客户端应如何处理。
  // 'js-update'：JavaScript 模块（包括 Vue、React 组件等）需要热更新。
  // 'css-update'：CSS 文件需要更新（通常直接替换 <link> 或重新插入 <style> 标签）。
  type: 'js-update' | 'css-update'
  /**
   * URL of HMR patch chunk
   *
   * This only exists when full-bundle mode is enabled.
   */
  url?: string // HMR 补丁块（patch chunk）的 URL
  path: string // 需要更新的模块在模块图中的规范化路径（
  acceptedPath: string // 实际接受更新的模块路径
  timestamp: number // 模块编译时的时间戳
  /** @internal */
  // 指示该更新是否需要显式导入新模块（例如通过 import()）才能应用
  explicitImportRequired?: boolean
  /** @internal */
  // 标记该模块是否处于循环依赖中
  isWithinCircularImport?: boolean
  /** @internal */
  // 记录是哪个模块的失效（invalidation）首次导致了本次更新
  firstInvalidatedBy?: string
  /** @internal */
  // 列出被该更新直接“失效”的模块路径列表
  invalidates?: string[]
}

// 当模块被移除（例如动态 import 的模块不再被任何模块引用）时，通知客户端清理
export interface PrunePayload {
  type: 'prune' 
  paths: string[]
}

// 强制整个页面刷新
export interface FullReloadPayload {
  type: 'full-reload' // 全量重新加载
  path?: string // 指定需要刷新的路径（例如某个路由）
  /** @internal */
  triggeredBy?: string
}

// 允许插件或自定义逻辑发送任意结构的数据
export interface CustomPayload {
  type: 'custom' // 自定义事件
  event: string
  data?: any
}

// 当编译或转换过程中发生错误时，服务器推送错误信息，客户端可在界面上显示覆盖层
export interface ErrorPayload {
  type: 'error'
  err: {
    [name: string]: any
    message: string
    stack: string
    id?: string
    frame?: string
    plugin?: string
    pluginCode?: string
    loc?: {
      file?: string
      line: number
      column: number
    }
  }
}
