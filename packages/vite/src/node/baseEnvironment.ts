import colors from 'picocolors'
import type { Logger } from './logger'
import type { ResolvedConfig, ResolvedEnvironmentOptions } from './config'
import type { Plugin } from './plugin'

const environmentColors = [
  colors.blue,
  colors.magenta,
  colors.green,
  colors.gray,
]

/**
 * 基础环境类，用于创建环境实例
 */
export class PartialEnvironment {
  name: string
  getTopLevelConfig(): ResolvedConfig {
    return this._topLevelConfig
  }

  config: ResolvedConfig & ResolvedEnvironmentOptions

  logger: Logger

  /**
   * @internal
   */
  _options: ResolvedEnvironmentOptions
  /**
   * @internal
   */
  _topLevelConfig: ResolvedConfig

  constructor(
    name: string,
    topLevelConfig: ResolvedConfig,
    options: ResolvedEnvironmentOptions = topLevelConfig.environments[name],
  ) {
    // only allow some characters so that we can use name without escaping for directory names
    // and make users easier to access with `environments.*`
    // 验证环境名称，只允许字母、数字、下划线和美元符号
    if (!/^[\w$]+$/.test(name)) {
      throw new Error(
        `Invalid environment name "${name}". Environment names must only contain alphanumeric characters and "$", "_".`,
      )
    }
    this.name = name
    this._topLevelConfig = topLevelConfig
    this._options = options

    // 配置代理，用于访问环境选项和顶级配置
    this.config = new Proxy(
      options as ResolvedConfig & ResolvedEnvironmentOptions,
      {
        get: (target, prop: keyof ResolvedConfig) => {
          if (prop === 'logger') {
            return this.logger
          }
          if (prop in target) {
            return this._options[prop as keyof ResolvedEnvironmentOptions]
          }
          return this._topLevelConfig[prop]
        },
      },
    )

    // 日志系统初始化
    const environment = colors.dim(`(${this.name})`)
    const colorIndex =
      [...this.name].reduce((acc, c) => acc + c.charCodeAt(0), 0) %
      environmentColors.length
    const infoColor = environmentColors[colorIndex || 0]
    this.logger = {
      get hasWarned() {
        return topLevelConfig.logger.hasWarned
      },
      info(msg, opts) {
        return topLevelConfig.logger.info(msg, {
          ...opts,
          environment: infoColor(environment),
        })
      },
      warn(msg, opts) {
        return topLevelConfig.logger.warn(msg, {
          ...opts,
          environment: colors.yellow(environment),
        })
      },
      warnOnce(msg, opts) {
        return topLevelConfig.logger.warnOnce(msg, {
          ...opts,
          environment: colors.yellow(environment),
        })
      },
      error(msg, opts) {
        return topLevelConfig.logger.error(msg, {
          ...opts,
          environment: colors.red(environment),
        })
      },
      clearScreen(type) {
        return topLevelConfig.logger.clearScreen(type)
      },
      hasErrorLogged(error) {
        return topLevelConfig.logger.hasErrorLogged(error)
      },
    }
  }
}

export class BaseEnvironment extends PartialEnvironment {
  get plugins(): readonly Plugin[] {
    return this.config.plugins
  }

  /**
   * @internal
   */
  _initiated: boolean = false

  constructor(
    name: string,
    config: ResolvedConfig,
    options: ResolvedEnvironmentOptions = config.environments[name],
  ) {
    super(name, config, options)
  }
}

/**
 * This class discourages users from inversely checking the `mode`
 * to determine the type of environment, e.g.
 *
 * ```js
 * const isDev = environment.mode !== 'build' // bad
 * const isDev = environment.mode === 'dev'   // good
 * ```
 *
 * You should also not check against `"unknown"` specifically. It's
 * a placeholder for more possible environment types.
 */
export class UnknownEnvironment extends BaseEnvironment {
  mode = 'unknown' as const
}
