import type { Connect } from '#dep-types/connect'

export function notFoundMiddleware(): Connect.NextHandleFunction {
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function vite404Middleware(_, res) {
    // 直接终结响应:把状态码设为 404 并结束响应,不再调用 next()
    res.statusCode = 404
    res.end()
  }
}
