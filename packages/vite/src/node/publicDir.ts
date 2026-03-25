import path from 'node:path'
import { cleanUrl, withTrailingSlash } from '../shared/utils'
import type { ResolvedConfig } from './config'
import {
  ERR_SYMLINK_IN_RECURSIVE_READDIR,
  normalizePath,
  recursiveReaddir,
  tryStatSync,
} from './utils'

const publicFilesMap = new WeakMap<ResolvedConfig, Set<string>>()

/**
 * 初始化 publicDir 目录下的所有文件
 * 
 * @param config 解析后的配置
 * @returns 
 */
export async function initPublicFiles(
  config: ResolvedConfig,
): Promise<Set<string> | undefined> {
  let fileNames: string[]
  try {
    // 递归读取 publicDir 目录下的所有文件
    fileNames = await recursiveReaddir(config.publicDir)
  } catch (e) {
    if (e.code === ERR_SYMLINK_IN_RECURSIVE_READDIR) {
      return
    }
    throw e
  }
  // 移除 publicDir 目录路径前缀，只保留文件名
  const publicFiles = new Set(
    fileNames.map((fileName) => fileName.slice(config.publicDir.length)),
  )
  // 缓存 publicDir 目录下的所有文件，后续直接从缓存中获取
  publicFilesMap.set(config, publicFiles)
  return publicFiles
}

/**
 * 获取 publicDir 目录下的所有文件
 * 
 * @param config 解析后的配置
 * @returns 
 */
function getPublicFiles(config: ResolvedConfig): Set<string> | undefined {
  return publicFilesMap.get(config)
}

export function checkPublicFile(
  url: string,
  config: ResolvedConfig,
): string | undefined {
  // note if the file is in /public, the resolver would have returned it
  // as-is so it's not going to be a fully resolved path.
  const { publicDir } = config
  if (!publicDir || url[0] !== '/') {
    return
  }

  const fileName = cleanUrl(url)

  // short-circuit if we have an in-memory publicFiles cache
  const publicFiles = getPublicFiles(config)
  if (publicFiles) {
    return publicFiles.has(fileName)
      ? normalizePath(path.join(publicDir, fileName))
      : undefined
  }

  const publicFile = normalizePath(path.join(publicDir, fileName))
  if (!publicFile.startsWith(withTrailingSlash(publicDir))) {
    // can happen if URL starts with '../'
    return
  }

  return tryStatSync(publicFile)?.isFile() ? publicFile : undefined
}
