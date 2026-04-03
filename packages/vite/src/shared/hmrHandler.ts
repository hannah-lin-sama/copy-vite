import type { HotPayload } from '#types/hmrPayload'

// updates to HMR should go one after another. It is possible to trigger another update during the invalidation for example.
/**
 * 创建一个包装函数，确保 HMR 消息处理函数按顺序执行，避免并发处理导致的问题。
 *
 * @param handler 处理函数
 * @returns
 */
export function createHMRHandler(
  handler: (payload: HotPayload) => Promise<void>,
): (payload: HotPayload) => Promise<void> {
  // 创建一个 Queue 实例，用于存储和管理待执行的处理函数
  const queue = new Queue()
  // 返回一个函数
  // 将 handler(payload) 作为任务加入队列
  return (payload) => queue.enqueue(() => handler(payload))
}

/**
 * 处理函数队列
 * 用于确保处理函数按顺序执行，避免并发调用导致的问题
 */
class Queue {
  // 存储待执行的任务项
  private queue: {
    promise: () => Promise<void>
    resolve: (value?: unknown) => void
    reject: (err?: unknown) => void
  }[] = []
  // 标记当前是否有任务正在执行
  private pending = false

  // 将任务包装成一个新 Promise，并把任务、resolve、reject 存入队列。
  enqueue(promise: () => Promise<void>): Promise<void> {
    return new Promise<any>((resolve, reject) => {
      this.queue.push({
        promise,
        resolve,
        reject,
      })
      this.dequeue() // 开始执行第一个任务项
    })
  }

  dequeue(): boolean {
    // 如果当前有任务正在执行，直接返回 false
    if (this.pending) {
      return false
    }
    // 从队列中取出第一个任务项
    const item = this.queue.shift()
    // 如果队列为空，直接返回 false
    if (!item) {
      return false
    }
    this.pending = true // 标记当前有任务正在执行
    // 执行任务项
    item
      .promise()
      .then(item.resolve)
      .catch(item.reject)
      .finally(() => {
        this.pending = false // 标记当前没有任务正在执行
        this.dequeue() // 继续执行下一个任务项
      })
    return true // 标记当前有任务正在执行
  }
}
