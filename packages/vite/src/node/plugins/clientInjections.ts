import path from 'node:path'
import fs from 'node:fs'
import type { Plugin } from '../plugin'
import type { ResolvedConfig } from '../config'
import { CLIENT_ENTRY, ENV_ENTRY } from '../constants'
import { isObject, normalizePath, resolveHostname } from '../utils'
import { cleanUrl } from '../../shared/utils'
import { perEnvironmentState } from '../environment'
import { replaceDefine, serializeDefine } from './define'

// ids in transform are normalized to unix style
const normalizedClientEntry = normalizePath(CLIENT_ENTRY)
const normalizedEnvEntry = normalizePath(ENV_ENTRY)

/**
 * some values used by the client needs to be dynamically injected by the server
 * @server-only
 * 主要负责在客户端代码中注入配置值和环境变量，确保客户端代码能够正确访问 Vite 配置和环境信息
 */
export function clientInjectionsPlugin(config: ResolvedConfig): Plugin {
  // 存储配置值替换函数，在 buildStart 钩子中初始化
  let injectConfigValues: (code: string) => string

  // 返回一个函数，每个构建环境（如 client 和 ssr）分别创建 define 替换函数
  const getDefineReplacer = perEnvironmentState((environment) => {
    const userDefine: Record<string, any> = {}

    for (const key in environment.config.define) {
      // import.meta.env.* is handled in `importAnalysis` plugin
      // 过滤掉 import.meta.env.* 前缀的变量（这些由 importAnalysis 插件处理
      if (!key.startsWith('import.meta.env.')) {
        userDefine[key] = environment.config.define[key]
      }
    }
    const serializedDefines = serializeDefine(userDefine)
    const definesReplacement = () => serializedDefines
    return (code: string) => code.replace(`__DEFINES__`, definesReplacement)
  })

  return {
    name: 'vite:client-inject',
    // 初始化插件，在 buildStart 钩子中创建配置值替换函数
    async buildStart() {
      // 生成一个函数
      // 用于接收客户端源码字符串，将其中的占位符（如 __BASE__、__HMR_PORT__、__MODE__ 等）替换为实际的值
      injectConfigValues = await createClientConfigValueReplacer(config)
    },
    // 转换客户端代码，注入配置值和环境变量
    async transform(code, id) {
      const ssr = this.environment.config.consumer === 'server'
      const cleanId = cleanUrl(id)

      // 客户端核心入口：/@vite/client 和 /@vite/env
      if (cleanId === normalizedClientEntry || cleanId === normalizedEnvEntry) {
        const defineReplacer = getDefineReplacer(this)
        return defineReplacer(injectConfigValues(code))

        // 其他文件中的 process.env.NODE_ENV 替换
      } else if (!ssr && code.includes('process.env.NODE_ENV')) {
        // replace process.env.NODE_ENV instead of defining a global
        // for it to avoid shimming a `process` object during dev,
        // avoiding inconsistencies between dev and build
        const nodeEnv =
          // 优先使用用户定义的值
          this.environment.config.define?.['process.env.NODE_ENV'] ||
          // 回退到系统环境变量
          // 最终回退到 Vite 模式
          JSON.stringify(process.env.NODE_ENV || config.mode)

        return await replaceDefine(this.environment, code, id, {
          'process.env.NODE_ENV': nodeEnv,
          'global.process.env.NODE_ENV': nodeEnv,
          'globalThis.process.env.NODE_ENV': nodeEnv,
        })
      }
    },
  }
}

/**
 *
 * @param value 要转义的配置值
 * @returns
 */
function escapeReplacement(value: string | number | boolean | null) {
  // 使用 JSON.stringify(value) 将输入值转换为 JSON 字符串
  const jsonValue = JSON.stringify(value)
  // 返回一个函数，该函数闭包了序列化后的值
  return () => jsonValue
}

/**
 * 生成一个函数，将客户端代码中的配置占位符替换为实际的配置值
 * @param config
 * @returns
 */
