import type {
  DevRuntime as DevRuntimeType,
  Messenger,
} from 'rolldown/experimental/runtime-types'
import type { ErrorPayload, HotPayload } from '#types/hmrPayload'
import type { ViteHotContext } from '#types/hot'
import { HMRClient, HMRContext } from '../shared/hmr'
import {
  createWebSocketModuleRunnerTransport,
  normalizeModuleRunnerTransport,
} from '../shared/moduleRunnerTransport'
import { createHMRHandler } from '../shared/hmrHandler'
import { setupForwardConsoleHandler } from '../shared/forwardConsole'
import { ErrorOverlay, cspNonce, overlayId } from './overlay'
import '@vite/env'

// injected by the hmr plugin when served
declare const __BASE__: string
declare const __SERVER_HOST__: string
declare const __HMR_PROTOCOL__: string | null
declare const __HMR_HOSTNAME__: string | null
declare const __HMR_PORT__: number | null
declare const __HMR_DIRECT_TARGET__: string
declare const __HMR_BASE__: string
declare const __HMR_TIMEOUT__: number
declare const __HMR_ENABLE_OVERLAY__: boolean
declare const __WS_TOKEN__: string
declare const __SERVER_FORWARD_CONSOLE__: any
declare const __BUNDLED_DEV__: boolean

/**
 * 本文件是 Vite 浏览器端运行时脚本的源码文件。
 * 它在开发模式下被注入到 index.html 中（作为 /@vite/client），运行在浏览器里，是 Vite 热更新（HMR）机制的核心
 */

console.debug('[vite] connecting...')

// 获取当前脚本自身的 URL
// import.meta.url 是当前脚本地址：http://localhost:5173/@vite/client
const importMetaUrl = new URL(import.meta.url)

// use server configuration, then fallback to inference
const serverHost = __SERVER_HOST__

// 连接协议（ws /wss）
const socketProtocol =
  __HMR_PROTOCOL__ || (importMetaUrl.protocol === 'https:' ? 'wss' : 'ws')
const hmrPort = __HMR_PORT__
// 拼接 WebSocket 地址
const socketHost = `${__HMR_HOSTNAME__ || importMetaUrl.hostname}:${
  hmrPort || importMetaUrl.port
}${__HMR_BASE__}`
const directSocketHost = __HMR_DIRECT_TARGET__ // 直接连接地址（备用）
const base = __BASE__ || '/'
const hmrTimeout = __HMR_TIMEOUT__
const wsToken = __WS_TOKEN__ // websocket token
const isBundleMode = __BUNDLED_DEV__ //是否试验性模式
const forwardConsole = __SERVER_FORWARD_CONSOLE__

// 创建 WebSocket 连接 → 连接失败自动降级重试 → 报错提示
const transport = normalizeModuleRunnerTransport(
  (() => {
    // 创建 WebSocket 连接（主连接）
    let wsTransport = createWebSocketModuleRunnerTransport({
      // 创建 WebSocket 连接
      createConnection: () =>
        new WebSocket(
          `${socketProtocol}://${socketHost}?token=${wsToken}`,
          'vite-hmr', // WebSocket 协议名称
        ),
      pingInterval: hmrTimeout, // WebSocket 心跳间隔
    })

    return {
      async connect(handlers) {
        try {
          // 尝试连接主地址
          await wsTransport.connect(handlers)
        } catch (e) {
          // only use fallback when port is inferred and was not connected before to prevent confusion
          // 失败 → 尝试备用地址（fallback）
          if (!hmrPort) {
            wsTransport = createWebSocketModuleRunnerTransport({
              createConnection: () =>
                new WebSocket(
                  `${socketProtocol}://${directSocketHost}?token=${wsToken}`,
                  'vite-hmr',
                ),
              pingInterval: hmrTimeout,
            })
            try {
              await wsTransport.connect(handlers)
              console.info(
                '[vite] Direct websocket connection fallback. Check out https://vite.dev/config/server-options.html#server-hmr to remove the previous connection error.',
              )
            } catch (e) {
              if (
                e instanceof Error &&
                e.message.includes('WebSocket closed without opened.')
              ) {
                const currentScriptHostURL = new URL(import.meta.url)
                const currentScriptHost =
                  currentScriptHostURL.host +
                  currentScriptHostURL.pathname.replace(/@vite\/client$/, '')
                console.error(
                  '[vite] failed to connect to websocket.\n' +
                    'your current setup:\n' +
                    `  (browser) ${currentScriptHost} <--[HTTP]--> ${serverHost} (server)\n` +
                    `  (browser) ${socketHost} <--[WebSocket (failing)]--> ${directSocketHost} (server)\n` +
                    'Check out your Vite / network configuration and https://vite.dev/config/server-options.html#server-hmr .',
                )
              }
            }
            return
          }
          console.error(`[vite] failed to connect to websocket (${e}). `)
          throw e
        }
      },
      async disconnect() {
        await wsTransport.disconnect()
      },
      send(data) {
        wsTransport.send(data)
      },
    }
  })(),
)

