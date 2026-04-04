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

/**
 *
 * @param glob
 * @param cwd
 * @returns
 */
function getMatcherString(glob: string, cwd: string) {
  if (glob.startsWith('**') || path.isAbsolute(glob)) {
    // 统一使用正斜杠
    return slash(glob)
  }

  const resolved = path.join(cwd, glob)
  return slash(resolved)
}

/**
 * 用于将字符串或正则表达式形式的模式转换为针对模块 ID 的过滤器函数
 * @param pattern  过滤模式，可以是字符串或正则表达式
 * @param cwd 当前工作目录
 * @returns
 */
function patternToIdFilter(
  pattern: string | RegExp,
  cwd: string,
): PluginFilter {
  // 1、处理 RegExp
  if (pattern instanceof RegExp) {
    return (id: string) => {
      // ID 标准化：使用 slash 函数将模块 ID 标准化（统一使用正斜杠）
      const normalizedId = slash(id)
      // 测试匹配：使用正则表达式的 test 方法测试标准化后的 ID
      const result = pattern.test(normalizedId)
      pattern.lastIndex = 0
      return result // 返回布尔值
    }
  }

  // 2、处理字符串
  // 模式转换：调用 getMatcherString 函数将字符串模式转换为 glob 匹配字符串
  const glob = getMatcherString(pattern, cwd)
  // 创建匹配器：使用 picomatch 库创建 glob 匹配器，启用 dot 选项以匹配以点开头的文件
  const matcher = picomatch(glob, { dot: true })

  return (id: string) => {
    // ID 标准化：使用 slash 函数将模块 ID 标准化
    const normalizedId = slash(id)
    return matcher(normalizedId) // 返回匹配结果（布尔值）
  }
}

/**
 *
 * @param pattern
 * @returns
 */
function patternToCodeFilter(pattern: string | RegExp): PluginFilter {
  // 1、处理 RegExp
  if (pattern instanceof RegExp) {
    return (code: string) => {
      const result = pattern.test(code)
      pattern.lastIndex = 0
      return result
    }
  }
  // 2、处理字符串
  return (code: string) => code.includes(pattern)
}

/**
 * 用于创建一个组合过滤器，根据 include 和 exclude 规则来决定是否接受输入
 * @param exclude 排除过滤器数组
 * @param include 包含过滤器数组
 * @returns 组合过滤器函数
 */
function createFilter(
  exclude: Array<PluginFilter> | undefined,
  include: Array<PluginFilter> | undefined,
): PluginFilter | undefined {
  if (!exclude && !include) {
    return
  }

  return (input) => {
    // 排除优先：首先检查输入是否匹配任何 exclude 过滤器，如果是，直接返回 false
    if (exclude?.some((filter) => filter(input))) {
      return false
    }
    // 包含检查：然后检查输入是否匹配任何 include 过滤器，如果是，返回 true
    if (include?.some((filter) => filter(input))) {
      return true
    }
    return !(include && include.length > 0)
  }
}

/**
 * 用于将各种形式的过滤模式标准化为统一的结构
 * @param filter
 * @returns
 */
function normalizeFilter(filter: StringFilter): NormalizedStringFilter {
  // 1、处理单个字符串或 RegExp
  if (typeof filter === 'string' || filter instanceof RegExp) {
    return {
      include: [filter],
    }
  }
  // 2、处理数组
  if (Array.isArray(filter)) {
    return {
      include: filter,
    }
  }
  // 3、处理对象
  return {
    include: filter.include ? arraify(filter.include) : undefined,
    exclude: filter.exclude ? arraify(filter.exclude) : undefined,
  }
}

/**
 * 用于创建基于模块 ID 的过滤器。
 * 它将字符串形式的过滤模式转换为可执行的过滤器函数，用于判断模块 ID 是否符合特定条件。
 * @param filter  字符串形式的过滤模式，可以是单个字符串、字符串数组或对象
 * @param cwd 当前工作目录
 * @returns
 */
export function createIdFilter(
  filter: StringFilter | undefined,
  cwd: string = process.cwd(),
): PluginFilter | undefined {
  if (!filter) return

  // 1、标准化过滤模式
  const { exclude, include } = normalizeFilter(filter)
  // 2、创建排除过滤器，将每个排除模式转换为过滤器函数
  const excludeFilter = exclude?.map((p) => patternToIdFilter(p, cwd))
  // 3、创建包含过滤器，将每个包含模式转换为过滤器函数
  const includeFilter = include?.map((p) => patternToIdFilter(p, cwd))
  return createFilter(excludeFilter, includeFilter)
}

/**
 * 用于创建基于代码内容的过滤器。
 * 它将输入的过滤模式转换为可执行的代码过滤器函数，用于判断代码内容是否符合特定条件。
 * @param filter
 * @returns
 */
export function createCodeFilter(
  filter: StringFilter | undefined,
): PluginFilter | undefined {
  if (!filter) return
  const { exclude, include } = normalizeFilter(filter)
  const excludeFilter = exclude?.map(patternToCodeFilter)
  const includeFilter = include?.map(patternToCodeFilter)
  return createFilter(excludeFilter, includeFilter)
}

/**
 * 用于创建基于模块类型的过滤器。
 * 它将输入的模块类型过滤配置转换为可执行的过滤器函数，用于判断模块类型是否符合特定条件。
 * @param filter  可以是字符串数组或包含 include 属性的对象
 * @returns
 */
function createModuleTypeFilter(
  filter: ModuleTypeFilter | undefined,
): PluginFilter | undefined {
  if (!filter) return

  const include = Array.isArray(filter) ? filter : (filter.include ?? [])
  return (moduleType: string) => include.includes(moduleType)
}

/**
 * 用于创建一个组合过滤器，用于判断模块是否需要进行转换。
 * 它结合了 ID 过滤器、代码内容过滤器和模块类型过滤器，为插件的 transform 钩子提供了强大的过滤能力。
 * @param idFilter  模块 ID 过滤器配置
 * @param codeFilter 代码内容过滤器配置
 * @param moduleTypeFilter 模块类型过滤器配置
 * @param cwd 当前工作目录
 * @returns
 */
export function createFilterForTransform(
  idFilter: StringFilter | undefined,
  codeFilter: StringFilter | undefined,
  moduleTypeFilter: ModuleTypeFilter | undefined,
  cwd?: string,
): TransformHookFilter | undefined {
  // 如果没有提供任何过滤器配置，直接返回
  if (!idFilter && !codeFilter && !moduleTypeFilter) return

  // 创建 ID 过滤器
  const idFilterFn = createIdFilter(idFilter, cwd)
  // 创建代码内容过滤器
  const codeFilterFn = createCodeFilter(codeFilter)
  // 创建模块类型过滤器
  const moduleTypeFilterFn = createModuleTypeFilter(moduleTypeFilter)

  return (id, code, moduleType) => {
    // 首先检查模块类型是否匹配，如果不匹配，直接返回 false
    let fallback = moduleTypeFilterFn?.(moduleType) ?? true
    if (!fallback) {
      return false
    }

    // 如果有 ID 过滤器，检查模块 ID 是否匹配，如果不匹配，返回 false
    if (idFilterFn) {
      fallback &&= idFilterFn(id)
    }
    if (!fallback) {
      return false
    }

    // 如果有代码过滤器，检查代码内容是否匹配
    if (codeFilterFn) {
      fallback &&= codeFilterFn(code)
    }
    // 返回最终的判断结果，即是否需要进行转换
    return fallback
  }
}
