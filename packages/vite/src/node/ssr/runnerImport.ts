import type { InlineConfig } from '../config'
import { resolveConfig } from '../config'
import { createRunnableDevEnvironment } from '../server/environments/runnableEnvironment'
import { mergeConfig } from '../utils'

interface RunnerImportResult<T> {
  module: T
  dependencies: string[]
}

/**
 * Import any file using the default Vite environment.
 * 用于通过 Vite 的模块运行器动态导入模块。
 * 它不仅加载模块本身，还收集该模块的所有依赖项，返回模块导出和依赖列表。
 * @experimental
 */
export async function runnerImport<T>(
  moduleId: string,
  inlineConfig?: InlineConfig,
): Promise<RunnerImportResult<T>> {
  // 模块同步条件检查
  const isModuleSyncConditionEnabled = (await import('#module-sync-enabled'))
    .default

  // 配置解析
  const config = await resolveConfig(
    // 合并配置
    mergeConfig(inlineConfig || {}, {
      configFile: false, // 禁用配置文件解析
      envDir: false, // 禁用环境变量目录解析
      cacheDir: process.cwd(), // 缓存目录设置为当前工作目录
      environments: {
        inline: {
          // 指定环境的消费方为服务器端
          consumer: 'server',
          dev: {
            // 启用模块运行器转换
            moduleRunnerTransform: true,
          },
          // 模块解析配置
          resolve: {
            // 启用外部模块解析，将依赖视为外部模块，不进行打包
            // 影响：减少打包体积，提高模块加载速度
            external: true,
            // 清空主字段数组
            // 不使用 package.json 中的主字段进行模块解析
            // 避免因主字段优先级导致的解析问题，确保一致性
            mainFields: [],
            // 指定模块解析条件
            conditions: [
              'node',
              ...(isModuleSyncConditionEnabled ? ['module-sync'] : []),
            ],
          },
        },
      },
    } satisfies InlineConfig),
    'serve', // 确保是 serve 命令
  )
  // 创建可运行的开发环境
  const environment = createRunnableDevEnvironment('inline', config, {
    runnerOptions: {
      hmr: {
        logger: false, // 禁用 HMR 日志记录
      },
    },
    hot: false, // 禁用 HMR
  })
  // 初始化环境
  // 准备模块运行器，确保能够正确加载模块
  await environment.init()
  try {
    // 使用环境的运行器导入模块
    // 模块加载与执行：
    // 1、ModuleRunner 解析 moduleId，处理路径解析
    // 2、加载模块文件内容
    // 3、应用必要的转换（如 ESM 到 CommonJS 的转换）
    // 4、执行模块代码
    // 5、收集模块的依赖项
    const module = await environment.runner.import(moduleId)

    // 获取所有评估过的模块
    const modules = [
      ...environment.runner.evaluatedModules.urlToIdModuleMap.values(),
    ]
    // 过滤出所有外部化模块和当前模块
    // 这些模块不是依赖项，因为它们是 Vite 内部使用的模块
    const dependencies = modules
      .filter((m) => {
        // ignore all externalized modules
        // 忽略没有meta的模块 或者标记为外部化的模块
        if (!m.meta || 'externalize' in m.meta) {
          return false
        }
        // ignore the current module
        // 忽略当前模块，因为它不是依赖项
        return m.exports !== module
      })
      .map((m) => m.file)

    return {
      module,
      dependencies,
    }
  } finally {
    // 关闭环境
    // 释放所有资源，避免内存泄漏等问题
    await environment.close()
  }
}
