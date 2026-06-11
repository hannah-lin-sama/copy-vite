import fs from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { type DotenvPopulateInput, expand } from 'dotenv-expand'
import colors from 'picocolors'
import { arraify, createDebugger, normalizePath, tryStatSync } from './utils'
import type { UserConfig } from './config'

const debug = createDebugger('vite:env')

/**
 *
 * @param mode
 * @param envDir
 * @returns
 */
export function getEnvFilesForMode(
  mode: string,
  envDir: string | false,
): string[] {
  if (envDir !== false) {
    return [
      /** default file */ `.env`, // 所有模式下都加载（基础配置）
      /** local file */ `.env.local`, // 所有模式下都加载，但应被 git 忽略（本地覆盖）
      /** mode file */ `.env.${mode}`, // 指定模式下加载（如 .env.production）
      /** mode local file */ `.env.${mode}.local`, // 指定模式下的本地覆盖（如 .env.production.local）
    ].map((file) => normalizePath(path.join(envDir, file)))
  }

  return []
}

/**
 * 负责读取、合并、展开并过滤环境变量文件
 * @param mode 运行模式（development / production / 自定义）
 * @param envDir 	.env 文件目录，false 表示禁用
 * @param prefixes 暴露给客户端的变量前缀白名单
 * @returns
 */
export function loadEnv(
  mode: string,
  envDir: string | false,
  prefixes: string | string[] = 'VITE_',
): Record<string, string> {
  const start = performance.now()
  const getTime = () => `${(performance.now() - start).toFixed(2)}ms`

  // 'local' 被禁止作为 mode，因为会和 .env.{mode}.local 的文件命名冲突（local 是保留后缀）
  if (mode === 'local') {
    throw new Error(
      `"local" cannot be used as a mode name because it conflicts with ` +
        `the .local postfix for .env files.`,
    )
  }
  prefixes = arraify(prefixes)
  const env: Record<string, string> = {}
  const envFiles = getEnvFilesForMode(mode, envDir)

  debug?.(`loading env files: %O`, envFiles)

  // 按数组顺序依次合并，后者覆盖前者
  // 覆盖优先级	.env.{mode}.local > .env.{mode} > .env.local > .env
  const parsed = Object.fromEntries(
    envFiles.flatMap((filePath) => {
      // 静默处理文件不存在，不报错
      const stat = tryStatSync(filePath)
      // Support FIFOs (named pipes) for apps like 1Password
      // 支持命名管道（如 1Password CLI 注入密钥的场景）
      if (!stat || (!stat.isFile() && !stat.isFIFO())) return []

      const parsedEnv = parseEnv(fs.readFileSync(filePath, 'utf-8'))
      return Object.entries(parsedEnv as Record<string, string>)
    }),
  )

  debug?.(`env files loaded in ${getTime()}`)

  // test NODE_ENV override before expand as otherwise process.env.NODE_ENV would override this
  // NODE_ENV 需要在 expand 之前处理，否则会被 process.env.NODE_ENV 覆盖
  // expand 时 process.env.NODE_ENV 会覆盖 .env 中的值，所以先保存到 VITE_USER_NODE_ENV
  if (parsed.NODE_ENV && process.env.VITE_USER_NODE_ENV === undefined) {
    process.env.VITE_USER_NODE_ENV = parsed.NODE_ENV
  }

  // BROWSER / BROWSER_ARGS 支持
  // support BROWSER and BROWSER_ARGS env variables
  if (parsed.BROWSER && process.env.BROWSER === undefined) {
    process.env.BROWSER = parsed.BROWSER
  }
  if (parsed.BROWSER_ARGS && process.env.BROWSER_ARGS === undefined) {
    process.env.BROWSER_ARGS = parsed.BROWSER_ARGS
  }

  // let environment variables use each other. make a copy of `process.env` so that `dotenv-expand`
  // doesn't re-assign the expanded values to the global `process.env`.
  // 变量展开（dotenv-expand）
  // 通过 dotenv-expand 支持 ${VAR} 语法
  // 复制 process.env 的原因：防止 expand 将展开结果写回到全局 process.env，造成污染。
  const processEnv = { ...process.env } as DotenvPopulateInput
  expand({ parsed, processEnv })

  // 双层过滤 — 只暴露白名单变量
  // 优先级： process.env  >  .env.{mode}.local  >  .env.{mode}  >  .env.local  >  .env
  // only keys that start with prefix are exposed to client
  // 第一层：从 parsed（.env 文件）中过滤
  for (const [key, value] of Object.entries(parsed)) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      env[key] = value
    }
  }

  // 第二层：从 process.env 中过滤（优先级更高，覆盖 parsed）
  // check if there are actual env variables starting with VITE_*
  // these are typically provided inline and should be prioritized
  for (const key in process.env) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      env[key] = process.env[key] as string
    }
  }

  debug?.(`using resolved env: %O`, env)

  return env
}

export function resolveEnvPrefix({
  envPrefix = 'VITE_',
}: UserConfig): string[] {
  envPrefix = arraify(envPrefix)
  if (envPrefix.includes('')) {
    throw new Error(
      `envPrefix option contains value '', which could lead unexpected exposure of sensitive information.`,
    )
  }
  if (envPrefix.some((prefix) => /\s/.test(prefix))) {
    // eslint-disable-next-line no-console
    console.warn(
      colors.yellow(
        `[vite] Warning: envPrefix option contains values with whitespace, which does not work in practice.`,
      ),
    )
  }
  return envPrefix
}
