import path from 'node:path'
import picomatch from 'picomatch'
import type { ModuleTypeFilter } from 'rolldown'
import { arraify } from '../utils'
import { slash } from '../../shared/utils'

export type PluginFilter = (input: string) => boolean
export type TransformHookFilter = (
  id: string,
  code: string,
  moduleType: string,
) => boolean

export type StringFilter<Value = string | RegExp> =
  | Value
  | Array<Value>
  | {
      include?: Value | Array<Value>
      exclude?: Value | Array<Value>
    }

type NormalizedStringFilter = {
  include?: Array<string | RegExp>
  exclude?: Array<string | RegExp>
}

function getMatcherString(glob: string, cwd: string) {
  if (glob.startsWith('**') || path.isAbsolute(glob)) {
    return slash(glob)
  }

  const resolved = path.join(cwd, glob)
  return slash(resolved)
}

/**
 * 创建 ID 过滤器
 * @param pattern 过滤模式 字符串或正则表达式
 * @param cwd 项目根目录
 * @returns
 */
function patternToIdFilter(
  pattern: string | RegExp,
  cwd: string,
): PluginFilter {
  // 如果是正则表达式，直接返回测试函数
  if (pattern instanceof RegExp) {
    return (id: string) => {
      const normalizedId = slash(id)
      const result = pattern.test(normalizedId)
      pattern.lastIndex = 0
      return result
    }
  }

  // 如果是字符串，使用 picomatch 匹配
  const glob = getMatcherString(pattern, cwd)
  const matcher = picomatch(glob, { dot: true })
  return (id: string) => {
    const normalizedId = slash(id)
    return matcher(normalizedId)
  }
}

function patternToCodeFilter(pattern: string | RegExp): PluginFilter {
  if (pattern instanceof RegExp) {
    return (code: string) => {
      const result = pattern.test(code)
      pattern.lastIndex = 0
      return result
    }
  }
  return (code: string) => code.includes(pattern)
}

/**
 * 创建组合过滤器
 * @param exclude 排除过滤器数组
 * @param include 包含过滤器数组
 * @returns
 */
function createFilter(
  exclude: Array<PluginFilter> | undefined,
  include: Array<PluginFilter> | undefined,
): PluginFilter | undefined {
  if (!exclude && !include) {
    return
  }

  return (input) => {
    // 排除过滤器匹配，返回 false
    if (exclude?.some((filter) => filter(input))) {
      return false
    }
    // 包含过滤器匹配，返回 true
    if (include?.some((filter) => filter(input))) {
      return true
    }
    // 没有 include 过滤器，返回 true
    return !(include && include.length > 0)
  }
}

function normalizeFilter(filter: StringFilter): NormalizedStringFilter {
  if (typeof filter === 'string' || filter instanceof RegExp) {
    return {
      include: [filter],
    }
  }
  if (Array.isArray(filter)) {
    return {
      include: filter,
    }
  }
  return {
    include: filter.include ? arraify(filter.include) : undefined,
    exclude: filter.exclude ? arraify(filter.exclude) : undefined,
  }
}

/**
 * 创建 ID 过滤器
 * @param filter 过滤器配置 字符串、数组、对象包含 include/exclude
 * @param cwd 项目根目录
 * @returns
 */
export function createIdFilter(
  filter: StringFilter | undefined,
  cwd: string = process.cwd(),
): PluginFilter | undefined {
  if (!filter) return

  // 格式化过滤器配置，将字符串、数组、对象转换为 include/exclude 格式
  const { exclude, include } = normalizeFilter(filter)

  // 创建排除过滤器
  const excludeFilter = exclude?.map((p) => patternToIdFilter(p, cwd))
  // 创建包含过滤器
  const includeFilter = include?.map((p) => patternToIdFilter(p, cwd))
  return createFilter(excludeFilter, includeFilter)
}

export function createCodeFilter(
  filter: StringFilter | undefined,
): PluginFilter | undefined {
  if (!filter) return
  const { exclude, include } = normalizeFilter(filter)
  // 创建排除过滤器，数组【函数、函数】
  const excludeFilter = exclude?.map(patternToCodeFilter)
  // 创建包含过滤器
  const includeFilter = include?.map(patternToCodeFilter)
  return createFilter(excludeFilter, includeFilter)
}

function createModuleTypeFilter(
  filter: ModuleTypeFilter | undefined,
): PluginFilter | undefined {
  if (!filter) return
  const include = Array.isArray(filter) ? filter : (filter.include ?? [])
  return (moduleType: string) => include.includes(moduleType)
}

/**
 * 创建转换过滤器
 * @param idFilter ID 过滤器配置
 * @param codeFilter 代码过滤器配置
 * @param moduleTypeFilter 模块类型过滤器配置
 * @param cwd 项目根目录
 * @returns
 */
export function createFilterForTransform(
  idFilter: StringFilter | undefined,
  codeFilter: StringFilter | undefined,
  moduleTypeFilter: ModuleTypeFilter | undefined,
  cwd?: string,
): TransformHookFilter | undefined {
  if (!idFilter && !codeFilter && !moduleTypeFilter) return
  const idFilterFn = createIdFilter(idFilter, cwd)
  const codeFilterFn = createCodeFilter(codeFilter)
  const moduleTypeFilterFn = createModuleTypeFilter(moduleTypeFilter)

  return (id, code, moduleType) => {
    let fallback = moduleTypeFilterFn?.(moduleType) ?? true
    if (!fallback) {
      return false
    }

    if (idFilterFn) {
      fallback &&= idFilterFn(id)
    }
    if (!fallback) {
      return false
    }

    if (codeFilterFn) {
      fallback &&= codeFilterFn(code)
    }
    return fallback
  }
}
