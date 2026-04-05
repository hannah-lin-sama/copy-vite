import fs from 'node:fs'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { inspect, promisify } from 'node:util'
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import colors from 'picocolors'
import picomatch from 'picomatch'
import {
  type NormalizedOutputOptions,
  type OutputChunk,
  type PluginContextMeta,
  type RolldownOptions,
  rolldown,
} from 'rolldown'
import type {
  DevToolsConfig,
  ResolvedDevToolsConfig,
} from '@vitejs/devtools/config'
import type { Alias, AliasOptions } from '#dep-types/alias'
import type { AnymatchFn } from '../types/anymatch'
import { withTrailingSlash } from '../shared/utils'
import {
  createImportMetaResolver,
  importMetaResolveWithCustomHookString,
} from '../module-runner/importMetaResolver'
import {
  CLIENT_ENTRY,
  DEFAULT_ASSETS_RE,
  DEFAULT_CLIENT_CONDITIONS,
  DEFAULT_CLIENT_MAIN_FIELDS,
  DEFAULT_CONFIG_FILES,
  DEFAULT_EXTENSIONS,
  DEFAULT_EXTERNAL_CONDITIONS,
  DEFAULT_PREVIEW_PORT,
  DEFAULT_SERVER_CONDITIONS,
  DEFAULT_SERVER_MAIN_FIELDS,
  ENV_ENTRY,
  FS_PREFIX,
} from './constants'
import { resolveEnvironmentPlugins } from './plugin'
import type {
  FalsyPlugin,
  HookHandler,
  Plugin,
  PluginOption,
  PluginWithRequiredHook,
} from './plugin'
import type {
  BuildEnvironmentOptions,
  BuilderOptions,
  RenderBuiltAssetUrl,
  ResolvedBuildEnvironmentOptions,
  ResolvedBuildOptions,
  ResolvedBuilderOptions,
} from './build'
import {
  buildEnvironmentOptionsDefaults,
  builderOptionsDefaults,
  resolveBuildEnvironmentOptions,
  resolveBuilderOptions,
} from './build'
import type { ResolvedServerOptions, ServerOptions } from './server'
import { resolveServerOptions, serverConfigDefaults } from './server'
import { DevEnvironment } from './server/environment'
import { createRunnableDevEnvironment } from './server/environments/runnableEnvironment'
import type { WebSocketServer } from './server/ws'
import type { PreviewOptions, ResolvedPreviewOptions } from './preview'
import { resolvePreviewOptions } from './preview'
import {
  type CSSOptions,
  type ResolvedCSSOptions,
  cssConfigDefaults,
  resolveCSSOptions,
} from './plugins/css'
import {
  arraify,
  asyncFlatten,
  createDebugger,
  createFilter,
  hasBothRollupOptionsAndRolldownOptions,
  isExternalUrl,
  isFilePathESM,
  isInNodeModules,
  isNodeBuiltin,
  isNodeLikeBuiltin,
  isObject,
  isParentDirectory,
  mergeAlias,
  mergeConfig,
  mergeWithDefaults,
  nodeLikeBuiltins,
  normalizeAlias,
  normalizePath,
  resolveHostname,
  setupRollupOptionCompat,
} from './utils'
import {
  createPluginHookUtils,
  getHookHandler,
  getSortedPluginsByHook,
  resolvePlugins,
} from './plugins'
import type { ESBuildOptions } from './plugins/esbuild'
import {
  type EnvironmentResolveOptions,
  type InternalResolveOptions,
  type ResolveOptions,
} from './plugins/resolve'
import type { LogLevel, Logger } from './logger'
import { createLogger } from './logger'
import type { DepOptimizationOptions } from './optimizer'
import type { JsonOptions } from './plugins/json'
import type { PackageCache } from './packages'
import { findNearestNodeModules, findNearestPackageData } from './packages'
import { loadEnv, resolveEnvPrefix } from './env'
import type { ResolvedSSROptions, SSROptions } from './ssr'
import { resolveSSROptions, ssrConfigDefaults } from './ssr'
import { PartialEnvironment } from './baseEnvironment'
import { createIdResolver } from './idResolver'
import { runnerImport } from './ssr/runnerImport'
import { getAdditionalAllowedHosts } from './server/middlewares/hostCheck'
import { convertEsbuildPluginToRolldownPlugin } from './optimizer/pluginConverter'
import { type OxcOptions, convertEsbuildConfigToOxcConfig } from './plugins/oxc'
import type { RequiredExceptFor } from './typeUtils'
import {
  BasicMinimalPluginContext,
  basePluginContextMeta,
} from './server/pluginContainer'
import { nodeResolveWithVite } from './nodeResolve'
import { FullBundleDevEnvironment } from './server/environments/fullBundleEnvironment'

const debug = createDebugger('vite:config', { depth: 10 })
const promisifiedRealpath = promisify(fs.realpath)
const SYMBOL_RESOLVED_CONFIG: unique symbol = Symbol('vite:resolved-config')

export interface ConfigEnv {
  /**
   * 'serve': during dev (`vite` command)
   * 'build': when building for production (`vite build` command)
   */
  command: 'build' | 'serve'
  mode: string
  isSsrBuild?: boolean
  isPreview?: boolean
}

/**
 * spa: include SPA fallback middleware and configure sirv with `single: true` in preview
 *
 * mpa: only include non-SPA HTML middlewares
 *
 * custom: don't include HTML middlewares
 */
export type AppType = 'spa' | 'mpa' | 'custom'

export type UserConfigFnObject = (env: ConfigEnv) => UserConfig
export type UserConfigFnPromise = (env: ConfigEnv) => Promise<UserConfig>
export type UserConfigFn = (env: ConfigEnv) => UserConfig | Promise<UserConfig>

export type UserConfigExport =
  | UserConfig
  | Promise<UserConfig>
  | UserConfigFnObject
  | UserConfigFnPromise
  | UserConfigFn

/**
 * Type helper to make it easier to use vite.config.ts
 * accepts a direct {@link UserConfig} object, or a function that returns it.
 * The function receives a {@link ConfigEnv} object.
 */
export function defineConfig(config: UserConfig): UserConfig
export function defineConfig(config: Promise<UserConfig>): Promise<UserConfig>
export function defineConfig(config: UserConfigFnObject): UserConfigFnObject
export function defineConfig(config: UserConfigFnPromise): UserConfigFnPromise
export function defineConfig(config: UserConfigFn): UserConfigFn
export function defineConfig(config: UserConfigExport): UserConfigExport
export function defineConfig(config: UserConfigExport): UserConfigExport {
  return config
}

export interface CreateDevEnvironmentContext {
  ws: WebSocketServer
}

export interface DevEnvironmentOptions {
  /**
   * Files to be pre-transformed. Supports glob patterns.
   */
  warmup?: string[]
  /**
   * Pre-transform known direct imports
   * defaults to true for the client environment, false for the rest
   */
  preTransformRequests?: boolean
  /**
   * Enables sourcemaps during dev
   * @default { js: true }
   * @experimental
   */
  sourcemap?: boolean | { js?: boolean; css?: boolean }
  /**
   * Whether or not to ignore-list source files in the dev server sourcemap, used to populate
   * the [`x_google_ignoreList` source map extension](https://developer.chrome.com/blog/devtools-better-angular-debugging/#the-x_google_ignorelist-source-map-extension).
   *
   * By default, it excludes all paths containing `node_modules`. You can pass `false` to
   * disable this behavior, or, for full control, a function that takes the source path and
   * sourcemap path and returns whether to ignore the source path.
   */
  sourcemapIgnoreList?:
    | false
    | ((sourcePath: string, sourcemapPath: string) => boolean)

  /**
   * create the Dev Environment instance
   */
  createEnvironment?: (
    name: string,
    config: ResolvedConfig,
    context: CreateDevEnvironmentContext,
  ) => Promise<DevEnvironment> | DevEnvironment

  /**
   * For environments that support a full-reload, like the client, we can short-circuit when
   * restarting the server throwing early to stop processing current files. We avoided this for
   * SSR requests. Maybe this is no longer needed.
   * @experimental
   */
  recoverable?: boolean

  /**
   * For environments associated with a module runner.
   * By default, it is false for the client environment and true for non-client environments.
   * This option can also be used instead of the removed config.experimental.skipSsrTransform.
   */
  moduleRunnerTransform?: boolean
}

function defaultCreateClientDevEnvironment(
  name: string,
  config: ResolvedConfig,
  context: CreateDevEnvironmentContext,
) {
  if (config.experimental.bundledDev) {
    return new FullBundleDevEnvironment(name, config, {
      hot: true,
      transport: context.ws,
    })
  }

  return new DevEnvironment(name, config, {
    hot: true,
    transport: context.ws,
  })
}

function defaultCreateDevEnvironment(name: string, config: ResolvedConfig) {
  return createRunnableDevEnvironment(name, config)
}

export type ResolvedDevEnvironmentOptions = Omit<
  Required<DevEnvironmentOptions>,
  'sourcemapIgnoreList'
> & {
  sourcemapIgnoreList: Exclude<
    DevEnvironmentOptions['sourcemapIgnoreList'],
    false | undefined
  >
}

type AllResolveOptions = ResolveOptions & {
  alias?: AliasOptions
}

type ResolvedAllResolveOptions = Required<ResolveOptions> & { alias: Alias[] }

export interface SharedEnvironmentOptions {
  /**
   * Define global variable replacements.
   * Entries will be defined on `window` during dev and replaced during build.
   */
  define?: Record<string, any>
  /**
   * Configure resolver
   */
  resolve?: EnvironmentResolveOptions
  /**
   * Define if this environment is used for Server-Side Rendering
   * @default 'server' if it isn't the client environment
   */
  consumer?: 'client' | 'server'
  /**
   * If true, `process.env` referenced in code will be preserved as-is and evaluated in runtime.
   * Otherwise, it is statically replaced as an empty object.
   */
  keepProcessEnv?: boolean
  /**
   * Optimize deps config
   */
  optimizeDeps?: DepOptimizationOptions
}

export interface EnvironmentOptions extends SharedEnvironmentOptions {
  /**
   * Dev specific options
   */
  dev?: DevEnvironmentOptions
  /**
   * Build specific options
   */
  build?: BuildEnvironmentOptions
}

export type ResolvedResolveOptions = Required<ResolveOptions>

export type ResolvedEnvironmentOptions = {
  define?: Record<string, any>
  resolve: ResolvedResolveOptions
  consumer: 'client' | 'server'
  keepProcessEnv?: boolean
  optimizeDeps: DepOptimizationOptions
  dev: ResolvedDevEnvironmentOptions
  build: ResolvedBuildEnvironmentOptions
  plugins: readonly Plugin[]
  /** @internal */
  optimizeDepsPluginNames: string[]
}

export type DefaultEnvironmentOptions = Omit<
  EnvironmentOptions,
  'consumer' | 'resolve' | 'keepProcessEnv'
> & {
  resolve?: AllResolveOptions
}

