import { nanoid } from 'nanoid/non-secure'
import type { CustomPayload, HotPayload } from '#types/hmrPayload'
import { promiseWithResolvers } from './utils'
import type {
  InvokeMethods,
  InvokeResponseData,
  InvokeSendData,
} from './invokeMethods'

export type ModuleRunnerTransportHandlers = {
  onMessage: (data: HotPayload) => void
  onDisconnection: () => void
}

/**
 * "send and connect" or "invoke" must be implemented
 */
export interface ModuleRunnerTransport {
  connect?(handlers: ModuleRunnerTransportHandlers): Promise<void> | void
  disconnect?(): Promise<void> | void
  send?(data: HotPayload): Promise<void> | void
  invoke?(data: HotPayload): Promise<{ result: any } | { error: any }>
  timeout?: number
}

type InvokeableModuleRunnerTransport = Omit<ModuleRunnerTransport, 'invoke'> & {
  invoke<T extends keyof InvokeMethods>(
    name: T,
    data: Parameters<InvokeMethods[T]>,
  ): Promise<ReturnType<Awaited<InvokeMethods[T]>>>
}

function reviveInvokeError(e: any) {
  const error = new Error(e.message || 'Unknown invoke error')
  Object.assign(error, e, {
    // pass the whole error instead of just the stacktrace
    // so that it gets formatted nicely with console.log
    runnerError: new Error('RunnerError'),
  })
  return error
}

/**
 * 创建可调用模块运行时传输
 *
 * @param transport 模块运行时传输
 * @returns
 */
const createInvokeableTransport = (
  transport: ModuleRunnerTransport,
): InvokeableModuleRunnerTransport => {
  // 如果 transport 自带 invoke 方法，直接返回
  if (transport.invoke) {
    return {
      ...transport,
      async invoke(name, data) {
        const result = await transport.invoke!({
          type: 'custom',
          event: 'vite:invoke',
          data: {
            id: 'send',
            name,
            data,
          } satisfies InvokeSendData,
        } satisfies CustomPayload)
        if ('error' in result) {
          throw reviveInvokeError(result.error)
        }
        return result.result
      },
    }
  }

  // 检查是否实现了 send 和 connect 方法
  if (!transport.send || !transport.connect) {
    throw new Error(
      'transport must implement send and connect when invoke is not implemented',
    )
  }

  const rpcPromises = new Map<
    string,
    {
      resolve: (data: any) => void
      reject: (data: any) => void
      name: string
      timeoutId?: ReturnType<typeof setTimeout>
    }
  >()

  return {
    ...transport,
    connect({ onMessage, onDisconnection }) {
      return transport.connect!({
        onMessage(payload) {
          // 截获 RPC 响应消息
          if (payload.type === 'custom' && payload.event === 'vite:invoke') {
            const data = payload.data as InvokeResponseData
            // 判断是不是 “服务端返回结果”
            if (data.id.startsWith('response:')) {
              const invokeId = data.id.slice('response:'.length) // 取出请求 ID
              const promise = rpcPromises.get(invokeId) // 从等待队列里找到这个请求。
              if (!promise) return

              // 既然已经返回，就不用再触发超时错误。
              if (promise.timeoutId) clearTimeout(promise.timeoutId)

              rpcPromises.delete(invokeId) // 从等待队列里删除这个请求。

              const { error, result } = data.data
              if (error) {
                promise.reject(error)
              } else {
                promise.resolve(result) // 成功返回结果。
              }
              return
            }
          }
          // HMR 更新、错误、刷新等消息
          onMessage(payload)
        },
        onDisconnection,
      })
    },
    disconnect() {
      rpcPromises.forEach((promise) => {
        // 取消所有等待中的请求
        promise.reject(
          new Error(
            `transport was disconnected, cannot call ${JSON.stringify(promise.name)}`,
          ),
        )
      })
      rpcPromises.clear() // 清空等待队列
      return transport.disconnect?.() // 断开连接
    },
    send(data) {
      return transport.send!(data) // 发送数据
    },
    async invoke<T extends keyof InvokeMethods>(
      name: T,
      data: Parameters<InvokeMethods[T]>,
    ) {
      // 生成唯一 ID
      const promiseId = nanoid()
      // 包装数据
      const wrappedData: CustomPayload = {
        type: 'custom',
        event: 'vite:invoke', // 标记是远程调用
        data: {
          name,
          id: `send:${promiseId}`,
          data,
        } satisfies InvokeSendData,
      }
      // 发送数据
      const sendPromise = transport.send!(wrappedData)

      const { promise, resolve, reject } =
        promiseWithResolvers<ReturnType<Awaited<InvokeMethods[T]>>>()
      // 设置超时
      const timeout = transport.timeout ?? 60000
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      if (timeout > 0) {
        timeoutId = setTimeout(() => {
          rpcPromises.delete(promiseId)
          reject(
            new Error(
              `transport invoke timed out after ${timeout}ms (data: ${JSON.stringify(wrappedData)})`,
            ),
          )
        }, timeout)
        timeoutId?.unref?.() // 取消引用，防止内存泄漏 node.js 环境
      }
      //  存入 Map，等待响应
      rpcPromises.set(promiseId, { resolve, reject, name, timeoutId })

      if (sendPromise) {
        // 发送失败直接报错
        sendPromise.catch((err) => {
          clearTimeout(timeoutId)
          rpcPromises.delete(promiseId)
          reject(err)
        })
      }

      // 等待结果并返回
      try {
        return await promise
      } catch (err) {
        throw reviveInvokeError(err)
      }
    },
  }
}

