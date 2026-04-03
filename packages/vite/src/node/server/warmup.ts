import fs from 'node:fs/promises'
import path from 'node:path'
import colors from 'picocolors'
import { glob, isDynamicPattern } from 'tinyglobby'
import { FS_PREFIX } from '../constants'
import { normalizePath } from '../utils'
import type { ViteDevServer } from '../index'
import type { DevEnvironment } from './environment'

/**
 * 根据配置中的 warmup 选项，解析出需要预热的文件列表，并对每个文件进行预热处理，以提高开发服务器的响应速度
 *
 * @param server Vite 服务器实例
 * @param environment 开发环境实例
 */
export function warmupFiles(
  server: ViteDevServer,
  environment: DevEnvironment,
): void {
  const { root } = server.config

  // 解析需要预热的文件列表
  mapFiles(environment.config.dev.warmup, root).then((files) => {
    for (const file of files) {
      // 预热每个文件
      warmupFile(server, environment, file)
    }
  })
}

/**
/**
 * 预热文件
 * 
 * @param server Vite 服务器实例
 * @param environment 开发环境实例
 * @param file 文件路径
 */
async function warmupFile(
  server: ViteDevServer,
  environment: DevEnvironment,
  file: string,
) {
  // transform html with the `transformIndexHtml` hook as Vite internals would
  // pre-transform the imported JS modules linked. this may cause `transformIndexHtml`
  // plugins to be executed twice, but that's probably fine.
  // 1、处理 HTML 文件
  if (file.endsWith('.html')) {
    // 转为 HTML 文件路径为根目录的绝对路径
    const url = htmlFileToUrl(file, server.config.root)
    if (url) {
      try {
        // 读取 HTML 文件内容
        const html = await fs.readFile(file, 'utf-8')
        // 调用 Vite 插件钩子，对 HTML 文件内容进行预热处理
        await server.transformIndexHtml(url, html)
      } catch (e) {
        // Unexpected error, log the issue but avoid an unhandled exception
        environment.logger.error(
          `Pre-transform error (${colors.cyan(file)}): ${e.message}`,
          {
            error: e,
            timestamp: true,
          },
        )
      }
    }
  }
  // for other files, pass it through `transformRequest` with warmup
  // 2、处理其他文件
  else {
    // 转为其他文件路径为根目录的绝对路径
    const url = fileToUrl(file, server.config.root)
    await environment.warmupRequest(url)
  }
}

/**
 * 转换 HTML 文件路径为 URL
 *
 * @param file HTML 文件路径
 * @param root 根目录路径
 * @returns URL
 */
function htmlFileToUrl(file: string, root: string) {
  const url = path.relative(root, file)
  // out of root, ignore file
  // 根目录外的文件，直接忽略
  if (url[0] === '.') return
  // file within root, create root-relative url
  return '/' + normalizePath(url)
}

/**
 * 将文件的绝对路径转换为 Vite 开发服务器可以识别的 URL 路径，处理根目录内和根目录外的文件路径。
 *
 * @param file 文件路径
 * @param root 根目录路径
 * @returns URL
 */
function fileToUrl(file: string, root: string) {
  // 计算文件相对于根目录的路径
  const url = path.relative(root, file)
  // out of root, use /@fs/ prefix
  // 处理根目录外的文件
  if (url[0] === '.') {
    // 构建带有 /@fs/ 前缀的 URL
    return path.posix.join(FS_PREFIX, normalizePath(file))
  }
  // file within root, create root-relative url
  return '/' + normalizePath(url)
}

/**
 * 转换文件路径为绝对路径
 *
 * @param files 文件路径数组
 * @param root 根目录路径
 * @returns 文件路径数组
 */
async function mapFiles(files: string[], root: string) {
  if (!files.length) return []

  const result: string[] = []
  const globs: string[] = []

  for (const file of files) {
    if (isDynamicPattern(file)) {
      globs.push(file)
    } else {
      if (path.isAbsolute(file)) {
        result.push(file)
      } else {
        result.push(path.resolve(root, file))
      }
    }
  }
  if (globs.length) {
    result.push(
      ...(await glob(globs, {
        absolute: true,
        cwd: root,
        expandDirectories: false, // 不展开目录
        // 忽略 .git 目录和 node_modules 目录
        ignore: ['**/.git/**', '**/node_modules/**'],
      })),
    )
  }
  return result
}
