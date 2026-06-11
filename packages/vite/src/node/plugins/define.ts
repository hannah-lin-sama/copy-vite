import { transformSync } from 'rolldown/utils'
import type { ResolvedConfig } from '../config'
import type { Plugin } from '../plugin'
import { escapeRegex, isCSSRequest } from '../utils'
import type { Environment } from '../environment'
import { isHTMLRequest } from './html'

const nonJsRe = /\.json(?:$|\?)/
const isNonJsRequest = (request: string): boolean => nonJsRe.test(request)
const escapedDotRE = /(?<!\\)\\./g

export function definePlugin(config: ResolvedConfig): Plugin {
  const isBundled = config.isBundled
  const isBuild = config.command === 'build'
  const isBuildLib = isBuild && config.build.lib

  // ignore replace process.env in lib build
  const processEnv: Record<string, string> = {}
  if (!isBuildLib) {
    const nodeEnv = process.env.NODE_ENV || config.mode
    Object.assign(processEnv, {
      'process.env': `{}`,
      'global.process.env': `{}`,
      'globalThis.process.env': `{}`,
      'process.env.NODE_ENV': JSON.stringify(nodeEnv),
      'global.process.env.NODE_ENV': JSON.stringify(nodeEnv),
      'globalThis.process.env.NODE_ENV': JSON.stringify(nodeEnv),
    })
  }

  // during dev, import.meta properties are handled by importAnalysis plugin.
  const importMetaKeys: Record<string, string> = {}
  const importMetaEnvKeys: Record<string, string> = {}
  const importMetaFallbackKeys: Record<string, string> = {}
  if (isBuild) {
    importMetaKeys['import.meta.hot'] = `undefined`
  }
  if (isBundled) {
    for (const key in config.env) {
      const val = JSON.stringify(config.env[key])
      importMetaKeys[`import.meta.env.${key}`] = val
      importMetaEnvKeys[key] = val
    }
    // these will be set to a proper value in `generatePattern`
    importMetaKeys['import.meta.env.SSR'] = `undefined`
    importMetaFallbackKeys['import.meta.env'] = `undefined`
  }

  function generatePattern(environment: Environment) {
    const keepProcessEnv = environment.config.keepProcessEnv

    const userDefine: Record<string, string> = {}
    const userDefineEnv: Record<string, any> = {}
    for (const key in environment.config.define) {
      userDefine[key] = handleDefineValue(environment.config.define[key])

      // make sure `import.meta.env` object has user define properties
      if (isBuild && key.startsWith('import.meta.env.')) {
        userDefineEnv[key.slice(16)] = environment.config.define[key]
      }
    }

    const define: Record<string, string> = {
      ...(keepProcessEnv ? {} : processEnv),
      ...importMetaKeys,
      ...userDefine,
      ...importMetaFallbackKeys,
    }

    // Additional define fixes based on `ssr` value
    const ssr = environment.config.consumer === 'server'

    if ('import.meta.env.SSR' in define) {
      define['import.meta.env.SSR'] = ssr + ''
    }

    const importMetaEnvVal = serializeDefine({
      ...importMetaEnvKeys,
      SSR: ssr + '',
      ...userDefineEnv,
    })

    // Create regex pattern as a fast check before running esbuild
    const patternKeys = Object.keys(userDefine)
    if (!keepProcessEnv && Object.keys(processEnv).length) {
      patternKeys.push('process.env')
    }
    if (Object.keys(importMetaKeys).length) {
      patternKeys.push('import.meta.env', 'import.meta.hot')
    }
    const pattern = patternKeys.length
      ? new RegExp(
          patternKeys
            // replace `\.` (ignore `\\.`) with `\??\.` to match with `?.` as well
            .map((key) => escapeRegex(key).replaceAll(escapedDotRE, '\\??\\.'))
            .join('|'),
        )
      : null

    return [define, pattern, importMetaEnvVal] as const
  }

  const patternsCache = new WeakMap<
    Environment,
    readonly [Record<string, string>, RegExp | null, string]
  >()
  function getPattern(environment: Environment) {
    let pattern = patternsCache.get(environment)
    if (!pattern) {
      pattern = generatePattern(environment)
      patternsCache.set(environment, pattern)
    }
    return pattern
  }

  // 构建模式
  if (isBundled) {
    return {
      name: 'vite:define',
      options(option) {
        const [define, _pattern, importMetaEnvVal] = getPattern(
          this.environment,
        )
        define['import.meta.env'] = importMetaEnvVal
        define['import.meta.env.*'] = 'undefined'
        option.transform ??= {}
        option.transform.define = { ...option.transform.define, ...define }
      },
    }
  }

  return {
    name: 'vite:define',

    transform: {
      async handler(code, id) {
        if (this.environment.config.consumer === 'client') {
          // for dev we inject actual global defines in the vite client to
          // avoid the transform cost. see the `clientInjection` and
          // `importAnalysis` plugin.
          return
        }

        if (
          // exclude html, css and static assets for performance
          isHTMLRequest(id) ||
          isCSSRequest(id) ||
          isNonJsRequest(id) ||
          config.assetsInclude(id)
        ) {
          return
        }

        const [define, pattern] = getPattern(this.environment)
        if (!pattern) return

        // Check if our code needs any replacements before running esbuild
        pattern.lastIndex = 0
        if (!pattern.test(code)) return

        const result = await replaceDefine(this.environment, code, id, define)
        return result
      },
    },
  }
}

/**
 * 使用 OXC 编译器对代码进行转换，将指定的宏定义替换为实际值
 * @param environment
 * @param code
 * @param id
 * @param define
 * @returns
 */
export async function replaceDefine(
  environment: Environment,
  code: string,
  id: string,
  define: Record<string, string>,
): Promise<{
  code: string
  map: ReturnType<typeof transformSync>['map'] | null
}> {
  // rolldown.utils.transformSync 用于同步转换代码，支持 define 替换
  const result = transformSync(id, code, {
    lang: 'js',
    sourceType: 'module',
    define,
    sourcemap:
      environment.config.command === 'build'
        ? !!environment.config.build.sourcemap
        : true,
    tsconfig: false,
  })

  if (result.errors.length > 0) {
    throw new AggregateError(result.errors, 'oxc transform error')
  }

  return {
    code: result.code,
    map: result.map || null,
  }
}

/**
 * Like `JSON.stringify` but keeps raw string values as a literal
 * in the generated code. For example: `"window"` would refer to
 * the global `window` object directly.
 * 将一个键值对对象序列化为 JavaScript 对象字面量字符串
 */
export function serializeDefine(define: Record<string, any>): string {
  let res = `{`

  // 对键进行排序，确保一致的输出顺序
  const keys = Object.keys(define).sort()

  // 遍历键值对，将每个键值对转换为字符串并拼接起来
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const val = define[key]
    res += `${JSON.stringify(key)}: ${handleDefineValue(val)}`
    if (i !== keys.length - 1) {
      res += `, `
    }
  }
  return res + `}`
}

function handleDefineValue(value: any): string {
  if (typeof value === 'undefined') return 'undefined'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}