export interface NormalizedModuleRunnerTransport {
  connect?(onMessage?: (data: HotPayload) => void): Promise<void> | void
  disconnect?(): Promise<void> | void
  send(data: HotPayload): Promise<void>
  invoke<T extends keyof InvokeMethods>(
    name: T,
    data: Parameters<InvokeMethods[T]>,
  ): Promise<ReturnType<Awaited<InvokeMethods[T]>>>
}

/**
 * 规范模块运行时传输
 *
 * @param transport 模块运行时传输
 * @returns
 */
export const normalizeModuleRunnerTransport = (
  transport: ModuleRunnerTransport, // 模块运行时传输
): NormalizedModuleRunnerTransport => {
  // 创建可调用传输
  const invokeableTransport = createInvokeableTransport(transport)

  let isConnected = !invokeableTransport.connect // 连接是否已建立
  let connectingPromise: Promise<void> | undefined

  return {
    ...(transport as Omit<ModuleRunnerTransport, 'connect'>),
    ...(invokeableTransport.connect
      ? {
          async connect(onMessage) {
            if (isConnected) return
            if (connectingPromise) {
              await connectingPromise
              return
            }

            const maybePromise = invokeableTransport.connect!({
              onMessage: onMessage ?? (() => {}),
              onDisconnection() {
                isConnected = false
              },
            })
            if (maybePromise) {
              connectingPromise = maybePromise
              await connectingPromise
              connectingPromise = undefined
            }
            isConnected = true
          },
        }
      : {}),
    ...(invokeableTransport.disconnect
      ? {
          async disconnect() {
            if (!isConnected) return
            if (connectingPromise) {
              await connectingPromise
            }
            isConnected = false
            await invokeableTransport.disconnect!()
          },
        }
      : {}),
    async send(data) {
      if (!invokeableTransport.send) return

      if (!isConnected) {
        if (connectingPromise) {
          await connectingPromise
        } else {
          throw new Error('send was called before connect')
        }
      }
      await invokeableTransport.send(data)
    },
    /**
     * 用于在确保连接状态的情况下调用底层传输的方法。
     * 它确保在执行远程操作前，传输通道已经建立连接，避免因连接未就绪导致的错误。
     * @param name
     * @param data
     * @returns
     */
    async invoke(name, data) {
      // 1、传输通道已连接
      if (!isConnected) {
        // 存在正在进行promise，等待连接完成
        if (connectingPromise) {
          await connectingPromise
        } else {
          // 不存在正在进行promise，直接报错
          throw new Error('invoke was called before connect')
        }
      }
      // 2、未连接
      return invokeableTransport.invoke(name, data)
    },
  }
}

/**
 * 创建 WebSocket 模块运行时传输
 *
 * @param options 传输 options 选项
 * @returns
 */
export const createWebSocketModuleRunnerTransport = (options: {
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  createConnection: () => WebSocket // 创建 WebSocket 连接
  pingInterval?: number // WebSocket 心跳间隔
}): Required<
  Pick<ModuleRunnerTransport, 'connect' | 'disconnect' | 'send'>
> => {
  // WebSocket 心跳间隔
  const pingInterval = options.pingInterval ?? 30000

  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  let ws: WebSocket | undefined
  let pingIntervalId: ReturnType<typeof setInterval> | undefined

  return {
    // 连接 WebSocket 服务器
    // @param onMessage 消息事件回调
    // @param onDisconnection 断开连接回调
    async connect({ onMessage, onDisconnection }) {
      // 创建 WebSocket 连接
      const socket = options.createConnection()
      // 监听消息事件
      socket.addEventListener('message', async ({ data }) => {
        onMessage(JSON.parse(data))
      })

      // socket.readyState 状态
      // WebSocket.CONNECTING（0），套接字已创建，但连接尚未打开。
      // WebSocket.OPEN（1），连接已打开，准备进行通信。
      // WebSocket.CLOSING（2），连接正在关闭中。
      // WebSocket.CLOSED（3），连接已关闭或无法打开。
      let isOpened = socket.readyState === socket.OPEN // 连接是否已打开
      // 等待 WebSocket 连接打开
      if (!isOpened) {
        await new Promise<void>((resolve, reject) => {
          // 监听打开事件
          socket.addEventListener(
            'open',
            () => {
              isOpened = true // 标记连接已打开
              resolve()
            },
            { once: true }, // 只监听一次
          )
          // 监听关闭事件
          socket.addEventListener('close', async () => {
            if (!isOpened) {
              reject(new Error('WebSocket closed without opened.'))
              return
            }

            // 发送断开连接消息
            onMessage({
              type: 'custom',
              event: 'vite:ws:disconnect',
              data: { webSocket: socket },
            })
            onDisconnection()
          })
        })
      }

      // 发送连接确认消息
      onMessage({
        type: 'custom',
        event: 'vite:ws:connect',
        data: { webSocket: socket },
      })
      ws = socket

      // proxy(nginx, docker) hmr ws maybe caused timeout,
      // so send ping package let ws keep alive.
      pingIntervalId = setInterval(() => {
        if (socket.readyState === socket.OPEN) {
          // 发送心跳包
          socket.send(JSON.stringify({ type: 'ping' }))
        }
      }, pingInterval)
    },
    disconnect() {
      clearInterval(pingIntervalId) // 清除心跳定时器
      ws?.close() // 关闭 WebSocket 连接
    },
    send(data) {
      // 发送数据
      ws!.send(JSON.stringify(data))
    },
  }
}