// 监听页面即将关闭 / 刷新，标记 willUnload = true，
// 让 HMR 知道：连接断开是「用户主动关页面」，不是报错。
let willUnload = false
if (typeof window !== 'undefined') {
  // window can be misleadingly defined in a worker if using define (see #19307)
  // 防止在 Web Worker 环境下被错误执行
  window.addEventListener?.('beforeunload', () => {
    willUnload = true
  })
}

function cleanUrl(pathname: string): string {
  const url = new URL(pathname, 'http://vite.dev')
  url.searchParams.delete('direct')
  return url.pathname + url.search
}

let isFirstUpdate = true // 是否第一次 HMR 热更新
// 存储：已经过期、需要替换的 CSS <link> 标签
const outdatedLinkTags = new WeakSet<HTMLLinkElement>()

const debounceReload = (time: number) => {
  let timer: ReturnType<typeof setTimeout> | null
  return () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    timer = setTimeout(() => {
      location.reload() // 刷新页面
    }, time)
  }
}
const pageReload = debounceReload(20)

const hmrClient = new HMRClient(
  {
    error: (err) => console.error('[vite]', err),
    debug: (...msg) => console.debug('[vite]', ...msg),
  },
  transport,
  isBundleMode
  // 打包开发模式（bundledDev）
    ? async function importUpdatedModule({
        url,
        acceptedPath,
        isWithinCircularImport, // 是否在循环依赖里
      }) {
        // 加载新代码，并通知 Rolldown 运行时更新模块
        const importPromise = import(base + url!).then(() =>
          // @ts-expect-error globalThis.__rolldown_runtime__
          globalThis.__rolldown_runtime__.loadExports(acceptedPath),
        )
        //  循环依赖容错
        if (isWithinCircularImport) {
          // 热更失败 → 自动刷新页面
          importPromise.catch(() => {
            console.info(
              `[hmr] ${acceptedPath} failed to apply HMR as it's within a circular import. Reloading page to reset the execution order. ` +
                `To debug and break the circular import, you can run \`vite --debug hmr\` to log the circular dependency path if a file change triggered it.`,
            )
            pageReload()
          })
        }
        return await importPromise
      }
      // 普通 ESM 模式
      // 动态加载最新的模块代码 → 解决浏览器缓存 → 处理循环依赖错误
    : async function importUpdatedModule({
        acceptedPath,  // 要更新的模块路径
        timestamp, // 模块更新时间戳
        explicitImportRequired, // 是否显式导入
        isWithinCircularImport,  // 是否在循环依赖里
      }) {
        // 拆分路径
        const [acceptedPathWithoutQuery, query] = acceptedPath.split(`?`)
        const importPromise = import(
          /* @vite-ignore */ // 告诉 vite 不解析这个动态导入
          base +
            acceptedPathWithoutQuery.slice(1) +
            `?${explicitImportRequired ? 'import&' : ''}t=${timestamp}${
              query ? `&${query}` : ''
            }`
        )
        if (isWithinCircularImport) {
          // 热更失败 → 自动刷新页面
          importPromise.catch(() => {
            console.info(
              `[hmr] ${acceptedPath} failed to apply HMR as it's within a circular import. Reloading page to reset the execution order. ` +
                `To debug and break the circular import, you can run \`vite --debug hmr\` to log the circular dependency path if a file change triggered it.`,
            )
            pageReload()
          })
        }
        // 返回模块
        return await importPromise
      },
)