export interface UserConfig extends DefaultEnvironmentOptions {
  /**
   * Project root directory. Can be an absolute path, or a path relative from
   * the location of the config file itself.
   * @default process.cwd()
   */
  root?: string
  /**
   * Base public path when served in development or production.
   * @default '/'
   */
  base?: string
  /**
   * Directory to serve as plain static assets. Files in this directory are
   * served and copied to build dist dir as-is without transform. The value
   * can be either an absolute file system path or a path relative to project root.
   *
   * Set to `false` or an empty string to disable copied static assets to build dist dir.
   * @default 'public'
   */
  publicDir?: string | false
  /**
   * Directory to save cache files. Files in this directory are pre-bundled
   * deps or some other cache files that generated by vite, which can improve
   * the performance. You can use `--force` flag or manually delete the directory
   * to regenerate the cache files. The value can be either an absolute file
   * system path or a path relative to project root.
   * Default to `.vite` when no `package.json` is detected.
   * @default 'node_modules/.vite'
   */
  cacheDir?: string
  /**
   * Explicitly set a mode to run in. This will override the default mode for
   * each command, and can be overridden by the command line --mode option.
   */
  mode?: string
  /**
   * Array of vite plugins to use.
   */
  plugins?: PluginOption[]
  /**
   * HTML related options
   */
  html?: HTMLOptions
  /**
   * CSS related options (preprocessors and CSS modules)
   */
  css?: CSSOptions
  /**
   * JSON loading options
   */
  json?: JsonOptions
  /**
   * Transform options to pass to esbuild.
   * Or set to `false` to disable esbuild.
   *
   * @deprecated Use `oxc` option instead.
   */
  esbuild?: ESBuildOptions | false
  /**
   * Transform options to pass to Oxc.
   * Or set to `false` to disable Oxc.
   */
  oxc?: OxcOptions | false
  /**
   * Specify additional picomatch patterns to be treated as static assets.
   */
  assetsInclude?: string | RegExp | (string | RegExp)[]
  /**
   * Builder specific options
   * @experimental
   */
  builder?: BuilderOptions
  /**
   * Server specific options, e.g. host, port, https...
   */
  server?: ServerOptions
  /**
   * Preview specific options, e.g. host, port, https...
   */
  preview?: PreviewOptions
  /**
   * Experimental features
   *
   * Features under this field could change in the future and might NOT follow semver.
   * Please be careful and always pin Vite's version when using them.
   * @experimental
   */
  experimental?: ExperimentalOptions
  /**
   * Options to opt-in to future behavior
   */
  future?: FutureOptions | 'warn'
  /**
   * Legacy options
   *
   * Features under this field only follow semver for patches, they could be removed in a
   * future minor version. Please always pin Vite's version to a minor when using them.
   */
  legacy?: LegacyOptions
  /**
   * Log level.
   * @default 'info'
   */
  logLevel?: LogLevel
  /**
   * Custom logger.
   */
  customLogger?: Logger
  /**
   * @default true
   */
  clearScreen?: boolean
  /**
   * Environment files directory. Can be an absolute path, or a path relative from
   * root.
   * @default root
   */
  envDir?: string | false
  /**
   * Env variables starts with `envPrefix` will be exposed to your client source code via import.meta.env.
   * @default 'VITE_'
   */
  envPrefix?: string | string[]
  /**
   * Worker bundle options
   */
  worker?: {
    /**
     * Output format for worker bundle
     * @default 'iife'
     */
    format?: 'es' | 'iife'
    /**
     * Vite plugins that apply to worker bundle. The plugins returned by this function
     * should be new instances every time it is called, because they are used for each
     * rolldown worker bundling process.
     */
    plugins?: () => PluginOption[]
    /**
     * Alias to `rolldownOptions`.
     * @deprecated Use `rolldownOptions` instead.
     */
    rollupOptions?: Omit<
      RolldownOptions,
      'plugins' | 'input' | 'onwarn' | 'preserveEntrySignatures'
    >
    /**
     * Rolldown options to build worker bundle
     */
    rolldownOptions?: Omit<
      RolldownOptions,
      'plugins' | 'input' | 'onwarn' | 'preserveEntrySignatures'
    >
  }
  /**
   * Dep optimization options
   */
  optimizeDeps?: DepOptimizationOptions
  /**
   * SSR specific options
   * We could make SSROptions be a EnvironmentOptions if we can abstract
   * external/noExternal for environments in general.
   */
  ssr?: SSROptions
  /**
   * Environment overrides
   */
  environments?: Record<string, EnvironmentOptions>
  /**
   * Whether your application is a Single Page Application (SPA),
   * a Multi-Page Application (MPA), or Custom Application (SSR
   * and frameworks with custom HTML handling)
   * @default 'spa'
   */
  appType?: AppType
  /**
   * Enable devtools integration. Ensure that `@vitejs/devtools` is installed as a dependency.
   * This feature is currently supported only in build mode.
   * @experimental
   * @default false
   */
  devtools?: boolean | DevToolsConfig
}

export interface HTMLOptions {
  /**
   * A nonce value placeholder that will be used when generating script/style tags.
   *
   * Make sure that this placeholder will be replaced with a unique value for each request by the server.
   */
  cspNonce?: string
}

export interface FutureOptions {
  removePluginHookHandleHotUpdate?: 'warn'
  removePluginHookSsrArgument?: 'warn'

  removeServerModuleGraph?: 'warn'
  removeServerReloadModule?: 'warn'
  removeServerPluginContainer?: 'warn'
  removeServerHot?: 'warn'
  removeServerTransformRequest?: 'warn'
  removeServerWarmupRequest?: 'warn'

  removeSsrLoadModule?: 'warn'
}

export interface ExperimentalOptions {
  /**
   * Append fake `&lang.(ext)` when queries are specified, to preserve the file extension for following plugins to process.
   *
   * @experimental
   * @default false
   */
  importGlobRestoreExtension?: boolean
  /**
   * Allow finegrain control over assets and public files paths
   *
   * @experimental
   */
  renderBuiltUrl?: RenderBuiltAssetUrl
  /**
   * Enables support of HMR partial accept via `import.meta.hot.acceptExports`.
   *
   * @experimental
   * @default false
   */
  hmrPartialAccept?: boolean
  /**
   * Enable full bundle mode.
   *
   * This is highly experimental.
   *
   * @experimental
   * @default false
   */
  bundledDev?: boolean
}

export interface LegacyOptions {
  /**
   * In Vite 6.0.8 and below, WebSocket server was able to connect from any web pages. However,
   * that could be exploited by a malicious web page.
   *
   * In Vite 6.0.9+, the WebSocket server now requires a token to connect from a web page.
   * But this may break some plugins and frameworks that connects to the WebSocket server
   * on their own. Enabling this option will make Vite skip the token check.
   *
   * **We do not recommend enabling this option unless you are sure that you are fine with
   * that security weakness.**
   */
  skipWebSocketTokenCheck?: boolean
  /**
   * Opt-in to the pre-Vite 8 CJS interop behavior, which was inconsistent.
   *
   * In pre-Vite 8 versions, Vite had inconsistent CJS interop behavior. This was due to
   * the different behavior of esbuild and the Rollup commonjs plugin.
   * Vite 8+ uses Rolldown for both the dependency optimization in dev and the production build,
   * which aligns the behavior to esbuild.
   *
   * See the Vite 8 migration guide for more details.
   */
  inconsistentCjsInterop?: boolean
}

export interface ResolvedWorkerOptions {
  format: 'es' | 'iife'
  plugins: (bundleChain: string[]) => Promise<ResolvedConfig>
  /**
   * @deprecated Use `rolldownOptions` instead.
   */
  rollupOptions: RolldownOptions
  rolldownOptions: RolldownOptions
}

export interface InlineConfig extends UserConfig {
  configFile?: string | false
  /** @experimental */
  configLoader?: 'bundle' | 'runner' | 'native'
  /** @deprecated */
  envFile?: false
  forceOptimizeDeps?: boolean
}

export interface ResolvedConfig extends Readonly<
  Omit<
    UserConfig,
    | 'plugins'
    | 'css'
    | 'json'
    | 'assetsInclude'
    | 'optimizeDeps'
    | 'worker'
    | 'build'
    | 'dev'
    | 'environments'
    | 'experimental'
    | 'future'
    | 'server'
    | 'preview'
    | 'devtools'
  > & {
    configFile: string | undefined
    configFileDependencies: string[]
    inlineConfig: InlineConfig
    root: string
    base: string
    /** @internal */
    decodedBase: string
    /** @internal */
    rawBase: string
    publicDir: string
    cacheDir: string
    command: 'build' | 'serve'
    mode: string
    /** `true` when build or full-bundle mode dev */
    isBundled: boolean
    isWorker: boolean
    // in nested worker bundle to find the main config
    /** @internal */
    mainConfig: ResolvedConfig | null
    /** @internal list of bundle entry id. used to detect recursive worker bundle. */
    bundleChain: string[]
    isProduction: boolean
    envDir: string | false
    env: Record<string, any>
    resolve: Required<ResolveOptions> & {
      alias: Alias[]
    }
    plugins: readonly Plugin[]
    css: ResolvedCSSOptions
    json: Required<JsonOptions>
    /** @deprecated Use `oxc` option instead. */
    esbuild: ESBuildOptions | false
    oxc: OxcOptions | false
    server: ResolvedServerOptions
    dev: ResolvedDevEnvironmentOptions
    /** @experimental */
    builder: ResolvedBuilderOptions | undefined
    build: ResolvedBuildOptions
    devtools: ResolvedDevToolsConfig
    preview: ResolvedPreviewOptions
    ssr: ResolvedSSROptions
    assetsInclude: (file: string) => boolean
    rawAssetsInclude: (string | RegExp)[]
    logger: Logger
    /**
     * Create an internal resolver to be used in special scenarios, e.g.
     * optimizer & handling css `@imports`.
     *
     * This API is deprecated. It only works for the client and ssr
     * environments. The `aliasOnly` option is also not being used anymore.
     * Plugins should move to `createIdResolver(environment.config)` instead.
     *
     * @deprecated Use `createIdResolver` from `vite` instead.
     */
    createResolver: (options?: Partial<InternalResolveOptions>) => ResolveFn
    optimizeDeps: DepOptimizationOptions
    /** @internal */
    packageCache: PackageCache
    worker: ResolvedWorkerOptions
    appType: AppType
    experimental: RequiredExceptFor<ExperimentalOptions, 'renderBuiltUrl'>
    future: FutureOptions | undefined
    environments: Record<string, ResolvedEnvironmentOptions>
    /** @internal injected by legacy plugin */
    isOutputOptionsForLegacyChunks?(
      outputOptions: NormalizedOutputOptions,
    ): boolean
    /**
     * The token to connect to the WebSocket server from browsers.
     *
     * We recommend using `import.meta.hot` rather than connecting
     * to the WebSocket server directly.
     * If you have a usecase that requires connecting to the WebSocket
     * server, please create an issue so that we can discuss.
     *
     * @deprecated
     */
    webSocketToken: string
    /** @internal */
    fsDenyGlob: AnymatchFn
    /** @internal */
    safeModulePaths: Set<string>
    /** @internal */
    [SYMBOL_RESOLVED_CONFIG]: true
  } & PluginHookUtils
> {}

export async function resolveDevToolsConfig(
  config: DevToolsConfig | boolean | undefined,
  host: string | boolean | undefined,
  logger: Logger,
): Promise<ResolvedDevToolsConfig> {
  const isEnabled = config === true || !!(config && config.enabled)
  const resolvedHostname = await resolveHostname(host)
  const fallbackHostname = resolvedHostname.host ?? 'localhost'
  const fallbackConfig = {
    config: {
      host: fallbackHostname,
    },
    enabled: false,
  }
  if (!isEnabled) {
    return fallbackConfig
  }

  try {
    const { normalizeDevToolsConfig } = await import('@vitejs/devtools/config')
    return normalizeDevToolsConfig(config, fallbackHostname)
  } catch (e) {
    logger.error(
      colors.red(
        `Failed to load Vite DevTools config: ${e.message || e.stack}`,
      ),
      { error: e },
    )
    return fallbackConfig
  }
}

// inferred ones are omitted
const configDefaults = Object.freeze({
  define: {},
  dev: {
    warmup: [],
    // preTransformRequests
    /** @experimental */
    sourcemap: { js: true },
    sourcemapIgnoreList: undefined,
    // createEnvironment
    // recoverable
    // moduleRunnerTransform
  },
  build: buildEnvironmentOptionsDefaults,
  resolve: {
    // mainFields
    // conditions

    // 默认值 ['node', 'module-sync']
    externalConditions: [...DEFAULT_EXTERNAL_CONDITIONS],
    // 默认值 ['.mjs','.js','.mts','.ts','.jsx','.tsx','.json',]
    extensions: DEFAULT_EXTENSIONS,
    dedupe: [],
    /** @experimental */
    noExternal: [],
    external: [],
    preserveSymlinks: false,
    tsconfigPaths: false,
    alias: [],
  },

  // root
  base: '/',
  publicDir: 'public',
  // cacheDir
  // mode
  plugins: [],
  html: {
    cspNonce: undefined,
  },
  css: cssConfigDefaults,
  json: {
    namedExports: true,
    stringify: 'auto',
  },
  // esbuild
  assetsInclude: undefined,
  /** @experimental */
  builder: builderOptionsDefaults,
  server: serverConfigDefaults,
  preview: {
    port: DEFAULT_PREVIEW_PORT,
    // strictPort
    // host
    // https
    // open
    // proxy
    // cors
    // headers
  },
  /** @experimental */
  experimental: {
    importGlobRestoreExtension: false,
    renderBuiltUrl: undefined,
    hmrPartialAccept: false,
    bundledDev: false,
  },
  future: {
    removePluginHookHandleHotUpdate: undefined,
    removePluginHookSsrArgument: undefined,
    removeServerModuleGraph: undefined,
    removeServerHot: undefined,
    removeServerTransformRequest: undefined,
    removeServerWarmupRequest: undefined,
    removeSsrLoadModule: undefined,
  },
  legacy: {
    skipWebSocketTokenCheck: false,
  },
  logLevel: 'info',
  customLogger: undefined,
  clearScreen: true,
  envDir: undefined,
  envPrefix: 'VITE_',
  worker: {
    format: 'iife',
    plugins: (): never[] => [],
    // rollupOptions
  },
  optimizeDeps: {
    include: [],
    exclude: [],
    needsInterop: [],
    // esbuildOptions
    rolldownOptions: {},
    /** @experimental */
    extensions: [],
    /** @deprecated @experimental */
    disabled: 'build',
    // noDiscovery
    /** @experimental */
    holdUntilCrawlEnd: true,
    // entries
    /** @experimental */
    force: false,
    /** @experimental */
    ignoreOutdatedRequests: false,
  },
  ssr: ssrConfigDefaults,
  environments: {},
  appType: 'spa',
} satisfies UserConfig)

