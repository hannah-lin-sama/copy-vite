import type { OriginalMapping } from '@jridgewell/trace-mapping'
import { originalPositionFor } from '@jridgewell/trace-mapping'
import { posixDirname, posixResolve } from '../utils'

interface SourceMapLike {
  version: number
  mappings?: string
  names?: string[]
  sources?: string[]
  sourcesContent?: string[]
}

type Needle = {
  line: number
  column: number
}

export class DecodedMap {
  // 原始 mappings 字符串（VLQ 编码）
  _encoded: string
  // 解码后的映射数据，懒加载。
  // 结构为：行 → 列 → 映射片段，每个片段包含 [生成的列, 源码索引, 源码行, 源码列, 名称索引]。
  _decoded: undefined | number[][][]
  // 记忆化状态对象（用于缓存解码结果，避免重复解码）
  _decodedMemo: Stats
  // 当前 Source Map 文件的路径
  url: string
  // 当前 Source Map 文件的路径
  file: string
  // Source Map 版本号（通常为 3）
  version: number
  // 原始名称列表
  names: string[] = []
  // 将 map.sources 中的相对路径基于 from 的目录解析为绝对路径
  resolvedSources: string[]

  constructor(
    // 原始 Source Map 对象（符合 Source Map V3 规范），包含 mappings、names、sources、version 等字段
    public map: SourceMapLike,
    // 当前 Source Map 文件的路径（或基准路径），用于解析 sources 中的相对路径
    from: string,
  ) {
    const { mappings, names, sources } = map
    this.version = map.version
    this.names = names || []
    this._encoded = mappings || ''
    this._decodedMemo = memoizedState()
    this.url = from
    this.file = from
    const originDir = posixDirname(from)
    this.resolvedSources = (sources || []).map((s) =>
      posixResolve(originDir, s || ''),
    )
  }
}

interface Stats {
  lastKey: number
  lastNeedle: number
  lastIndex: number
}
function memoizedState(): Stats {
  return {
    lastKey: -1,
    lastNeedle: -1,
    lastIndex: -1,
  }
}
export function getOriginalPosition(
  map: DecodedMap,
  needle: Needle,
): OriginalMapping | null {
  const result = originalPositionFor(map as any, needle)
  if (result.column == null) {
    return null
  }
  return result
}