// 启动 WebSocket 连接，并绑定消息处理函数
transport.connect!(createHMRHandler(handleMessage))

// 设置控制台日志（console.log）转发到服务端
setupForwardConsoleHandler(transport, forwardConsole)

/**
 * 处理 HMR 消息
 * @param payload HMR 消息 payload
 * @returns 
 */
async function handleMessage(payload: HotPayload) {
  switch (payload.type) {
    // WebSocket 和服务器握手成功，打印日志。
    case 'connected':
      console.debug(`[vite] connected.`)
      break
    // JS/CSS 热更新
    case 'update':
       // 通知所有插件 / 监听：马上要热更新了
      // 用于在热更新前执行自定义逻辑，例如刷新页面
      await hmrClient.notifyListeners('vite:beforeUpdate', payload)
      if (hasDocument) {
        // if this is the first update and there's already an error overlay, it
        // means the page opened with existing server compile error and the whole
        // module script failed to load (since one of the nested imports is 500).
        // in this case a normal update won't work and a full reload is needed.
        // 首次更新容错 + 清理错误
        if (isFirstUpdate && hasErrorOverlay()) {
          // 如果页面一打开就报错（编译失败），第一次热更新直接全页刷新，确保能正常运行
          location.reload() // 刚打开页面就报错，直接刷新修复
          return
        } else {
          if (enableOverlay) {
            clearErrorOverlay() // 清空之前的报错
          }
          isFirstUpdate = false
        }
      }
      // 所有文件更新并行处理，速度极快
      await Promise.all(
        payload.updates.map(async (update): Promise<void> => {
          if (update.type === 'js-update') {
            return hmrClient.queueUpdate(update) // 交给核心引擎更新JS
          }

          // css-update
          // this is only sent when a css file referenced with <link> is updated
          const { path, timestamp } = update
          const searchUrl = cleanUrl(path)
          // can't use querySelector with `[href*=]` here since the link may be
          // using relative paths so we need to use link.href to grab the full
          // URL for the include check.
          // 找到页面对应的旧 <link> 标签
          // 页面 <link href="style.css"> 是相对路径
          // e.href 会返回 http://localhost:5173/src/style.css 完整 URL
          const el = Array.from(
            document.querySelectorAll<HTMLLinkElement>('link'),
          ).find(
            (e) =>
              !outdatedLinkTags.has(e) && cleanUrl(e.href).includes(searchUrl),
          )

          
          if (!el) {
            return
          }

          // 拼接带时间戳的新 CSS 路径
          const newPath = `${base}${searchUrl.slice(1)}${
            searchUrl.includes('?') ? '&' : '?'
          }t=${timestamp}`

          // rather than swapping the href on the existing tag, we will
          // create a new link tag. Once the new stylesheet has loaded we
          // will remove the existing link tag. This removes a Flash Of
          // Unstyled Content that can occur when swapping out the tag href
          // directly, as the new stylesheet has not yet been loaded.
          return new Promise((resolve) => {
            // 克隆新 link 标签，不直接改旧 href
            const newLinkTag = el.cloneNode() as HTMLLinkElement
            newLinkTag.href = new URL(newPath, el.href).href
            const removeOldEl = () => {
              el.remove()
              console.debug(`[vite] css hot updated: ${searchUrl}`)
              resolve()
            }
            // 等新 CSS 加载完成后，再删除旧标签
            newLinkTag.addEventListener('load', removeOldEl)
            newLinkTag.addEventListener('error', removeOldEl)
            // 缓存新标签，避免重复删除
            outdatedLinkTags.add(el)
            // 插入新标签到旧标签后面
            el.after(newLinkTag)
          })
        }),
      )
      // 触发更新完成事件
      // 通知插件 / 框架：热更新完成
      await hmrClient.notifyListeners('vite:afterUpdate', payload)
      break
    //  处理 custom 自定义消息
    case 'custom': {
      await hmrClient.notifyListeners(payload.event, payload.data)
      if (payload.event === 'vite:ws:disconnect') {
        // dom环境，且页面未卸载
        if (hasDocument && !willUnload) {
          console.log(`[vite] server connection lost. Polling for restart...`)
          const socket = payload.data.webSocket as WebSocket
          const url = new URL(socket.url)
          url.search = '' // remove query string including `token`
          await waitForSuccessfulPing(url.href) // 轮询等待服务器重启
          location.reload()  // 服务器回来后，自动刷新页面
        }
      }
      break
    }
    // 处理 full-reload 全页刷新
    case 'full-reload':
      await hmrClient.notifyListeners('vite:beforeFullReload', payload)
      if (hasDocument) {
        if (payload.path && payload.path.endsWith('.html')) {
          // if html file is edited, only reload the page if the browser is
          // currently on that page.
          const pagePath = decodeURI(location.pathname)
          const payloadPath = base + payload.path.slice(1)
          if (
            pagePath === payloadPath ||
            payload.path === '/index.html' ||
            (pagePath.endsWith('/') && pagePath + 'index.html' === payloadPath)
          ) {
            pageReload()
          }
          return
        } else {
          pageReload()
        }
      }
      break
    //  处理 prune 清理模块
    case 'prune':
      await hmrClient.notifyListeners('vite:beforePrune', payload)
      await hmrClient.prunePaths(payload.paths)
      break
    // 显示红色错误遮罩
    case 'error': {
      await hmrClient.notifyListeners('vite:error', payload)
      if (hasDocument) {
        const err = payload.err
        if (enableOverlay) {
          createErrorOverlay(err)
        } else {
          console.error(
            `[vite] Internal Server Error\n${err.message}\n${err.stack}`,
          )
        }
      }
      break
    }
    // 处理 ping 消息
    case 'ping': // noop
      break
    // 处理默认情况
    default: {
      const check: never = payload
      return check
    }
  }
}