export function resolveDevEnvironmentOptions(
  dev: DevEnvironmentOptions | undefined,
  environmentName: string | undefined,
  consumer: 'client' | 'server' | undefined,
  // Backward compatibility
  preTransformRequest?: boolean,
): ResolvedDevEnvironmentOptions {
  const resolved = mergeWithDefaults(
    {
      ...configDefaults.dev,
      sourcemapIgnoreList: isInNodeModules,
      preTransformRequests: preTransformRequest ?? consumer === 'client',
      createEnvironment:
        environmentName === 'client'
          ? defaultCreateClientDevEnvironment
          : defaultCreateDevEnvironment,
      recoverable: consumer === 'client',
      moduleRunnerTransform: consumer === 'server',
    },
    dev ?? {},
  )
  return {
    ...resolved,
    sourcemapIgnoreList:
      resolved.sourcemapIgnoreList === false
        ? () => false
        : resolved.sourcemapIgnoreList,
  }
}

function resolveEnvironmentOptions(
  options: EnvironmentOptions,
  alias: Alias[],
  preserveSymlinks: boolean,
  forceOptimizeDeps: boolean | undefined,
  logger: Logger,
  environmentName: string,
  isBundledDev: boolean,
  // Backward compatibility
  isSsrTargetWebworkerSet?: boolean,
  preTransformRequests?: boolean,
): ResolvedEnvironmentOptions {
  const isClientEnvironment = environmentName === 'client'
  const consumer =
    options.consumer ?? (isClientEnvironment ? 'client' : 'server')
  const isSsrTargetWebworkerEnvironment =
    isSsrTargetWebworkerSet && environmentName === 'ssr'

  if (options.define?.['process.env']) {
    const processEnvDefine = options.define['process.env']
    if (typeof processEnvDefine === 'object') {
      const pathKey = Object.entries(processEnvDefine).find(
        // check with toLowerCase() to match with `Path` / `PATH` (Windows uses `Path`)
        ([key, value]) => key.toLowerCase() === 'path' && !!value,
      )?.[0]
      if (pathKey) {
        logger.warnOnce(
          colors.yellow(
            `The \`define\` option contains an object with ${JSON.stringify(pathKey)} for "process.env" key. ` +
              'It looks like you may have passed the entire `process.env` object to `define`, ' +
              'which can unintentionally expose all environment variables. ' +
              'This poses a security risk and is discouraged.',
          ),
        )
      }
    }
  }

  const resolve = resolveEnvironmentResolveOptions(
    options.resolve,
    alias,
    preserveSymlinks,
    logger,
    consumer,
    isSsrTargetWebworkerEnvironment,
  )
  return {
    define: options.define,
    resolve,
    keepProcessEnv:
      options.keepProcessEnv ??
      (isSsrTargetWebworkerEnvironment ? false : consumer === 'server'),
    consumer,
    optimizeDeps: resolveDepOptimizationOptions(
      options.optimizeDeps,
      resolve.preserveSymlinks,
      forceOptimizeDeps,
      consumer,
      logger,
    ),
    dev: resolveDevEnvironmentOptions(
      options.dev,
      environmentName,
      consumer,
      preTransformRequests,
    ),
    build: resolveBuildEnvironmentOptions(
      options.build ?? {},
      logger,
      consumer,
      isBundledDev,
    ),
    plugins: undefined!, // to be resolved later
    // will be set by `setOptimizeDepsPluginNames` later
    optimizeDepsPluginNames: undefined!,
  }
}

/**
 * 获取默认环境选项
 * @param config 用户配置
 * @returns 默认环境选项
 */
export function getDefaultEnvironmentOptions(
  config: UserConfig,
): EnvironmentOptions {
  return {
    // define 是全局常量替换，通常所有环境共享相同的定义
    define: config.define,
    resolve: {
      // 从顶层 resolve 中拷贝所有字段
      ...config.resolve,
      // mainFields and conditions are not inherited
      // 忽略顶层的 mainFields 和 conditions 字段
      mainFields: undefined,
      conditions: undefined,
    },
    dev: config.dev, // 从顶层 dev 中拷贝所有字段
    build: config.build, // 从顶层 build 中拷贝所有字段
  }
}

export interface PluginHookUtils {
  getSortedPlugins: <K extends keyof Plugin>(
    hookName: K,
  ) => PluginWithRequiredHook<K>[]
  getSortedPluginHooks: <K extends keyof Plugin>(
    hookName: K,
  ) => NonNullable<HookHandler<Plugin[K]>>[]
}

export type ResolveFn = (
  id: string,
  importer?: string,
  aliasOnly?: boolean,
  ssr?: boolean,
) => Promise<string | undefined>

/**
 * Check and warn if `path` includes characters that don't work well in Vite,
 * such as `#` and `?` and `*`.
 */
function checkBadCharactersInPath(
  name: string,
  path: string,
  logger: Logger,
): void {
  const badChars = []

  if (path.includes('#')) {
    badChars.push('#')
  }
  if (path.includes('?')) {
    badChars.push('?')
  }
  if (path.includes('*')) {
    badChars.push('*')
  }

  if (badChars.length > 0) {
    const charString = badChars.map((c) => `"${c}"`).join(' and ')
    const inflectedChars = badChars.length > 1 ? 'characters' : 'character'

    logger.warn(
      colors.yellow(
        `${name} contains the ${charString} ${inflectedChars} (${colors.cyan(
          path,
        )}), which may not work when running Vite. Consider renaming the directory / file to remove the characters.`,
      ),
    )
  }
}

// 于开发服务器的别名解析规则，
// 主要目的是将浏览器中请求的虚拟模块（如 /@vite/env 和 /@vite/client）映射到实际的磁盘文件入口。
const clientAlias = [
  {
    find: /^\/?@vite\/env/,
    // FS_PREFIX（通常是 '/@fs/'）是 Vite 内部用于存储虚拟模块的前缀
    // dist/client/env.mjs
    replacement: path.posix.join(FS_PREFIX, normalizePath(ENV_ENTRY)),
  },
  {
    find: /^\/?@vite\/client/,
    // dist/client/client.mjs
    replacement: path.posix.join(FS_PREFIX, normalizePath(CLIENT_ENTRY)),
  },
]

/**
 * alias and preserveSymlinks are not per-environment options, but they are
 * included in the resolved environment options for convenience.
 */
/**
 *
 * @param resolve
 * @param alias
 * @param preserveSymlinks
 * @param logger
 * @param consumer
 * @param isSsrTargetWebworkerEnvironment
 * @returns
 */
function resolveEnvironmentResolveOptions(
  resolve: EnvironmentResolveOptions | undefined,
  alias: Alias[],
  preserveSymlinks: boolean,
  logger: Logger,
  /** undefined when resolving the top-level resolve options */
  consumer: 'client' | 'server' | undefined,
  // Backward compatibility
  isSsrTargetWebworkerEnvironment?: boolean,
): ResolvedAllResolveOptions {
  // 合并用户配置的 resolve 选项与默认 resolve 选项
  const resolvedResolve: ResolvedAllResolveOptions = mergeWithDefaults(
    {
      // 从顶层 resolve 中拷贝所有字段
      ...configDefaults.resolve,

      // 尝试解析字段
      // 注意：这比从 exports 字段解析的条件导出优先级低：如果一个入口起点从 exports 成功解析，resolve.mainFields 将被忽略。
      mainFields:
        consumer === undefined ||
        consumer === 'client' ||
        isSsrTargetWebworkerEnvironment
          ? // 默认值 ['browser', 'module', 'jsnext:main', 'jsnext']
            DEFAULT_CLIENT_MAIN_FIELDS
          : // 默认值 ['module', 'jsnext:main', 'jsnext']
            DEFAULT_SERVER_MAIN_FIELDS,

      conditions:
        consumer === undefined ||
        consumer === 'client' ||
        isSsrTargetWebworkerEnvironment
          ? // 默认值 ['module', 'browser', 'development|production']
            DEFAULT_CLIENT_CONDITIONS
          : // 默认值 ['module', 'node', 'development|production']
            DEFAULT_SERVER_CONDITIONS.filter((c) => c !== 'browser'),

      builtins:
        resolve?.builtins ??
        (consumer === 'server'
          ? isSsrTargetWebworkerEnvironment && resolve?.noExternal === true
            ? []
            : nodeLikeBuiltins // 是否非node 内置模块
          : []),
    },
    resolve ?? {},
  )
  resolvedResolve.preserveSymlinks = preserveSymlinks
  resolvedResolve.alias = alias

  if (
    // 检查用户配置中是否显式设置了 browserField: false
    // 该字段已不存在，因此 TypeScript 会报错，用 @ts-expect-error 忽略
    // @ts-expect-error removed field
    resolve?.browserField === false &&
    // 检查当前解析后的 mainFields 是否仍然包含 'browser' 字段
    resolvedResolve.mainFields.includes('browser')
  ) {
    // 如果用户原先想禁用浏览器字段（browserField: false），
    // 但当前 mainFields 中仍有 'browser'，则说明配置不一致，需要更新。
    logger.warn(
      colors.yellow(
        `\`resolve.browserField\` is set to false, but the option is removed in favour of ` +
          `the 'browser' string in \`resolve.mainFields\`. You may want to update \`resolve.mainFields\` ` +
          `to remove the 'browser' string and preserve the previous browser behaviour.`,
      ),
    )
  }
  return resolvedResolve
}

/**
 * 解析 resolve 选项
 * @param resolve 用户配置的 resolve 选项
 * @param logger 日志记录器
 * @returns 解析后的 resolve 选项
 */
function resolveResolveOptions(
  resolve: AllResolveOptions | undefined,
  logger: Logger,
): ResolvedAllResolveOptions {
  // resolve alias with internal client alias
  // 合并用户配置的 alias 与默认 alias
  const alias = normalizeAlias(
    mergeAlias(clientAlias, resolve?.alias || configDefaults.resolve.alias),
  )
  // 合并用户配置的 preserveSymlinks 与默认 preserveSymlinks
  const preserveSymlinks =
    resolve?.preserveSymlinks ?? configDefaults.resolve.preserveSymlinks

  // 警告用户移除 alias 中的根目录映射
  if (alias.some((a) => a.find === '/')) {
    // 为什么需要警告？
    // 1、干扰绝对路径解析
    // 2、影响内置模块和第三方库
    // 3、与 Vite 内部处理冲突

    // 建议：使用更具体的别名：例如 '/@' 映射到 src 目录，而不是直接用 '/'。
    logger.warn(
      colors.yellow(
        `\`resolve.alias\` contains an alias that maps \`/\`. ` +
          `This is not recommended as it can cause unexpected behavior when resolving paths.`,
      ),
    )
  }
  // 警告用户移除 alias 中的 customResolver 选项，因为已被废弃
  if (alias.some((a) => a.customResolver)) {
    // 为什么弃用 customResolver？
    // 1、功能重叠：customResolver 的功能完全可以通过 Vite 插件（或 Rollup 插件）的 resolveId 钩子实现，且插件系统更加标准化、可组合。
    // 2、复杂性：在别名配置中嵌入解析逻辑增加了配置的复杂度，且难以调试和维护。
    // 3、性能与缓存：插件系统能够更好地与 Vite 的模块图缓存集成，而 customResolver 可能绕过一些内部优化。
    // 4、统一 API：Vite 致力于简化配置，将高级定制能力收敛到插件 API，使核心配置更清晰。

    // 建议：
    // 创建插件：实现 resolveId 钩子，并设置 enforce: 'pre' 确保它在 Vite 内置解析器之前执行
    logger.warn(
      colors.yellow(
        `\`resolve.alias\` contains an alias with \`customResolver\` option. ` +
          `This is deprecated and will be removed in Vite 9. ` +
          `Please use a custom plugin with a resolveId hook and \`enforce: 'pre'\` instead.`,
      ),
    )
  }

  return resolveEnvironmentResolveOptions(
    resolve,
    alias,
    preserveSymlinks,
    logger,
    undefined,
  )
}

