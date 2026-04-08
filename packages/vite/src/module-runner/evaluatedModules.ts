import { cleanUrl, isWindows, slash, unwrapId } from '../shared/utils'
import { SOURCEMAPPING_URL } from '../shared/constants'
import { decodeBase64 } from './utils'
import { DecodedMap } from './sourcemap/decoder'
import type { ResolvedResult } from './types'

const MODULE_RUNNER_SOURCEMAPPING_REGEXP = new RegExp(
  `//# ${SOURCEMAPPING_URL}=data:application/json;base64,(.+)`,
)

export class EvaluatedModuleNode {
  public importers: Set<string> = new Set()
  public imports: Set<string> = new Set()
  public evaluated = false
  public meta: ResolvedResult | undefined
  public promise: Promise<any> | undefined
  public exports: any | undefined
  public file: string
  public map: DecodedMap | undefined

  constructor(
    public id: string,
    public url: string,
  ) {
    this.file = cleanUrl(id)
  }
}

/**
 * 主要服务于 模块运行器（Module Runner），关注模块执行后的状态
 */
export class EvaluatedModules {
  public readonly idToModuleMap: Map<string, EvaluatedModuleNode> = new Map()
  public readonly fileToModulesMap: Map<string, Set<EvaluatedModuleNode>> =
    new Map()
  public readonly urlToIdModuleMap: Map<string, EvaluatedModuleNode> = new Map()

  /**
   * Returns the module node by the resolved module ID. Usually, module ID is
   * the file system path with query and/or hash. It can also be a virtual module.
   *
   * Module runner graph will have 1 to 1 mapping with the server module graph.
   * @param id Resolved module ID
   */
  public getModuleById(id: string): EvaluatedModuleNode | undefined {
    return this.idToModuleMap.get(id)
  }

  /**
   * Returns all modules related to the file system path. Different modules
   * might have different query parameters or hash, so it's possible to have
   * multiple modules for the same file.
   * @param file The file system path of the module
   */
  public getModulesByFile(file: string): Set<EvaluatedModuleNode> | undefined {
    return this.fileToModulesMap.get(file)
  }

  /**
   * Returns the module node by the URL that was used in the import statement.
   * Unlike module graph on the server, the URL is not resolved and is used as is.
   * @param url Server URL that was used in the import statement
   */
  public getModuleByUrl(url: string): EvaluatedModuleNode | undefined {
    return this.urlToIdModuleMap.get(unwrapId(url))
  }

  /**
   * Ensure that module is in the graph. If the module is already in the graph,
   * it will return the existing module node. Otherwise, it will create a new
   * module node and add it to the graph.
   * 用于确保指定 ID 和 URL 的模块存在。
   * 它采用"存在则返回，不存在则创建"的策略，是模块运行器中模块管理的核心方法
   * @param id Resolved module ID
   * @param url URL that was used in the import statement
   */
  public ensureModule(id: string, url: string): EvaluatedModuleNode {
    // 规范化模块 ID，确保它符合 Vite 的模块 ID 规范
    id = normalizeModuleId(id)
    if (this.idToModuleMap.has(id)) {
      const moduleNode = this.idToModuleMap.get(id)!
      // 更新 URL 到模块的映射
      this.urlToIdModuleMap.set(url, moduleNode)
      return moduleNode
    }
    // 创建新模块节点
    const moduleNode = new EvaluatedModuleNode(id, url)
    this.idToModuleMap.set(id, moduleNode)
    this.urlToIdModuleMap.set(url, moduleNode)

    // 更新文件到模块的映射
    const fileModules = this.fileToModulesMap.get(moduleNode.file) || new Set()
    fileModules.add(moduleNode)
    this.fileToModulesMap.set(moduleNode.file, fileModules)
    return moduleNode
  }

  public invalidateModule(node: EvaluatedModuleNode): void {
    node.evaluated = false
    node.meta = undefined
    node.map = undefined
    node.promise = undefined
    node.exports = undefined
    // remove imports in case they are changed,
    // don't remove the importers because otherwise it will be empty after evaluation
    // this can create a bug when file was removed but it still triggers full-reload
    // we are fine with the bug for now because it's not a common case
    node.imports.clear()
  }

  /**
   * Extracts the inlined source map from the module code and returns the decoded
   * source map. If the source map is not inlined, it will return null.
   * 用于获取指定模块 ID 的源码映射。
   * 它通过解析模块代码中的内联源码映射，为调试提供原始源码位置信息，是 Vite 模块运行器中支持源码映射的核心方法。
   * @param id Resolved module ID
   */
  getModuleSourceMapById(id: string): DecodedMap | null {
    const mod = this.getModuleById(id)
    if (!mod) return null
    if (mod.map) return mod.map
    if (!mod.meta || !('code' in mod.meta)) return null

    const pattern = `//# ${SOURCEMAPPING_URL}=data:application/json;base64,`
    // 查找模式在代码中的最后位置
    const lastIndex = mod.meta.code.lastIndexOf(pattern)
    if (lastIndex === -1) return null

    // 使用正则表达式提取 base64 编码的源码映射
    const mapString = MODULE_RUNNER_SOURCEMAPPING_REGEXP.exec(
      mod.meta.code.slice(lastIndex),
    )?.[1]
    if (!mapString) return null
    // 创建 DecodedMap 实例
    // decodeBase64 解码 base64 字符串
    mod.map = new DecodedMap(JSON.parse(decodeBase64(mapString)), mod.file)
    return mod.map
  }

  public clear(): void {
    this.idToModuleMap.clear()
    this.fileToModulesMap.clear()
    this.urlToIdModuleMap.clear()
  }
}

// unique id that is not available as "$bare_import" like "test"
// https://nodejs.org/api/modules.html#built-in-modules-with-mandatory-node-prefix
const prefixedBuiltins = new Set([
  'node:sea',
  'node:sqlite',
  'node:test',
  'node:test/reporters',
])

// transform file url to id
// virtual:custom -> virtual:custom
// \0custom -> \0custom
// node:fs -> fs
// /@fs/C:/root/id.js => C:/root/id.js
// file:///C:/root/id.js -> C:/root/id.js
export function normalizeModuleId(file: string): string {
  if (prefixedBuiltins.has(file)) return file

  // unix style, but Windows path still starts with the drive letter to check the root
  const unixFile = slash(file)
    .replace(/^\/@fs\//, isWindows ? '' : '/')
    .replace(/^node:/, '')
    .replace(/^\/+/, '/')

  // if it's not in the root, keep it as a path, not a URL
  return unixFile.replace(/^file:\/+/, isWindows ? '' : '/')
}
