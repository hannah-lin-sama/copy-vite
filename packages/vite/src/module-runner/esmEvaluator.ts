import {
  AsyncFunction,
  getAsyncFunctionDeclarationPaddingLineCount,
} from '../shared/utils'
import {
  ssrDynamicImportKey,
  ssrExportAllKey,
  ssrExportNameKey,
  ssrImportKey,
  ssrImportMetaKey,
  ssrModuleExportsKey,
} from './constants'
import type { ModuleEvaluator, ModuleRunnerContext } from './types'

export class ESModulesEvaluator implements ModuleEvaluator {
  public readonly startOffset: number =
    getAsyncFunctionDeclarationPaddingLineCount()

  /**
   * 用于执行内联的 ES 模块代码。
   * 它通过创建一个 AsyncFunction 来构建执行环境，
   * 确保模块代码能够在正确的上下文中执行，支持 ES 模块的各种特性，如静态导入、动态导入和 import.meta。
   * @param context
   * @param code
   */
  async runInlinedModule(
    context: ModuleRunnerContext,
    code: string,
  ): Promise<any> {
    // use AsyncFunction instead of vm module to support broader array of environments out of the box
    // 创建异步函数，用于执行模块代码
    const initModule = new AsyncFunction(
      // 参数列表
      ssrModuleExportsKey,
      ssrImportMetaKey,
      ssrImportKey,
      ssrDynamicImportKey,
      ssrExportAllKey,
      ssrExportNameKey,
      // source map should already be inlined by Vite
      // 函数主体，包含模块代码和严格模式指令
      '"use strict";' + code,
    )

    await initModule(
      context[ssrModuleExportsKey],
      context[ssrImportMetaKey],
      context[ssrImportKey],
      context[ssrDynamicImportKey],
      context[ssrExportAllKey],
      context[ssrExportNameKey],
    )

    // 使用 Object.seal 密封模块导出对象
    Object.seal(context[ssrModuleExportsKey])
  }

  /**
   * 用于通过动态导入加载并执行外部模块。
   * 它是 Vite 模块运行器中处理外部化模块的核心方法，支持加载 Node.js 内置模块和第三方依赖
   * @param filepath
   * @returns
   */
  runExternalModule(filepath: string): Promise<any> {
    return import(filepath)
  }
}