// TODO: Introduce ResolvedDepOptimizationOptions
function resolveDepOptimizationOptions(
  optimizeDeps: DepOptimizationOptions | undefined,
  preserveSymlinks: boolean,
  forceOptimizeDeps: boolean | undefined,
  consumer: 'client' | 'server' | undefined,
  logger: Logger,
): DepOptimizationOptions {
  if (
    optimizeDeps?.rolldownOptions &&
    optimizeDeps?.rolldownOptions === optimizeDeps?.rollupOptions
  ) {
    delete optimizeDeps?.rollupOptions
  }
  const merged = mergeWithDefaults(
    {
      ...configDefaults.optimizeDeps,
      disabled: undefined, // do not set here to avoid deprecation warning
      noDiscovery: consumer !== 'client',
      force: forceOptimizeDeps ?? configDefaults.optimizeDeps.force,
    },
    optimizeDeps ?? {},
  )
  setupRollupOptionCompat(merged, 'optimizeDeps')

  const rolldownOptions = merged.rolldownOptions as Exclude<
    DepOptimizationOptions['rolldownOptions'],
    undefined
  >

  if (merged.esbuildOptions && Object.keys(merged.esbuildOptions).length > 0) {
    logger.warn(
      colors.yellow(
        `You or a plugin you are using have set \`optimizeDeps.esbuildOptions\` ` +
          `but this option is now deprecated. ` +
          `Vite now uses Rolldown to optimize the dependencies. ` +
          `Please use \`optimizeDeps.rolldownOptions\` instead.`,
      ),
    )

    rolldownOptions.resolve ??= {}
    rolldownOptions.output ??= {}
    rolldownOptions.transform ??= {}

    const setResolveOptions = <
      T extends keyof Exclude<RolldownOptions['resolve'], undefined>,
    >(
      key: T,
      value: Exclude<RolldownOptions['resolve'], undefined>[T],
    ) => {
      if (value !== undefined && rolldownOptions.resolve![key] === undefined) {
        rolldownOptions.resolve![key] = value
      }
    }

    if (
      merged.esbuildOptions.minify !== undefined &&
      rolldownOptions.output.minify === undefined
    ) {
      rolldownOptions.output.minify = merged.esbuildOptions.minify
    }
    if (
      merged.esbuildOptions.treeShaking !== undefined &&
      rolldownOptions.treeshake === undefined
    ) {
      rolldownOptions.treeshake = merged.esbuildOptions.treeShaking
    }
    if (
      merged.esbuildOptions.define !== undefined &&
      rolldownOptions.transform.define === undefined
    ) {
      rolldownOptions.transform.define = merged.esbuildOptions.define
    }
    if (merged.esbuildOptions.loader !== undefined) {
      const loader = merged.esbuildOptions.loader
      rolldownOptions.moduleTypes ??= {}
      for (const [key, value] of Object.entries(loader)) {
        if (
          rolldownOptions.moduleTypes[key] === undefined &&
          value !== 'copy' &&
          value !== 'css' &&
          value !== 'default' &&
          value !== 'file' &&
          value !== 'local-css'
        ) {
          rolldownOptions.moduleTypes[key] = value
        }
      }
    }
    if (
      merged.esbuildOptions.preserveSymlinks !== undefined &&
      rolldownOptions.resolve.symlinks === undefined
    ) {
      rolldownOptions.resolve.symlinks = !merged.esbuildOptions.preserveSymlinks
    }
    setResolveOptions('extensions', merged.esbuildOptions.resolveExtensions)
    setResolveOptions('mainFields', merged.esbuildOptions.mainFields)
    setResolveOptions('conditionNames', merged.esbuildOptions.conditions)
    if (
      merged.esbuildOptions.keepNames !== undefined &&
      rolldownOptions.output.keepNames === undefined
    ) {
      rolldownOptions.output.keepNames = merged.esbuildOptions.keepNames
    }

    if (
      merged.esbuildOptions.platform !== undefined &&
      rolldownOptions.platform === undefined
    ) {
      rolldownOptions.platform = merged.esbuildOptions.platform
    }

    // NOTE: the following options cannot be converted
    // - legalComments
    // - target, supported (Vite used to transpile down to `ESBUILD_MODULES_TARGET`)
    // - ignoreAnnotations
    // - jsx, jsxFactory, jsxFragment, jsxImportSource, jsxDev, jsxSideEffects
    // - tsconfigRaw, tsconfig

    // NOTE: the following options can be converted but probably not worth it
    // - sourceRoot
    // - sourcesContent (`output.sourcemapExcludeSources` is not supported by rolldown)
    // - drop
    // - dropLabels
    // - mangleProps, reserveProps, mangleQuoted, mangleCache
    // - minifyWhitespace, minifyIdentifiers, minifySyntax
    // - lineLimit
    // - charset
    // - pure (`treeshake.manualPureFunctions` is not supported by rolldown)
    // - alias (it probably does not work the same with `resolve.alias`)
    // - inject
    // - banner, footer
    // - nodePaths

    // NOTE: the following options does not make sense to set / convert it
    // - globalName (we only use ESM format)
    // - color
    // - logLimit
    // - logOverride
    // - splitting
    // - outbase
    // - packages (this should not be set)
    // - allowOverwrite
    // - publicPath (`file` loader is not supported by rolldown)
    // - entryNames, chunkNames, assetNames (Vite does not support changing these options)
    // - stdin
    // - absWorkingDir
  }

  merged.esbuildOptions ??= {}
  merged.esbuildOptions.preserveSymlinks ??= preserveSymlinks

  rolldownOptions.resolve ??= {}
  rolldownOptions.resolve.symlinks ??= !preserveSymlinks
  rolldownOptions.output ??= {}
  rolldownOptions.output.topLevelVar ??= true

  return merged
}

async function setOptimizeDepsPluginNames(resolvedConfig: ResolvedConfig) {
  await Promise.all(
    Object.values(resolvedConfig.environments).map(async (environment) => {
      const plugins = environment.optimizeDeps.rolldownOptions?.plugins ?? []
      const outputPlugins =
        environment.optimizeDeps.rolldownOptions?.output?.plugins ?? []
      const flattenedPlugins = await asyncFlatten([plugins, outputPlugins])

      const pluginNames = []
      for (const plugin of flattenedPlugins) {
        if (plugin && 'name' in plugin) {
          pluginNames.push(plugin.name)
        }
      }
      environment.optimizeDepsPluginNames = pluginNames
    }),
  )
}

function applyDepOptimizationOptionCompat(resolvedConfig: ResolvedConfig) {
  if (
    resolvedConfig.optimizeDeps.esbuildOptions?.plugins &&
    resolvedConfig.optimizeDeps.esbuildOptions.plugins.length > 0
  ) {
    resolvedConfig.optimizeDeps.rolldownOptions ??= {}
    resolvedConfig.optimizeDeps.rolldownOptions.plugins ||= []
    ;(resolvedConfig.optimizeDeps.rolldownOptions.plugins as any[]).push(
      ...resolvedConfig.optimizeDeps.esbuildOptions.plugins.map((plugin) =>
        convertEsbuildPluginToRolldownPlugin(plugin),
      ),
    )
  }
}

/**
 * 检查配置对象是否为已解析配置对象
 * @param inlineConfig 配置对象
 * @returns 是否为已解析配置对象
 */
export function isResolvedConfig(
  inlineConfig: InlineConfig | ResolvedConfig,
): inlineConfig is ResolvedConfig {
  return (
    SYMBOL_RESOLVED_CONFIG in inlineConfig &&
    inlineConfig[SYMBOL_RESOLVED_CONFIG]
  )
}

/**
 * 解析配置对象
 *
 * @param inlineConfig 内联配置对象
 * @param command 命令类型
 * @param defaultMode 默认模式
 * @param defaultNodeEnv 默认 Node 环境
 * @param isPreview 是否为预览模式
 * @param patchConfig 配置对象修补函数
 * @param patchPlugins 插件修补函数
 * @param plugins 插件数组
 * @returns
 */
