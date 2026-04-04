import fs from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { type DotenvPopulateInput, expand } from 'dotenv-expand'
import colors from 'picocolors'
import { arraify, createDebugger, normalizePath, tryStatSync } from './utils'
import type { UserConfig } from './config'

const debug = createDebugger('vite:env')

export function getEnvFilesForMode(
  mode: string,
  envDir: string | false,
): string[] {
  if (envDir !== false) {
    return [
      /** default file */ `.env`,
      /** local file */ `.env.local`,
      /** mode file */ `.env.${mode}`,
      /** mode local file */ `.env.${mode}.local`,
    ].map((file) => normalizePath(path.join(envDir, file)))
  }

  return []
}

export function loadEnv(
  mode: string,
  envDir: string | false,
  prefixes: string | string[] = 'VITE_',
): Record<string, string> {
  const start = performance.now()
  const getTime = () => `${(performance.now() - start).toFixed(2)}ms`

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

  const parsed = Object.fromEntries(
    envFiles.flatMap((filePath) => {
      const stat = tryStatSync(filePath)
      // Support FIFOs (named pipes) for apps like 1Password
      if (!stat || (!stat.isFile() && !stat.isFIFO())) return []

      const parsedEnv = parseEnv(fs.readFileSync(filePath, 'utf-8'))
      return Object.entries(parsedEnv as Record<string, string>)
    }),
  )

  debug?.(`env files loaded in ${getTime()}`)

  // test NODE_ENV override before expand as otherwise process.env.NODE_ENV would override this
  if (parsed.NODE_ENV && process.env.VITE_USER_NODE_ENV === undefined) {
    process.env.VITE_USER_NODE_ENV = parsed.NODE_ENV
  }
  // support BROWSER and BROWSER_ARGS env variables
  if (parsed.BROWSER && process.env.BROWSER === undefined) {
    process.env.BROWSER = parsed.BROWSER
  }
  if (parsed.BROWSER_ARGS && process.env.BROWSER_ARGS === undefined) {
    process.env.BROWSER_ARGS = parsed.BROWSER_ARGS
  }

  // let environment variables use each other. make a copy of `process.env` so that `dotenv-expand`
  // doesn't re-assign the expanded values to the global `process.env`.
  const processEnv = { ...process.env } as DotenvPopulateInput
  expand({ parsed, processEnv })

  // only keys that start with prefix are exposed to client
  for (const [key, value] of Object.entries(parsed)) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      env[key] = value
    }
  }

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

/**
 * 用于处理和验证 Vite 配置中的环境变量前缀，确保前缀配置的有效性和安全性。
 * @param param0 配置对象
 * @param param0.envPrefix 环境变量前缀数组
 * @returns
 */
export function resolveEnvPrefix({
  envPrefix = 'VITE_', // 默认前缀为 VITE_
}: UserConfig): string[] {
  // 标准化为数组格式，确保 envPrefix 是一个数组，即使传入的是单个字符串或空字符串
  envPrefix = arraify(envPrefix)
  // 如果包含空字符串，抛出错误，提示可能导致敏感信息意外暴露
  // 原因：空字符串前缀会匹配所有环境变量，包括可能包含敏感信息的系统环境变量
  if (envPrefix.includes('')) {
    throw new Error(
      `envPrefix option contains value '', which could lead unexpected exposure of sensitive information.`,
    )
  }
  // 如果包含包含空格的字符串，输出黄色警告，提示空格在实际使用中无效
  // 原因：环境变量名通常不包含空格，带空格的前缀无法匹配实际环境变量
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