async function createClientConfigValueReplacer(
  config: ResolvedConfig,
): Promise<(code: string) => string> {
  // 解析服务器主机名, 例如 0.0.0.0 或 localhost
  const resolvedServerHostname = (await resolveHostname(config.server.host))
    .name
  // 解析服务器端口, 例如 5173
  const resolvedServerPort = config.server.port!
  const devBase = config.base // 获取开发环境基础路径

  // 构建完整的服务器主机地址, 例如 localhost:5173/
  const serverHost = `${resolvedServerHostname}:${resolvedServerPort}${devBase}`

  let hmrConfig = config.server.hmr
  hmrConfig = isObject(hmrConfig) ? hmrConfig : undefined

  // 提取 HMR 相关配置：主机、协议、超时、覆盖层
  const host = hmrConfig?.host || null
  const protocol = hmrConfig?.protocol || null
  const timeout = hmrConfig?.timeout || 30000
  const overlay = hmrConfig?.overlay !== false
  const isHmrServerSpecified = !!hmrConfig?.server
  const hmrConfigName = path.basename(config.configFile || 'vite.config.js')

  // hmr.clientPort -> hmr.port
  // -> (24678 if middleware mode and HMR server is not specified) -> new URL(import.meta.url).port
  // 处理 HMR 端口逻辑，特别是中间件模式下的默认端口24678
  let port = hmrConfig?.clientPort || hmrConfig?.port || null
  if (config.server.middlewareMode && !isHmrServerSpecified) {
    port ||= 24678
  }

  // 构建 HMR 直接目标地址
  let directTarget = hmrConfig?.host || resolvedServerHostname
  directTarget += `:${hmrConfig?.port || resolvedServerPort}`
  directTarget += devBase

  // 构建 HMR 基础路径
  let hmrBase = devBase
  if (hmrConfig?.path) {
    hmrBase = path.posix.join(hmrBase, hmrConfig.path)
  }

  // 所有配置值进行转义，确保它们可以安全地插入到代码中
  // escapeReplacement执行返回 () => JSON.stringify(value)
  const modeReplacement = escapeReplacement(config.mode)
  const baseReplacement = escapeReplacement(devBase)
  const serverHostReplacement = escapeReplacement(serverHost)
  const hmrProtocolReplacement = escapeReplacement(protocol)
  const hmrHostnameReplacement = escapeReplacement(host)
  const hmrPortReplacement = escapeReplacement(port)
  const hmrDirectTargetReplacement = escapeReplacement(directTarget)
  const hmrBaseReplacement = escapeReplacement(hmrBase)
  const hmrTimeoutReplacement = escapeReplacement(timeout)
  const hmrEnableOverlayReplacement = escapeReplacement(overlay)
  const hmrConfigNameReplacement = escapeReplacement(hmrConfigName)
  const wsTokenReplacement = escapeReplacement(config.webSocketToken)
  const serverForwardConsoleReplacement = escapeReplacement(
    config.server.forwardConsole as any,
  )
  const bundleDevReplacement = escapeReplacement(
    config.experimental.bundledDev || false,
  )

  return (code) =>
    code
      .replace(`__MODE__`, modeReplacement)
      .replace(/__BASE__/g, baseReplacement)
      .replace(`__SERVER_HOST__`, serverHostReplacement)
      .replace(`__HMR_PROTOCOL__`, hmrProtocolReplacement)
      .replace(`__HMR_HOSTNAME__`, hmrHostnameReplacement)
      .replace(`__HMR_PORT__`, hmrPortReplacement)
      .replace(`__HMR_DIRECT_TARGET__`, hmrDirectTargetReplacement)
      .replace(`__HMR_BASE__`, hmrBaseReplacement)
      .replace(`__HMR_TIMEOUT__`, hmrTimeoutReplacement)
      .replace(`__HMR_ENABLE_OVERLAY__`, hmrEnableOverlayReplacement)
      .replace(`__HMR_CONFIG_NAME__`, hmrConfigNameReplacement)
      .replace(`__WS_TOKEN__`, wsTokenReplacement)
      .replace(`__SERVER_FORWARD_CONSOLE__`, serverForwardConsoleReplacement)
      .replaceAll(`__BUNDLED_DEV__`, bundleDevReplacement)
}

/**
 * 生成 Vite 热模块替换 (HMR) 的完整实现代码，
 * 将客户端入口文件中的配置占位符替换为实际配置值，并处理特殊的导入语句
 * @param config
 * @returns
 */
export async function getHmrImplementation(
  config: ResolvedConfig,
): Promise<string> {
  // 读取客户端入口文件内容
  const content = fs.readFileSync(normalizedClientEntry, 'utf-8')
  const replacer = await createClientConfigValueReplacer(config)
  return (
    // 将其中的占位符（如 __MODE__、__BASE__、__HMR_PORT__ 等）替换为实际的配置值
    replacer(content)
      // the rolldown runtime cannot import a module
      // 移除 import '@vite/env' 语句
      .replace(/import\s*['"]@vite\/env['"]/, '')
  )
}