export async function resolveConfig(
  inlineConfig: InlineConfig,
  command: 'build' | 'serve', // 确保是 build 或 serve 命令
  defaultMode = 'development',
  defaultNodeEnv = 'development',
  isPreview = false,
  /** @internal */
  patchConfig: ((config: ResolvedConfig) => void) | undefined = undefined,
  /** @internal */
  patchPlugins: ((resolvedPlugins: Plugin[]) => void) | undefined = undefined,
): Promise<ResolvedConfig> {
  let config = inlineConfig
  config.build ??= {} // 保证配置一定存在，防止后续读取属性时报错
  // 兼容 build.rollupOptions 等废弃写法
  setupRollupOptionCompat(config.build, 'build')

  config.worker ??= {}
  setupRollupOptionCompat(config.worker, 'worker') // 处理 Web Worker 编译配置

  config.optimizeDeps ??= {}
  setupRollupOptionCompat(config.optimizeDeps, 'optimizeDeps') // 处理依赖优化配置

  if (config.ssr) {
    config.ssr.optimizeDeps ??= {}
    // 处理 SSR 环境的依赖预构建
    setupRollupOptionCompat(config.ssr.optimizeDeps, 'ssr.optimizeDeps')
  }

  let configFileDependencies: string[] = []
  // 初始化模式
  let mode = inlineConfig.mode || defaultMode
  // 检查是否设置了 NODE_ENV 环境变量
  const isNodeEnvSet = !!process.env.NODE_ENV
  // 初始化包缓存
  const packageCache: PackageCache = new Map()

  // some dependencies e.g. @vue/compiler-* relies on NODE_ENV for getting
  // production-specific behavior, so set it early on
  // 如果未设置 NODE_ENV 环境变量，则设置为默认值
  if (!isNodeEnvSet) {
    process.env.NODE_ENV = defaultNodeEnv
  }

  // 初始化配置环境对象
  const configEnv: ConfigEnv = {
    mode,
    command,
    isSsrBuild: command === 'build' && !!config.build?.ssr,
    isPreview,
  }

  let { configFile } = config
  if (configFile !== false) {
    // 从文件加载配置
    const loadResult = await loadConfigFromFile(
      configEnv,
      configFile,
      config.root,
      config.logLevel,
      config.customLogger,
      config.configLoader,
    )
    if (loadResult) {
      config = mergeConfig(loadResult.config, config)
      configFile = loadResult.path
      configFileDependencies = loadResult.dependencies
    }
  }

  // user config may provide an alternative mode. But --mode has a higher priority
  // 内联配置模式 > 配置文件模式 > 默认模式
  mode = inlineConfig.mode || config.mode || mode
  configEnv.mode = mode

  const filterPlugin = (p: Plugin | FalsyPlugin): p is Plugin => {
    if (!p) {
      return false
    } else if (!p.apply) {
      return true
    } else if (typeof p.apply === 'function') {
      return p.apply({ ...config, mode }, configEnv)
    } else {
      return p.apply === command
    }
  }

  // resolve plugins
  // 过滤出符合命令的插件
  const rawPlugins = (await asyncFlatten(config.plugins || [])).filter(
    filterPlugin,
  )

  // 插件排序
  const [prePlugins, normalPlugins, postPlugins] = sortUserPlugins(rawPlugins)

  const isBuild = command === 'build' // 是否是构建命令

  // run config hooks
  const userPlugins = [...prePlugins, ...normalPlugins, ...postPlugins]
  config = await runConfigHook(config, userPlugins, configEnv)

  // Ensure default client and ssr environments
  // If there are present, ensure order { client, ssr, ...custom }
  // 初始化环境对象
  config.environments ??= {}
  // 没有ssr环境，且不是构建命令，且没有配置ssr环境，且没有配置ssr环境的依赖
  if (
    !config.environments.ssr &&
    (!isBuild || config.ssr || config.build?.ssr)
  ) {
    // During dev, the ssr environment is always available even if it isn't configure
    // There is no perf hit, because the optimizer is initialized only if ssrLoadModule
    // is called.
    // During build, we only build the ssr environment if it is configured
    // through the deprecated ssr top level options or if it is explicitly defined
    // in the environments config
    config.environments = { ssr: {}, ...config.environments }
  }
  if (!config.environments.client) {
    config.environments = { client: {}, ...config.environments }
  }

  // Define logger
  const logger = createLogger(config.logLevel, {
    allowClearScreen: config.clearScreen,
    customLogger: config.customLogger,
  })

  // resolve root
  const resolvedRoot = normalizePath(
    config.root ? path.resolve(config.root) : process.cwd(),
  )

  checkBadCharactersInPath('The project root', resolvedRoot, logger)

  // 初始化客户端环境
  const configEnvironmentsClient = config.environments!.client!
  configEnvironmentsClient.dev ??= {}

  const deprecatedSsrOptimizeDepsConfig = config.ssr?.optimizeDeps ?? {}

  // 初始化SSR环境
  let configEnvironmentsSsr = config.environments!.ssr

  // Backward compatibility: server.warmup.clientFiles/ssrFiles -> environment.dev.warmup
  // 处理预热选项
  const warmupOptions = config.server?.warmup
  if (warmupOptions?.clientFiles) {
    // 处理客户端预热选项
    configEnvironmentsClient.dev.warmup = warmupOptions.clientFiles
  }
  if (warmupOptions?.ssrFiles) {
    configEnvironmentsSsr ??= {}
    configEnvironmentsSsr.dev ??= {}
    // 处理SSR预热选项
    configEnvironmentsSsr.dev.warmup = warmupOptions.ssrFiles
  }

  // Backward compatibility: merge ssr into environments.ssr.config as defaults
  if (configEnvironmentsSsr) {
    configEnvironmentsSsr.optimizeDeps = mergeConfig(
      deprecatedSsrOptimizeDepsConfig,

      configEnvironmentsSsr.optimizeDeps ?? {},
    )

    // merge with `resolve` as the root to merge `noExternal` correctly
    configEnvironmentsSsr.resolve = mergeConfig(
      {
        resolve: {
          conditions: config.ssr?.resolve?.conditions,
          externalConditions: config.ssr?.resolve?.externalConditions,
          mainFields: config.ssr?.resolve?.mainFields,
          external: config.ssr?.external,
          noExternal: config.ssr?.noExternal,
        },
      } satisfies EnvironmentOptions,
      {
        resolve: configEnvironmentsSsr.resolve ?? {},
      },
    ).resolve
  }

  // 处理SSR环境的资产输出选项
  if (config.build?.ssrEmitAssets !== undefined) {
    configEnvironmentsSsr ??= {}
    configEnvironmentsSsr.build ??= {}
    configEnvironmentsSsr.build.emitAssets = config.build.ssrEmitAssets
  }

  // The client and ssr environment configs can't be removed by the user in the config hook
  if (!config.environments.client || (!config.environments.ssr && !isBuild)) {
    throw new Error(
      'Required environments configuration were stripped out in the config hook',
    )
  }

  // Merge default environment config values
  const defaultEnvironmentOptions = getDefaultEnvironmentOptions(config)

  // Some top level options only apply to the client environment
  const defaultClientEnvironmentOptions: UserConfig = {
    ...defaultEnvironmentOptions,
    resolve: config.resolve, // inherit everything including mainFields and conditions
    optimizeDeps: config.optimizeDeps,
  }
  const defaultNonClientEnvironmentOptions: UserConfig = {
    ...defaultEnvironmentOptions,
    dev: {
      ...defaultEnvironmentOptions.dev,
      createEnvironment: undefined,
      warmup: undefined,
    },
    build: {
      ...defaultEnvironmentOptions.build,
      createEnvironment: undefined,
    },
  }

  for (const name of Object.keys(config.environments)) {
    config.environments[name] = mergeConfig(
      name === 'client'
        ? defaultClientEnvironmentOptions
        : defaultNonClientEnvironmentOptions,
      config.environments[name],
    )
  }

  await runConfigEnvironmentHook(
    config.environments,
    userPlugins,
    logger,
    configEnv,
    config.ssr?.target === 'webworker',
  )

  // 是否开启捆绑开发模式
  const isBundledDev = command === 'serve' && !!config.experimental?.bundledDev

  // Backward compatibility: merge config.environments.client.resolve back into config.resolve
  config.resolve ??= {}
  config.resolve.conditions = config.environments.client.resolve?.conditions
  config.resolve.mainFields = config.environments.client.resolve?.mainFields

  const resolvedDefaultResolve = resolveResolveOptions(config.resolve, logger)

  const resolvedEnvironments: Record<string, ResolvedEnvironmentOptions> = {}
  for (const environmentName of Object.keys(config.environments)) {
    resolvedEnvironments[environmentName] = resolveEnvironmentOptions(
      config.environments[environmentName],
      resolvedDefaultResolve.alias,
      resolvedDefaultResolve.preserveSymlinks,
      inlineConfig.forceOptimizeDeps,
      logger,
      environmentName,
      isBundledDev,
      config.ssr?.target === 'webworker',
      config.server?.preTransformRequests,
    )
  }

  // Backward compatibility: merge environments.client.optimizeDeps back into optimizeDeps
  // The same object is assigned back for backward compatibility. The ecosystem is modifying
  // optimizeDeps in the ResolvedConfig hook, so these changes will be reflected on the
  // client environment.
  const backwardCompatibleOptimizeDeps =
    resolvedEnvironments.client.optimizeDeps

  const resolvedDevEnvironmentOptions = resolveDevEnvironmentOptions(
    config.dev,
    // default environment options
    undefined,
    undefined,
  )

  const resolvedBuildOptions = resolveBuildEnvironmentOptions(
    config.build ?? {},
    logger,
    undefined,
    isBundledDev,
  )

  // Backward compatibility: merge config.environments.ssr back into config.ssr
  // so ecosystem SSR plugins continue to work if only environments.ssr is configured
  // SSR（服务端渲染）环境配置
  const patchedConfigSsr = {
    ...config.ssr, // 继承所有选项
    // 覆盖 external，指定哪些模块不应被打包
    external: resolvedEnvironments.ssr?.resolve.external,
    // 覆盖 noExternal，强制将某些模块打包
    noExternal: resolvedEnvironments.ssr?.resolve.noExternal,
    // 覆盖 optimizeDeps
    optimizeDeps: resolvedEnvironments.ssr?.optimizeDeps,
    resolve: {
      // 继承全局 resolve 选项
      ...config.ssr?.resolve,
      // 覆盖 conditions，指定模块解析时的导出条件
      conditions: resolvedEnvironments.ssr?.resolve.conditions,
      // 覆盖 externalConditions，用于判断一个模块是否应当被 external 化时的额外条件
      externalConditions: resolvedEnvironments.ssr?.resolve.externalConditions,
    },
  }
  const ssr = resolveSSROptions(
    patchedConfigSsr,
    // 表示模块解析时是否保留符号链接的原始路径
    resolvedDefaultResolve.preserveSymlinks,
  )

  // load .env files
  // Backward compatibility: set envDir to false when envFile is false
  // envDir 用于加载 .env 文件的目录
  let envDir = config.envFile === false ? false : config.envDir
  if (envDir !== false) {
    envDir = config.envDir
      ? normalizePath(path.resolve(resolvedRoot, config.envDir))
      : resolvedRoot
  }

  const userEnv = loadEnv(mode, envDir, resolveEnvPrefix(config))

  // Note it is possible for user to have a custom mode, e.g. `staging` where
  // development-like behavior is expected. This is indicated by NODE_ENV=development
  // loaded from `.staging.env` and set by us as VITE_USER_NODE_ENV
  // 防止用户在 .env 文件中随意设置 NODE_ENV 导致开发模式异常

  // 一个特殊变量 VITE_USER_NODE_ENV（注意不是 NODE_ENV）。
  // 用户如果想影响 process.env.NODE_ENV，需要通过这个自定义变量间接设置
  const userNodeEnv = process.env.VITE_USER_NODE_ENV

  // !isNodeEnvSet：检查 process.env.NODE_ENV 是否尚未被设置

  // 用户定义了 VITE_USER_NODE_ENV 且当前 NODE_ENV 未设置
  if (!isNodeEnvSet && userNodeEnv) {
    if (userNodeEnv === 'development') {
      // 若值为 'development'，则将 process.env.NODE_ENV 设置为 'development'
      process.env.NODE_ENV = 'development'
    } else {
      // NODE_ENV=production is not supported as it could break HMR in dev for frameworks like Vue
      // 输出警告，不修改 NODE_ENV
      // 为什么限制？
      // 许多库（包括 Vue、React）会根据 NODE_ENV 决定是否启用开发工具、详细警告、热更新（HMR）等
      logger.warn(
        `NODE_ENV=${userNodeEnv} is not supported in the .env file. ` +
          `Only NODE_ENV=development is supported to create a development build of your project. ` +
          `If you need to set process.env.NODE_ENV, you can set it in the Vite config instead.`,
      )
    }
  }

  // 是否为生产环境
  const isProduction = process.env.NODE_ENV === 'production'

  // resolve public base url
  // 判断是否相对路径简写
  // 空字符串 ''（Vite 3+ 中默认值）或 './'（显式相对路径）
  const relativeBaseShortcut = config.base === '' || config.base === './'

  // During dev, we ignore relative base and fallback to '/'
  // For the SSR build, relative base isn't possible by means
  // of import.meta.url.
  const resolvedBase = relativeBaseShortcut
    ? !isBuild || config.build?.ssr
      ? // 原因：开发服务器必须使用绝对路径（/），因为无法预先知道客户端访问的最终 URL；
        //  SSR 构建时，import.meta.url 无法可靠处理相对路径，故也回退到根路径。
        '/' // 开发模式或 SSR 构建，返回 /
      : // 允许使用相对路径，这样构建后的资源引用可以相对于当前 HTML 文件，便于部署到任意子目录
        './' // 生产模式且非 SSR 构建，返回 './'
    : resolveBaseUrl(config.base, isBuild, logger)

  // resolve cache directory
  const pkgDir = findNearestPackageData(resolvedRoot, packageCache)?.dir
  const cacheDir = normalizePath(
    config.cacheDir
      ? path.resolve(resolvedRoot, config.cacheDir)
      : pkgDir
        ? path.join(pkgDir, `node_modules/.vite`)
        : path.join(resolvedRoot, `.vite`),
  )

  const assetsFilter =
    config.assetsInclude &&
    (!Array.isArray(config.assetsInclude) || config.assetsInclude.length)
      ? createFilter(config.assetsInclude)
      : () => false

  const { publicDir } = config
  const resolvedPublicDir =
    publicDir !== false && publicDir !== ''
      ? normalizePath(
          path.resolve(
            resolvedRoot,
            typeof publicDir === 'string'
              ? publicDir
              : configDefaults.publicDir,
          ),
        )
      : ''

  const server = await resolveServerOptions(resolvedRoot, config.server, logger)

  const builder = resolveBuilderOptions(config.builder)

  const BASE_URL = resolvedBase

  const resolvedConfigContext = new BasicMinimalPluginContext(
    {
      ...basePluginContextMeta,
      watchMode:
        (command === 'serve' && !isPreview) ||
        (command === 'build' && !!resolvedBuildOptions.watch),
    } satisfies PluginContextMeta,
    logger,
  )

  let resolved: ResolvedConfig

  let createUserWorkerPlugins = config.worker?.plugins
  if (Array.isArray(createUserWorkerPlugins)) {
    // @ts-expect-error backward compatibility
    createUserWorkerPlugins = () => config.worker?.plugins

    logger.warn(
      colors.yellow(
        `worker.plugins is now a function that returns an array of plugins. ` +
          `Please update your Vite config accordingly.\n`,
      ),
    )
  }

  const createWorkerPlugins = async function (bundleChain: string[]) {
    // Some plugins that aren't intended to work in the bundling of workers (doing post-processing at build time for example).
    // And Plugins may also have cached that could be corrupted by being used in these extra rollup calls.
    // So we need to separate the worker plugin from the plugin that vite needs to run.
    const rawWorkerUserPlugins = (
      await asyncFlatten(createUserWorkerPlugins?.() || [])
    ).filter(filterPlugin)

    // resolve worker
    let workerConfig = mergeConfig({}, config)
    const [workerPrePlugins, workerNormalPlugins, workerPostPlugins] =
      sortUserPlugins(rawWorkerUserPlugins)

    // run config hooks
    const workerUserPlugins = [
      ...workerPrePlugins,
      ...workerNormalPlugins,
      ...workerPostPlugins,
    ]
    workerConfig = await runConfigHook(
      workerConfig,
      workerUserPlugins,
      configEnv,
    )

    const workerResolved: ResolvedConfig = {
      ...workerConfig,
      ...resolved,
      isWorker: true,
      mainConfig: resolved,
      bundleChain,
    }

    // Plugins resolution needs the resolved config (minus plugins) so we need to mutate here
    ;(workerResolved.plugins as Plugin[]) = await resolvePlugins(
      workerResolved,
      workerPrePlugins,
      workerNormalPlugins,
      workerPostPlugins,
    )

    // run configResolved hooks
    await Promise.all(
      createPluginHookUtils(workerResolved.plugins)
        .getSortedPluginHooks('configResolved')
        .map((hook) => hook.call(resolvedConfigContext, workerResolved)),
    )

    // Resolve environment plugins after configResolved because there are
    // downstream projects modifying the plugins in it. This may change
    // once the ecosystem is ready.
    // During Build the client environment is used to bundle the worker
    // Avoid overriding the mainConfig (resolved.environments.client)
    ;(workerResolved.environments as Record<
      string,
      ResolvedEnvironmentOptions
    >) = {
      ...workerResolved.environments,
      client: {
        ...workerResolved.environments.client,
        plugins: await resolveEnvironmentPlugins(
          new PartialEnvironment('client', workerResolved),
        ),
      },
    }

    return workerResolved
  }

  const resolvedWorkerOptions: Omit<
    ResolvedWorkerOptions,
    'rolldownOptions'
  > & {
    rolldownOptions: ResolvedWorkerOptions['rolldownOptions'] | undefined
  } = {
    // 从用户配置中读取 worker.format，如果未配置则默认使用 'iife'
    // 在 Vite 早期版本中，Worker 默认以 IIFE 格式输出，以确保兼容性（因为当时部分浏览器对 ES 模块 Worker 支持不完善）
    // 虽然现代浏览器已广泛支持 ES 模块 Worker，但为了保持向后兼容，默认值仍为 'iife'。
    format: config.worker?.format || 'iife',
    plugins: createWorkerPlugins,
    // 从用户配置中读取 worker.rollupOptions，若未提供则默认为空对象
    rollupOptions: config.worker?.rollupOptions || {},
    // 直接取用户配置中的 worker.rolldownOptions，若未提供则默认为 undefined
    rolldownOptions: config.worker?.rolldownOptions, // will be set by setupRollupOptionCompat if undefined
  }
  // 配置 Rollup 选项兼容性
  setupRollupOptionCompat(resolvedWorkerOptions, 'worker')

  // 基础路径，确保以斜杠结尾
  const base = withTrailingSlash(resolvedBase)

  const preview = resolvePreviewOptions(config.preview, server)

  const additionalAllowedHosts = getAdditionalAllowedHosts(server, preview)
  if (Array.isArray(server.allowedHosts)) {
    server.allowedHosts.push(...additionalAllowedHosts)
  }
  if (Array.isArray(preview.allowedHosts)) {
    preview.allowedHosts.push(...additionalAllowedHosts)
  }

  let oxc: OxcOptions | false | undefined = config.oxc

  // esbuild 配置优先于 oxc 配置
  // esbuild 已废弃，建议使用 oxc 配置
  if (config.esbuild) {
    if (config.oxc) {
      logger.warn(
        colors.yellow(
          `Both esbuild and oxc options were set. oxc options will be used and esbuild options will be ignored.`,
        ) +
          ` The following esbuild options were set: \`${inspect(config.esbuild)}\``,
      )
    } else {
      // 将 esbuild 配置转换为 oxc 配置
      oxc = convertEsbuildConfigToOxcConfig(config.esbuild, logger)
    }
  } else if (config.esbuild === false && config.oxc !== false) {
    logger.warn(
      colors.yellow(
        `\`esbuild\` option is set to false, but \`oxc\` option was not set to false. ` +
          `\`esbuild: false\` does not have effect any more. ` +
          `If you want to disable the default transformation, which is now handled by Oxc, please set \`oxc: false\` instead.`,
      ),
    )
  }

  const experimental = mergeWithDefaults(
    configDefaults.experimental,
    config.experimental ?? {},
  )

  // 开发环境，且启用了捆绑开发模式
  if (command === 'serve' && experimental.bundledDev) {
    // full bundle mode does not support experimental.renderBuiltUrl
    experimental.renderBuiltUrl = undefined
  }

  const resolvedDevToolsConfig = await resolveDevToolsConfig(
    config.devtools,
    server.host,
    logger,
  )

  resolved = {
    // 配置文件路径，绝对路径
    configFile: configFile ? normalizePath(configFile) : undefined,
    // 依赖的模块路径，绝对路径
    configFileDependencies: configFileDependencies.map((name) =>
      normalizePath(path.resolve(name)),
    ),
    // 内联配置
    inlineConfig,
    // 项目根目录
    root: resolvedRoot,
    base,
    // 解码后的基础路径
    decodedBase: decodeBase(base),
    // 原始基础路径
    rawBase: resolvedBase,
    // 公共目录 绝度路径
    publicDir: resolvedPublicDir,
    // 缓存目录 绝度路径 /xxx/xxx/.vite
    cacheDir,
    // 命令 build 或 serve
    command,
    mode,
    // 是否为捆绑模式
    isBundled: config.experimental?.bundledDev || isBuild,
    isWorker: false,
    // 主配置
    mainConfig: null,
    // 模块依赖链
    bundleChain: [],
    // 是否为生产环境
    isProduction,
    // 插件配置
    plugins: userPlugins, // placeholder to be replaced
    // CSS 配置
    css: resolveCSSOptions(config.css),
    // JSON 配置
    json: mergeWithDefaults(configDefaults.json, config.json ?? {}),
    // preserve esbuild for buildEsbuildPlugin
    // esbuild 配置
    esbuild:
      config.esbuild === false
        ? false
        : {
            jsxDev: !isProduction,
            // change defaults that fit better for vite
            charset: 'utf8',
            legalComments: 'none',
            ...config.esbuild,
          },
    // Oxc 配置
    oxc:
      oxc === false
        ? false
        : {
            ...oxc,
            jsx:
              typeof oxc?.jsx === 'string'
                ? oxc.jsx
                : {
                    development: oxc?.jsx?.development ?? !isProduction,
                    ...oxc?.jsx,
                  },
          },
    // 服务器配置
    server,
    // 构建器配置
    builder,
    // 预览配置
    preview,
    // 环境变量目录
    envDir,
    // 环境变量配置
    env: {
      ...userEnv,
      BASE_URL, // 基础路径
      MODE: mode, // 项目模式，development 或 production
      DEV: !isProduction, // 是否为开发环境
      PROD: isProduction, // 是否为生产环境
    },
    // 资产包含配置
    assetsInclude(file: string) {
      return DEFAULT_ASSETS_RE.test(file) || assetsFilter(file)
    },
    // 原始资产包含配置
    rawAssetsInclude: config.assetsInclude ? arraify(config.assetsInclude) : [],
    // 日志配置
    logger,
    // 包缓存配置
    packageCache,
    // 工作线程配置
    worker: resolvedWorkerOptions,
    // 应用类型，默认为 SPA
    appType: config.appType ?? 'spa',
    experimental,
    // 配置未来选项
    future:
      config.future === 'warn'
        ? ({
            // 警告用户移除handleHotUpdate插件钩子，因为已被废弃
            removePluginHookHandleHotUpdate: 'warn',
            // 警告用户移除ssrArgument插件钩子，因为已被废弃
            removePluginHookSsrArgument: 'warn',
            // 警告用户移除moduleGraph服务器配置，因为已被废弃
            removeServerModuleGraph: 'warn',
            // 警告用户移除reloadModule服务器配置，因为已被废弃
            removeServerReloadModule: 'warn',
            // 警告用户移除pluginContainer服务器配置，因为已被废弃
            removeServerPluginContainer: 'warn',
            // 警告用户移除hot服务器配置，因为已被废弃
            removeServerHot: 'warn',
            // 警告用户移除transformRequest服务器配置，因为已被废弃
            removeServerTransformRequest: 'warn',
            // 警告用户移除warmupRequest服务器配置，因为已被废弃
            removeServerWarmupRequest: 'warn',
            // 警告用户移除ssrLoadModule服务器配置，因为已被废弃
            removeSsrLoadModule: 'warn',
          } satisfies Required<FutureOptions>)
        : config.future,

    // 是否开启 SSR
    ssr,

    // 优化依赖项配置
    optimizeDeps: backwardCompatibleOptimizeDeps,
    // 模块解析配置
    resolve: resolvedDefaultResolve,
    // 开发环境配置
    dev: resolvedDevEnvironmentOptions,
    // 构建环境配置
    build: resolvedBuildOptions,
    // 开发环境的 DevTools 配置
    devtools: resolvedDevToolsConfig,

    // 环境配置
    environments: resolvedEnvironments,

    // random 72 bits (12 base64 chars)
    // at least 64bits is recommended
    // https://owasp.org/www-community/vulnerabilities/Insufficient_Session-ID_Length
    // 生成一个安全的、随机字符串（Base64URL 格式）
    // Buffer.from 将 Uint8Array（类数组）转换为 Node.js 的 Buffer 对象
    webSocketToken: Buffer.from(
      // new Uint8Array(9) 创建一个包含 9 个字节的 TypedArray，每个字节初始为 0。
      // crypto.getRandomValues，会用随机值填充这 9 个字节（每个字节 0-255）
      crypto.getRandomValues(new Uint8Array(9)),
      // 将 Buffer 编码为 Base64URL 格式
    ).toString('base64url'),

    getSortedPlugins: undefined!,
    getSortedPluginHooks: undefined!,

    createResolver(options) {
      const resolve = createIdResolver(this, options)
      const clientEnvironment = new PartialEnvironment('client', this)
      let ssrEnvironment: PartialEnvironment | undefined
      return async (id, importer, aliasOnly, ssr) => {
        if (ssr) {
          ssrEnvironment ??= new PartialEnvironment('ssr', this)
        }
        return await resolve(
          ssr ? ssrEnvironment! : clientEnvironment,
          id,
          importer,
          aliasOnly,
        )
      }
    },
    fsDenyGlob: picomatch(
      // matchBase: true does not work as it's documented
      // https://github.com/micromatch/picomatch/issues/89
      // convert patterns without `/` on our side for now
      server.fs.deny.map((pattern) =>
        pattern.includes('/') ? pattern : `**/${pattern}`,
      ),
      {
        matchBase: false,
        nocase: true,
        dot: true,
      },
    ),

    // 安全模块路径集合，用于限制模块的加载路径
    safeModulePaths: new Set<string>(),
    [SYMBOL_RESOLVED_CONFIG]: true, // 标记为已解析配置对象
  }
  resolved = {
    ...config,
    ...resolved,
  }

  // Backward compatibility hook, modify the resolved config before it is used
  // to create internal plugins. For example, `config.build.ssr`. Once we rework
  // internal plugins to use environment.config, we can remove the dual
  // patchConfig/patchPlugins and have a single patchConfig before configResolved
  // gets called
  patchConfig?.(resolved)

  const resolvedPlugins = await resolvePlugins(
    resolved,
    prePlugins,
    normalPlugins,
    postPlugins,
  )

  // Backward compatibility hook used in builder, opt-in to shared plugins during build
  patchPlugins?.(resolvedPlugins)
  ;(resolved.plugins as Plugin[]) = resolvedPlugins

  // TODO: Deprecate config.getSortedPlugins and config.getSortedPluginHooks
  Object.assign(resolved, createPluginHookUtils(resolved.plugins))

  // call configResolved hooks
  await Promise.all(
    resolved
      .getSortedPluginHooks('configResolved')
      .map((hook) => hook.call(resolvedConfigContext, resolved)),
  )

  // Resolve environment plugins after configResolved because there are
  // downstream projects modifying the plugins in it. This may change
  // once the ecosystem is ready.
  for (const name of Object.keys(resolved.environments)) {
    resolved.environments[name].plugins = await resolveEnvironmentPlugins(
      new PartialEnvironment(name, resolved),
    )
  }

  optimizeDepsDisabledBackwardCompatibility(resolved, resolved.optimizeDeps)
  optimizeDepsDisabledBackwardCompatibility(
    resolved,
    resolved.ssr.optimizeDeps,
    'ssr.',
  )

  // For backward compat, set ssr environment build.emitAssets with the same value as build.ssrEmitAssets that might be changed in configResolved hook
  // https://github.com/vikejs/vike/blob/953614cea7b418fcc0309b5c918491889fdec90a/vike/node/plugin/plugins/buildConfig.ts#L67
  if (!resolved.builder?.sharedConfigBuild && resolved.environments.ssr) {
    resolved.environments.ssr.build.emitAssets =
      resolved.build.ssrEmitAssets || resolved.build.emitAssets
  }

  // Enable `rolldownOptions.devtools` if devtools is enabled
  if (resolved.devtools.enabled) {
    resolved.build.rolldownOptions.devtools ??= {}
  }

  applyDepOptimizationOptionCompat(resolved)
  await setOptimizeDepsPluginNames(resolved)

  debug?.(`using resolved config: %O`, {
    ...resolved,
    plugins: resolved.plugins.map((p) => p.name),
    worker: {
      ...resolved.worker,
      plugins: `() => plugins`,
    },
  })

  // validate config

  // Check if all assetFileNames have the same reference.
  // If not, display a warn for user.
  const outputOption = config.build?.rollupOptions?.output ?? []
  // Use isArray to narrow its type to array
  if (Array.isArray(outputOption)) {
    const assetFileNamesList = outputOption.map(
      (output) => output.assetFileNames,
    )
    if (assetFileNamesList.length > 1) {
      const firstAssetFileNames = assetFileNamesList[0]
      const hasDifferentReference = assetFileNamesList.some(
        (assetFileNames) => assetFileNames !== firstAssetFileNames,
      )
      if (hasDifferentReference) {
        resolved.logger.warn(
          colors.yellow(`
assetFileNames isn't equal for every build.rollupOptions.output. A single pattern across all outputs is supported by Vite.
`),
        )
      }
    }
  }

  // Warn about removal of experimental features
  if (
    // @ts-expect-error Option removed
    config.legacy?.buildSsrCjsExternalHeuristics ||
    // @ts-expect-error Option removed
    config.ssr?.format === 'cjs'
  ) {
    resolved.logger.warn(
      colors.yellow(`
(!) Experimental legacy.buildSsrCjsExternalHeuristics and ssr.format were be removed in Vite 5.
    The only SSR Output format is ESM. Find more information at https://github.com/vitejs/vite/discussions/13816.
`),
    )
  }

  const resolvedBuildOutDir = normalizePath(
    path.resolve(resolved.root, resolved.build.outDir),
  )
  if (
    isParentDirectory(resolvedBuildOutDir, resolved.root) ||
    resolvedBuildOutDir === resolved.root
  ) {
    resolved.logger.warn(
      colors.yellow(`
(!) build.outDir must not be the same directory of root or a parent directory of root as this could cause Vite to overwriting source files with build outputs.
`),
    )
  }

  return resolved
}