const enableOverlay = __HMR_ENABLE_OVERLAY__
const hasDocument = 'document' in globalThis

function createErrorOverlay(err: ErrorPayload['err']) {
  clearErrorOverlay()
  const { customElements } = globalThis
  if (customElements) {
    const ErrorOverlayConstructor = customElements.get(overlayId)!
    document.body.appendChild(new ErrorOverlayConstructor(err))
  }
}

function clearErrorOverlay() {
  document.querySelectorAll<ErrorOverlay>(overlayId).forEach((n) => n.close())
}

function hasErrorOverlay() {
  return document.querySelectorAll(overlayId).length
}

/**
 * 等待服务器重启成功
 * @param socketUrl 服务器 WebSocket 圞显 URL
 * @returns 
 */
function waitForSuccessfulPing(socketUrl: string) {
  // 确保在 DOM 环境下执行
  if (typeof SharedWorker === 'undefined') {
    const visibilityManager: VisibilityManager = {
      currentState: document.visibilityState,
      listeners: new Set(),
    }
    const onVisibilityChange = () => {
      visibilityManager.currentState = document.visibilityState
      for (const listener of visibilityManager.listeners) {
        listener(visibilityManager.currentState)
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return waitForSuccessfulPingInternal(socketUrl, visibilityManager)
  }

  // needs to be inlined to
  //   - load the worker after the server is closed
  //   - make it work with backend integrations
  const blob = new Blob(
    [
      '"use strict";',
      `const waitForSuccessfulPingInternal = ${waitForSuccessfulPingInternal.toString()};`,
      `const fn = ${pingWorkerContentMain.toString()};`,
      `fn(${JSON.stringify(socketUrl)})`,
    ],
    { type: 'application/javascript' },
  )
  const objURL = URL.createObjectURL(blob)
  const sharedWorker = new SharedWorker(objURL)
  return new Promise<void>((resolve, reject) => {
    const onVisibilityChange = () => {
      sharedWorker.port.postMessage({ visibility: document.visibilityState })
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    sharedWorker.port.addEventListener('message', (event) => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      sharedWorker.port.close()

      const data: { type: 'success' } | { type: 'error'; error: unknown } =
        event.data
      if (data.type === 'error') {
        reject(data.error)
        return
      }
      resolve()
    })

    onVisibilityChange()
    sharedWorker.port.start()
  })
}

type VisibilityManager = {
  currentState: DocumentVisibilityState
  listeners: Set<(newVisibility: DocumentVisibilityState) => void>
}

function pingWorkerContentMain(socketUrl: string) {
  self.addEventListener('connect', (_event) => {
    const event = _event as MessageEvent
    const port = event.ports[0]

    if (!socketUrl) {
      port.postMessage({
        type: 'error',
        error: new Error('socketUrl not found'),
      })
      return
    }

    const visibilityManager: VisibilityManager = {
      currentState: 'visible',
      listeners: new Set(),
    }
    port.addEventListener('message', (event) => {
      const { visibility } = event.data
      visibilityManager.currentState = visibility
      console.debug('[vite] new window visibility', visibility)
      for (const listener of visibilityManager.listeners) {
        listener(visibility)
      }
    })
    port.start()

    console.debug('[vite] connected from window')
    waitForSuccessfulPingInternal(socketUrl, visibilityManager).then(
      () => {
        console.debug('[vite] ping successful')
        try {
          port.postMessage({ type: 'success' })
        } catch (error) {
          port.postMessage({ type: 'error', error })
        }
      },
      (error) => {
        console.debug('[vite] error happened', error)
        try {
          port.postMessage({ type: 'error', error })
        } catch (error) {
          port.postMessage({ type: 'error', error })
        }
      },
    )
  })
}

/**
 * 等待服务器重启成功
 * @param socketUrl 服务器 WebSocket 圞显 URL
 * @param visibilityManager 可见性管理器
 * @param ms 等待时间（毫秒）
 * @returns 
 */
async function waitForSuccessfulPingInternal(
  socketUrl: string,
  visibilityManager: VisibilityManager,
  ms = 1000,
) {
  function wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function ping() {
    try {
      const socket = new WebSocket(socketUrl, 'vite-ping')
      return new Promise<boolean>((resolve) => {
        function onOpen() {
          resolve(true)
          close()
        }
        function onError() {
          resolve(false)
          close()
        }
        function close() {
          // 移除事件监听
          socket.removeEventListener('open', onOpen)
          socket.removeEventListener('error', onError)
          socket.close() // 关闭 WebSocket 连接
        }
        // 监听 open 事件，确认连接成功
        socket.addEventListener('open', onOpen)
        // 监听 error 事件，确认连接失败
        socket.addEventListener('error', onError)
      })
    } catch {
      return false
    }
  }

  function waitForWindowShow(visibilityManager: VisibilityManager) {
    return new Promise<void>((resolve) => {
      const onChange = (newVisibility: DocumentVisibilityState) => {
        if (newVisibility === 'visible') {
          resolve()
          visibilityManager.listeners.delete(onChange)
        }
      }
      visibilityManager.listeners.add(onChange)
    })
  }

  if (await ping()) {
    return
  }
  await wait(ms)

  while (true) {
    // 如果窗口可见，尝试连接
    if (visibilityManager.currentState === 'visible') {
      if (await ping()) {
        break
      }
      await wait(ms)
    } else {
      await waitForWindowShow(visibilityManager)
    }
  }
}

// 存储：模块ID -> <style> 标签（内联样式）
const sheetsMap = new Map<string, HTMLStyleElement>()
// 存储：模块ID -> <link> 标签（外部样式）
const linkSheetsMap = new Map<string, HTMLLinkElement>()

// collect existing style elements that may have been inserted during SSR
// to avoid FOUC or duplicate styles
if ('document' in globalThis) {
  // 收集所有带 data-vite-dev-id 属性的 <style> 标签
  document
    .querySelectorAll<HTMLStyleElement>('style[data-vite-dev-id]')
    .forEach((el) => {
      sheetsMap.set(el.getAttribute('data-vite-dev-id')!, el)
    })
  // 收集所有带 data-vite-dev-id 属性的 <link rel="stylesheet"> 标签
  document
    .querySelectorAll<HTMLLinkElement>(
      'link[rel="stylesheet"][data-vite-dev-id]',
    )
    .forEach((el) => {
      linkSheetsMap.set(el.getAttribute('data-vite-dev-id')!, el)
    })
}

// all css imports should be inserted at the same position
// because after build it will be a single css file
let lastInsertedStyle: HTMLStyleElement | undefined

export function updateStyle(id: string, content: string): void {
  if (linkSheetsMap.has(id)) return

  let style = sheetsMap.get(id)
  if (!style) {
    style = document.createElement('style')
    style.setAttribute('type', 'text/css')
    style.setAttribute('data-vite-dev-id', id)
    style.textContent = content
    if (cspNonce) {
      style.setAttribute('nonce', cspNonce)
    }

    if (!lastInsertedStyle) {
      document.head.appendChild(style)

      // reset lastInsertedStyle after async
      // because dynamically imported css will be split into a different file
      setTimeout(() => {
        lastInsertedStyle = undefined
      }, 0)
    } else {
      lastInsertedStyle.insertAdjacentElement('afterend', style)
    }
    lastInsertedStyle = style
  } else {
    style.textContent = content
  }
  sheetsMap.set(id, style)
}

export function removeStyle(id: string): void {
  if (linkSheetsMap.has(id)) {
    // re-select elements since HMR can replace links
    document
      .querySelectorAll<HTMLLinkElement>(
        `link[rel="stylesheet"][data-vite-dev-id]`,
      )
      .forEach((el) => {
        if (el.getAttribute('data-vite-dev-id') === id) {
          el.remove()
        }
      })
    linkSheetsMap.delete(id)
  }
  const style = sheetsMap.get(id)
  if (style) {
    document.head.removeChild(style)
    sheetsMap.delete(id)
  }
}

export function createHotContext(ownerPath: string): ViteHotContext {
  return new HMRContext(hmrClient, ownerPath)
}

/**
 * urls here are dynamic import() urls that couldn't be statically analyzed
 */
export function injectQuery(url: string, queryToInject: string): string {
  // skip urls that won't be handled by vite
  if (url[0] !== '.' && url[0] !== '/') {
    return url
  }

  // can't use pathname from URL since it may be relative like ../
  const pathname = url.replace(/[?#].*$/, '')
  const { search, hash } = new URL(url, 'http://vite.dev')

  return `${pathname}?${queryToInject}${search ? `&` + search.slice(1) : ''}${
    hash || ''
  }`
}

export { ErrorOverlay }

declare const DevRuntime: typeof DevRuntimeType

if (isBundleMode && typeof DevRuntime !== 'undefined') {
  // 继承 Rolldown 开发时运行时，扩展 HMR 热更新能力
  class ViteDevRuntime extends DevRuntime {
     // 创建模块热更新上下文
    override createModuleHotContext(moduleId: string) {
      const ctx = createHotContext(moduleId)
      // @ts-expect-error TODO: support CSS properly
      ctx._internal = { updateStyle, removeStyle }
      return ctx
    }

    // 空实现：更新逻辑交给 HMR Client 处理
    override applyUpdates(_boundaries: [string, string][]): void {
      // noop, handled in the HMR client
    }
  }

  // 包装 WebSocket 消息通道
  const wrappedSocket: Messenger = {
    send(message) {
      switch (message.type) {
        case 'hmr:module-registered': {
          transport.send({
            type: 'custom',
            event: 'vite:module-loaded',
            // clone array as the runtime reuses the array instance
            data: { modules: message.modules.slice() },
          })
          break
        }
        default:
          throw new Error(`Unknown message type: ${JSON.stringify(message)}`)
      }
    },
  }
  // 挂载到全局，供打包运行时使用
  ;(globalThis as any).__rolldown_runtime__ ??= new ViteDevRuntime(
    wrappedSocket,
  )
}
