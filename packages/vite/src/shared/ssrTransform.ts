export interface DefineImportMetadata {
  /**
   * Imported names before being transformed to `ssrImportKey`
   *
   * import foo, { bar as baz, qux } from 'hello'
   * => ['default', 'bar', 'qux']
   *
   * import * as namespace from 'world
   * => undefined
   */
  importedNames?: string[]
}

export interface SSRImportMetadata extends DefineImportMetadata {
  isDynamicImport?: boolean
}

/**
 * Vite converts `import { } from 'foo'` to `const _ = __vite_ssr_import__('foo')`.
 * Top-level imports and dynamic imports work slightly differently in Node.js.
 * This function normalizes the differences so it matches prod behaviour.
 * 用于分析导入模块的导出与实际使用的导出之间的差异。
 * 它主要检查命名导入是否存在，确保模块导入的正确性，并在发现问题时抛出明确的错误信息。
 */
export function analyzeImportedModDifference(
  mod: any,
  rawId: string,
  moduleType: string | undefined,
  metadata?: SSRImportMetadata,
): void {
  // No normalization needed if the user already dynamic imports this module
  // 如果是动态导入则直接return
  // 动态导入不需要进行导出差异分析，因为动态导入的错误会由 JavaScript 运行时处理
  if (metadata?.isDynamicImport) return

  // If the user named imports a specifier that can't be analyzed, error.
  // If the module doesn't import anything explicitly, e.g. `import 'foo'` or
  // `import * as foo from 'foo'`, we can skip.
  // 有命名导入处理
  if (metadata?.importedNames?.length) {
    // 过滤出在模块中不存在的导入名称
    const missingBindings = metadata.importedNames.filter((s) => !(s in mod))
    // 检查是否有缺失的绑定
    if (missingBindings.length) {
      const lastBinding = missingBindings[missingBindings.length - 1]

      // For invalid named exports only, similar to how Node.js errors for top-level imports.
      // But since we transform as dynamic imports, we need to emulate the error manually.
      // ESM 模块：抛出缺少命名导出的错误，类似 Node.js 的顶层导入错误
      if (moduleType === 'module') {
        throw new SyntaxError(
          `[vite] The requested module '${rawId}' does not provide an export named '${lastBinding}'`,
        )
      } else {
        // For non-ESM, named imports is done via static analysis with cjs-module-lexer in Node.js.
        // Copied from Node.js
        // CommonJS 模块：抛出更详细的错误，建议使用默认导入方式
        throw new SyntaxError(`\
[vite] Named export '${lastBinding}' not found. The requested module '${rawId}' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from '${rawId}';
const {${missingBindings.join(', ')}} = pkg;
`)
      }
    }
  }
}