/**
 * Resolve base url. Note that some users use Vite to build for non-web targets like
 * electron or expects to deploy
 */
export function resolveBaseUrl(
  base: UserConfig['base'] = configDefaults.base,
  isBuild: boolean,
  logger: Logger,
): string {
  if (base[0] === '.') {
    logger.warn(
      colors.yellow(
        colors.bold(
          `(!) invalid "base" option: "${base}". The value can only be an absolute ` +
            `URL, "./", or an empty string.`,
        ),
      ),
    )
    return '/'
  }

  // external URL flag
  const isExternal = isExternalUrl(base)
  // no leading slash warn
  if (!isExternal && base[0] !== '/') {
    logger.warn(
      colors.yellow(
        colors.bold(`(!) "base" option should start with a slash.`),
      ),
    )
  }

  // parse base when command is serve or base is not External URL
  if (!isBuild || !isExternal) {
    base = new URL(base, 'http://vite.dev').pathname
    // ensure leading slash
    if (base[0] !== '/') {
      base = '/' + base
    }
  }

  return base
}

function decodeBase(base: string): string {
  try {
    return decodeURI(base)
  } catch {
    throw new Error(
      'The value passed to "base" option was malformed. It should be a valid URL.',
    )
  }
}

export function sortUserPlugins(
  plugins: (Plugin | Plugin[])[] | undefined,
): [Plugin[], Plugin[], Plugin[]] {
  const prePlugins: Plugin[] = []
  const postPlugins: Plugin[] = []
  const normalPlugins: Plugin[] = []

  if (plugins) {
    plugins.flat().forEach((p) => {
      if (p.enforce === 'pre') prePlugins.push(p)
      else if (p.enforce === 'post') postPlugins.push(p)
      else normalPlugins.push(p)
    })
  }

  return [prePlugins, normalPlugins, postPlugins]
}

/**
 * 从文件加载 Vite 配置
 * @param configEnv 配置环境
 * @param configFile 配置文件路径
 * @param configRoot 配置根目录
 * @param logLevel 日志级别
 * @param customLogger 配置加载器
 * @param logLevel 日志级别
 * @param customLogger 配置加载器
 * @param configLoader 配置加载器类型
 * @returns
 */
export async function loadConfigFromFile(
  configEnv: ConfigEnv,
  configFile?: string,
  configRoot: string = process.cwd(),
  logLevel?: LogLevel,
  customLogger?: Logger,
  configLoader: 'bundle' | 'runner' | 'native' = 'bundle',
): Promise<{
  path: string
  config: UserConfig
  dependencies: string[]
} | null> {
  if (
    configLoader !== 'bundle' &&
    configLoader !== 'runner' &&
    configLoader !== 'native'
  ) {
    throw new Error(
      `Unsupported configLoader: ${configLoader}. Accepted values are 'bundle', 'runner', and 'native'.`,
    )
  }

  const start = performance.now()
  const getTime = () => `${(performance.now() - start).toFixed(2)}ms`

  let resolvedPath: string | undefined

  if (configFile) {
    // explicit config path is always resolved from cwd
    resolvedPath = path.resolve(configFile)
  } else {
    // implicit config file loaded from inline root (if present)
    // otherwise from cwd
    // 遍历查找默认配置文件
    for (const filename of DEFAULT_CONFIG_FILES) {
      const filePath = path.resolve(configRoot, filename)
      if (!fs.existsSync(filePath)) continue

      resolvedPath = filePath
      break
    }
  }

  if (!resolvedPath) {
    debug?.('no config file found.')
    return null
  }

  try {
    const resolver =
      configLoader === 'bundle'
        ? bundleAndLoadConfigFile // 处理配置文件的预构建
        : configLoader === 'runner'
          ? runnerImportConfigFile // 处理配置文件的运行时导入
          : nativeImportConfigFile // 处理配置文件的原生导入

    const { configExport, dependencies } = await resolver(resolvedPath)
    debug?.(`config file loaded in ${getTime()}`)

    const config = await (typeof configExport === 'function'
      ? configExport(configEnv)
      : configExport)
    if (!isObject(config)) {
      throw new Error(`config must export or return an object.`)
    }

    return {
      path: normalizePath(resolvedPath),
      config,
      dependencies,
    }
  } catch (e) {
    const logger = createLogger(logLevel, { customLogger })
    checkBadCharactersInPath('The config path', resolvedPath, logger)
    logger.error(colors.red(`failed to load config from ${resolvedPath}`), {
      error: e,
    })
    throw e
  }
}

async function nativeImportConfigFile(resolvedPath: string) {
  const module = await import(
    pathToFileURL(resolvedPath).href + '?t=' + Date.now()
  )
  return {
    configExport: module.default,
    dependencies: [],
  }
}

async function runnerImportConfigFile(resolvedPath: string) {
  const { module, dependencies } = await runnerImport<{
    default: UserConfigExport
  }>(resolvedPath)
  return {
    configExport: module.default,
    dependencies,
  }
}

/**
 * 用于打包并加载 Vite 配置文件。
 * 它处理配置文件的模块格式判断、打包和加载过程，确保配置文件能够被正确解析和执行。
 * @param resolvedPath 配置文件路径
 * @returns
 */
async function bundleAndLoadConfigFile(resolvedPath: string) {
  // 检查是否为 ESM 模块
  const isESM =
    // 在 Deno 环境中运行
    typeof process.versions.deno === 'string' || isFilePathESM(resolvedPath)

  // 配置文件打包
  // 打包过程会处理配置文件的依赖，将其转换为可执行的代码
  const bundled = await bundleConfigFile(resolvedPath, isESM)
  // 配置加载
  const userConfig = await loadConfigFromBundledFile(
    resolvedPath,
    bundled.code,
    isESM,
  )

  return {
    // 加载的用户配置
    configExport: userConfig,
    // 配置文件的依赖项
    dependencies: bundled.dependencies,
  }
}

/**
 * 用于打包 Vite 配置文件。
 * 它使用 Rolldown（Vite 的打包工具）将配置文件及其依赖打包成一个单一的可执行文件，并处理模块环境变量和外部依赖
 * @param fileName 配置文件路径
 * @param isESM 是否为 ESM 文件
 * @returns
 */
async function bundleConfigFile(
  fileName: string,
  isESM: boolean,
): Promise<{ code: string; dependencies: string[] }> {
  // 标记是否已注册 import.meta 解析器
  let importMetaResolverRegistered = false

  // 配置文件所在目录
  const root = path.dirname(fileName)
  // 注入变量名称
  // 注入 __dirname、__filename 等 CommonJS 环境变量
  const dirnameVarName = '__vite_injected_original_dirname'
  const filenameVarName = '__vite_injected_original_filename'
  // 注入 import.meta 相关变量，确保 ESM 模块的兼容性
  const importMetaUrlVarName = '__vite_injected_original_import_meta_url'
  // 处理 import.meta.resolve 的使用，根据模块格式提供不同的实现
  const importMetaResolveVarName =
    '__vite_injected_original_import_meta_resolve'
  const importMetaResolveRegex = /import\.meta\s*\.\s*resolve/

  // 调用 Rolldown 打包配置文件
  const bundle = await rolldown({
    input: fileName, // 输入文件路径
    // target: [`node${process.versions.node}`],
    platform: 'node', // 目标平台
    resolve: {
      mainFields: ['main'], // 主字段
    },
    // 定义全局替换
    transform: {
      define: {
        __dirname: dirnameVarName,
        __filename: filenameVarName,
        'import.meta.url': importMetaUrlVarName,
        'import.meta.dirname': dirnameVarName,
        'import.meta.filename': filenameVarName,
        'import.meta.resolve': importMetaResolveVarName,
        'import.meta.main': 'false',
      },
    },
    // disable treeshake to include files that is not sideeffectful to `moduleIds`
    // 设置为 false，确保所有模块都被包含
    treeshake: false,
    // disable tsconfig as it's confusing to respect tsconfig options in the config file
    // this also aligns with other config loader behaviors
    // 设置为 false，不使用 tsconfig 配置
    tsconfig: false,
    plugins: [
      {
        name: 'externalize-deps',
        resolveId: {
          filter: { id: /^[^.#].*/ },
          async handler(id, importer, { kind }) {
            if (!importer || path.isAbsolute(id) || isNodeBuiltin(id)) {
              return
            }

            // With the `isNodeBuiltin` check above, this check captures if the builtin is a
            // non-node built-in, which esbuild doesn't know how to handle. In that case, we
            // externalize it so the non-node runtime handles it instead.
            if (isNodeLikeBuiltin(id) || id.startsWith('npm:')) {
              return { id, external: true }
            }

            const isImport = isESM || kind === 'dynamic-import'
            let idFsPath: string | undefined
            try {
              idFsPath = nodeResolveWithVite(id, importer, {
                root,
                isRequire: !isImport,
              })
            } catch (e) {
              if (!isImport) {
                let canResolveWithImport = false
                try {
                  canResolveWithImport = !!nodeResolveWithVite(id, importer, {
                    root,
                  })
                } catch {}
                if (canResolveWithImport) {
                  throw new Error(
                    `Failed to resolve ${JSON.stringify(
                      id,
                    )}. This package is ESM only but it was tried to load by \`require\`. See https://vite.dev/guide/troubleshooting.html#this-package-is-esm-only for more details.`,
                  )
                }
              }
              throw e
            }
            if (!idFsPath) return
            // always no-externalize json files as rolldown does not support import attributes
            if (idFsPath.endsWith('.json')) {
              return idFsPath
            }

            if (idFsPath && isImport) {
              idFsPath = pathToFileURL(idFsPath).href
            }
            return { id: idFsPath, external: true }
          },
        },
      },
      {
        name: 'inject-file-scope-variables',
        transform: {
          filter: { id: /\.[cm]?[jt]s$/ },
          handler(code, id) {
            let injectValues =
              `const ${dirnameVarName} = ${JSON.stringify(path.dirname(id))};` +
              `const ${filenameVarName} = ${JSON.stringify(id)};` +
              `const ${importMetaUrlVarName} = ${JSON.stringify(
                pathToFileURL(id).href,
              )};`
            if (importMetaResolveRegex.test(code)) {
              if (isESM) {
                if (!importMetaResolverRegistered) {
                  importMetaResolverRegistered = true
                  createImportMetaResolver()
                }
                injectValues += `const ${importMetaResolveVarName} = (specifier, importer = ${importMetaUrlVarName}) => (${importMetaResolveWithCustomHookString})(specifier, importer);`
              } else {
                injectValues += `const ${importMetaResolveVarName} = (specifier, importer = ${importMetaUrlVarName}) => { throw new Error('import.meta.resolve is not supported in CJS config files') };`
              }
            }

            let injectedContents: string
            if (code.startsWith('#!')) {
              // hashbang
              let firstLineEndIndex = code.indexOf('\n')
              if (firstLineEndIndex < 0) firstLineEndIndex = code.length
              injectedContents =
                code.slice(0, firstLineEndIndex + 1) +
                injectValues +
                code.slice(firstLineEndIndex + 1)
            } else {
              injectedContents = injectValues + code
            }

            return {
              code: injectedContents,
              map: null,
            }
          },
        },
      },
    ],
  })

  // 生成打包结果
  const result = await bundle.generate({
    // 根据 isESM 决定生成 ESM 还是 CJS 格式
    format: isESM ? 'esm' : 'cjs',
    sourcemap: 'inline', // 设置为 'inline'，生成内联源码映射
    // 转换源码映射中的路径
    sourcemapPathTransform(relative) {
      return path.resolve(fileName, relative)
    },
    // we want to generate a single chunk like esbuild does with `splitting: false`
    // 设置为 false，生成单个 chunk
    codeSplitting: false,
  })

  // 关闭打包器
  await bundle.close()

  // 找到入口块
  const entryChunk = result.output.find(
    (chunk): chunk is OutputChunk => chunk.type === 'chunk' && chunk.isEntry,
  )!
  // 收集所有chunk
  const bundleChunks = Object.fromEntries(
    result.output.flatMap((c) => (c.type === 'chunk' ? [[c.fileName, c]] : [])),
  )

  const allModules = new Set<string>()
  // 收集所有模块
  collectAllModules(bundleChunks, entryChunk.fileName, allModules)

  return {
    code: entryChunk.code,
    // exclude `\x00rolldown/runtime.js`
    // 去除虚拟模块
    dependencies: [...allModules].filter((m) => !m.startsWith('\0')),
  }
}

/**
 * 用于收集打包配置文件时的所有模块依赖。
 * 它通过递归遍历 chunk 间的依赖关系，确保所有相关模块都被正确收集，同时避免循环引用导致的无限递归。
 * @param bundle
 * @param fileName
 * @param allModules
 * @param analyzedModules
 * @returns
 */
function collectAllModules(
  bundle: Record<string, OutputChunk>,
  fileName: string,
  allModules: Set<string>,
  analyzedModules = new Set<string>(),
) {
  // 检查当前文件是否已被分析过，避免无限递归
  if (analyzedModules.has(fileName)) return
  analyzedModules.add(fileName)

  // 获取当前文件的 chunk 实例
  const chunk = bundle[fileName]!
  // 收集当前 chunk 中的所有模块
  for (const mod of chunk.moduleIds) {
    allModules.add(mod)
  }
  // 遍历 chunk 的所有静态导入
  for (const i of chunk.imports) {
    analyzedModules.add(i)
    // 递归收集导入模块的依赖
    collectAllModules(bundle, i, allModules, analyzedModules)
  }
  // 遍历 chunk 的所有动态导入
  for (const i of chunk.dynamicImports) {
    analyzedModules.add(i)
    // 递归收集动态导入模块的依赖
    collectAllModules(bundle, i, allModules, analyzedModules)
  }
}

interface NodeModuleWithCompile extends NodeModule {
  _compile(code: string, filename: string): any
}

// 创建一个 Node.js 样准的 require 函数，用于加载模块
const _require = createRequire(/** #__KEEP__ */ import.meta.url)

/**
 * 用于从打包后的代码加载 Vite 配置。
 * 它根据模块类型（ESM 或 CommonJS）采用不同的加载策略，确保配置文件能够被正确执行并返回配置对象
 * @param fileName  文件路径
 * @param bundledCode 打包转换后代码
 * @param isESM 是否为 ESM 格式
 * @returns
 */
async function loadConfigFromBundledFile(
  fileName: string,
  bundledCode: string,
  isESM: boolean,
): Promise<UserConfigExport> {
  // for esm, before we can register loaders without requiring users to run node
  // with --experimental-loader themselves, we have to do a hack here:
  // write it to disk, load it with native Node ESM, then delete the file.
  if (isESM) {
    // Storing the bundled file in node_modules/ is avoided for Deno
    // because Deno only supports Node.js style modules under node_modules/
    // and configs with `npm:` import statements will fail when executed.
    // 查找最近的 node_modules 目录
    let nodeModulesDir =
      typeof process.versions.deno === 'string'
        ? undefined
        : findNearestNodeModules(path.dirname(fileName))

    if (nodeModulesDir) {
      try {
        // 创建临时目录
        // node_modules/.vite-temp/
        await fsp.mkdir(path.resolve(nodeModulesDir, '.vite-temp/'), {
          recursive: true,
        })
      } catch (e) {
        if (e.code === 'EACCES') {
          // If there is no access permission, a temporary configuration file is created by default.
          nodeModulesDir = undefined
        } else {
          throw e
        }
      }
    }
    // 生成 hash 值
    const hash = `timestamp-${Date.now()}-${Math.random().toString(16).slice(2)}`
    // 生成临时文件名
    const tempFileName = nodeModulesDir
      ? path.resolve(
          nodeModulesDir,
          `.vite-temp/${path.basename(fileName)}.${hash}.mjs`,
        )
      : `${fileName}.${hash}.mjs`
    // 写入临时文件
    await fsp.writeFile(tempFileName, bundledCode)
    try {
      // 将文件系统路径转换为 file:// 协议的 URL 对象
      // 原因：ESM 的 import() 语法要求模块标识符为 URL 格式（对于本地文件），不能直接使用文件系统路径
      // 动态加载 ESM 格式配置文件
      // 执行过程：
      // 1、Node.js 读取并执行 tempFileName 指向的文件
      // 2、执行文件中的代码，构建模块的导出
      // 3、生成包含所有导出的模块命名空间对象
      // 4、Promise 解析为该命名空间对象
      return (await import(pathToFileURL(tempFileName).href)).default
    } finally {
      fs.unlink(tempFileName, () => {}) // Ignore errors
    }
  }
  // for cjs, we can register a custom loader via `_require.extensions`
  else {
    // 获取文件扩展名
    const extension = path.extname(fileName)
    // We don't use fsp.realpath() here because it has the same behaviour as
    // fs.realpath.native. On some Windows systems, it returns uppercase volume
    // letters (e.g. "C:\") while the Node.js loader uses lowercase volume letters.
    // See https://github.com/vitejs/vite/issues/12923
    // 获取文件的真实路径
    // 避免 Windows 系统上的路径大小写问题
    const realFileName = await promisifiedRealpath(fileName)
    // 确定加载器扩展名
    // require.extensions 标记已废弃
    const loaderExt = extension in _require.extensions ? extension : '.js'
    const defaultLoader = _require.extensions[loaderExt]!
    // 注册自定义加载器
    _require.extensions[loaderExt] = (module: NodeModule, filename: string) => {
      if (filename === realFileName) {
        // 执行打包后的代码
        ;(module as NodeModuleWithCompile)._compile(bundledCode, filename)
      } else {
        // 使用默认加载器
        defaultLoader(module, filename)
      }
    }
    // clear cache in case of server restart
    // 清除缓存
    delete _require.cache[_require.resolve(fileName)]
    // 加载配置文件
    const raw = _require(fileName)
    // 恢复默认加载器
    _require.extensions[loaderExt] = defaultLoader
    return raw.__esModule ? raw.default : raw
  }
}

/**
 * 运行配置钩子函数
 * @param config 配置对象
 * @param plugins 插件数组
 * @param configEnv 配置环境对象
 * @returns
 */
async function runConfigHook(
  config: InlineConfig,
  plugins: Plugin[],
  configEnv: ConfigEnv,
): Promise<InlineConfig> {
  let conf = config

  const tempLogger = createLogger(config.logLevel, {
    allowClearScreen: config.clearScreen,
    customLogger: config.customLogger,
  })
  const context = new BasicMinimalPluginContext<
    Omit<PluginContextMeta, 'watchMode'>
  >(basePluginContextMeta, tempLogger)

  // 根据 config 钩子排序插件
  for (const p of getSortedPluginsByHook('config', plugins)) {
    const hook = p.config
    const handler = getHookHandler(hook) // 获取插件钩子函数的处理函数
    // 调用插件钩子函数
    const res = await handler.call(context, conf, configEnv)
    if (res && res !== conf) {
      if (hasBothRollupOptionsAndRolldownOptions(res)) {
        context.warn(
          `Both \`rollupOptions\` and \`rolldownOptions\` were specified by ${JSON.stringify(p.name)} plugin. ` +
            `\`rollupOptions\` specified by that plugin will be ignored.`,
        )
      }
      if (res.esbuild) {
        context.warn(
          `\`esbuild\` option was specified by ${JSON.stringify(p.name)} plugin. ` +
            `This option is deprecated, please use \`oxc\` instead.`,
        )
      }
      if (res.optimizeDeps?.esbuildOptions) {
        context.warn(
          `\`optimizeDeps.esbuildOptions\` option was specified by ${JSON.stringify(p.name)} plugin. ` +
            `This option is deprecated, please use \`optimizeDeps.rolldownOptions\` instead.`,
        )
      }
      conf = mergeConfig(conf, res)
    }
  }

  // 返回合并后的配置对象
  return conf
}

/**
 * 运行配置环境钩子函数
 * @param environments 环境配置对象
 * @param plugins 插件数组
 * @param logger logger 实例
 * @param configEnv 配置环境对象
 * @param isSsrTargetWebworkerSet 是否为 SSR 目标 Webworker
 */
async function runConfigEnvironmentHook(
  environments: Record<string, EnvironmentOptions>,
  plugins: Plugin[],
  logger: Logger,
  configEnv: ConfigEnv,
  isSsrTargetWebworkerSet: boolean,
): Promise<void> {
  const context = new BasicMinimalPluginContext<
    Omit<PluginContextMeta, 'watchMode'>
  >(basePluginContextMeta, logger)

  const environmentNames = Object.keys(environments)
  for (const p of getSortedPluginsByHook('configEnvironment', plugins)) {
    const hook = p.configEnvironment
    const handler = getHookHandler(hook)
    for (const name of environmentNames) {
      const res = await handler.call(context, name, environments[name], {
        ...configEnv,
        isSsrTargetWebworker: isSsrTargetWebworkerSet && name === 'ssr',
      })
      if (res) {
        environments[name] = mergeConfig(environments[name], res)
      }
    }
  }
}

function optimizeDepsDisabledBackwardCompatibility(
  resolved: ResolvedConfig,
  optimizeDeps: DepOptimizationOptions,
  optimizeDepsPath: string = '',
) {
  const optimizeDepsDisabled = optimizeDeps.disabled
  if (optimizeDepsDisabled !== undefined) {
    if (optimizeDepsDisabled === true || optimizeDepsDisabled === 'dev') {
      const commonjsOptionsInclude = resolved.build.commonjsOptions.include
      const commonjsPluginDisabled =
        Array.isArray(commonjsOptionsInclude) &&
        commonjsOptionsInclude.length === 0
      optimizeDeps.noDiscovery = true
      optimizeDeps.include = undefined
      if (commonjsPluginDisabled) {
        resolved.build.commonjsOptions.include = undefined
      }
      resolved.logger.warn(
        colors.yellow(`(!) Experimental ${optimizeDepsPath}optimizeDeps.disabled and deps pre-bundling during build were removed in Vite 5.1.
    To disable the deps optimizer, set ${optimizeDepsPath}optimizeDeps.noDiscovery to true and ${optimizeDepsPath}optimizeDeps.include as undefined or empty.
    Please remove ${optimizeDepsPath}optimizeDeps.disabled from your config.
    ${
      commonjsPluginDisabled
        ? 'Empty config.build.commonjsOptions.include will be ignored to support CJS during build. This config should also be removed.'
        : ''
    }
  `),
      )
    } else if (
      optimizeDepsDisabled === false ||
      optimizeDepsDisabled === 'build'
    ) {
      resolved.logger.warn(
        colors.yellow(`(!) Experimental ${optimizeDepsPath}optimizeDeps.disabled and deps pre-bundling during build were removed in Vite 5.1.
    Setting it to ${optimizeDepsDisabled} now has no effect.
    Please remove ${optimizeDepsPath}optimizeDeps.disabled from your config.
  `),
      )
    }
  }
}
