/**
 * 插件共用的固定事实。
 *
 * 这里只放协议常量与凭据引用名，不放任何用户凭据。
 *
 * @module dsh-plugin-workbuddy-lite/constants
 */

/** 插件设置命名空间，同时是 Loader 条目 id。 */
export const NS = 'workbuddy-lite'

/** 在 `ctx.llm` 上注册的 provider 路由。 */
export const PROVIDER = 'codebuddy'

/** 模型选择器与设置页展示名。 */
export const DISPLAY_NAME = 'CodeBuddy'

/** WorkBuddy 客户端身份：登录握手 ?platform= 与 X-IDE-* 头共用。 */
export const WORKBUDDY_PLATFORM = 'WorkBuddy'

/** WorkBuddy 正式客户端版本（登录握手用）。 */
export const WORKBUDDY_VERSION = '5.8.3'

/** WorkBuddy App 读取 /v3/config 时使用的产品 UA。 */
export const WORKBUDDY_APP_UA = 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0'

/** WorkBuddy 聊天通道使用的 CLI 版本。 */
export const WORKBUDDY_CLI_VERSION = '2.63.2'

/** WorkBuddy 聊天通道使用的 CLI UA。 */
export const WORKBUDDY_CLI_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

/** CodeBuddy CLI 客户端身份。 */
export const CLI_PLATFORM = 'CLI'

/**
 * CodeBuddy CLI 正式版本。
 *
 * 服务端按 `X-IDE-Version` / `User-Agent` 把请求归因到具体 CLI 版本，所以这里
 * 跟随官方 CLI 的 npm dist-tags.latest 更新，不要写随机值。
 */
export const CLI_VERSION = '2.169.0'

/** WorkBuddy 登录、模型目录与聊天共用的服务根。 */
export const WORKBUDDY_ORIGIN = 'https://www.workbuddy.cn'

/** CodeBuddy 中国版服务根（也是官方 CLI 默认入口）。 */
export const CODEBUDDY_ORIGIN = 'https://copilot.tencent.com'

/** CodeBuddy 海外版服务根（独立后端，不可与中国版混用）。 */
export const CODEBUDDY_INTL_ORIGIN = 'https://www.codebuddy.ai'

/** iOA 版登录域默认值（仅 iOA 环境使用）。 */
export const CODEBUDDY_IOA_DOMAIN = 'tencent.sso.copilot.tencent.com'

/** OpenAI 兼容聊天的路径（拼在 `<origin>/v2` 之后）。 */
export const CHAT_PATH = '/chat/completions'

/** 模型目录端点（非 OpenAI 兼容，必须单独读取）。 */
export const CONFIG_PATH = '/v3/config'

/** 账号信息端点（企业上下文头与展示名来源）。 */
export const ACCOUNTS_PATH = '/v2/accounts'

/** WorkBuddy 浏览器登录握手前缀。 */
export const WORKBUDDY_AUTH_PREFIX = '/v2/plugin'

/** 服务端表示「浏览器登录尚未完成」的业务码。 */
export const AUTH_PENDING_CODE = 11217

/** 登录等待上限（ms）。 */
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

/** 客户端轮询间隔（ms）。 */
export const LOGIN_POLL_INTERVAL_MS = 1_500

/** 流式读取的空闲超时（目前作为连接级超时兜底保留）。 */
export const STREAM_IDLE_TIMEOUT_MS = 300_000

/** 模型目录请求超时。 */
export const MODEL_DISCOVERY_TIMEOUT_MS = 20_000

/** 账号信息请求超时。 */
export const ACCOUNT_FETCH_TIMEOUT_MS = 6_000

/** 积分余额请求超时。 */
export const CREDITS_TIMEOUT_MS = 8_000

/** 国内版积分网关。 */
export const CREDITS_ORIGIN = 'https://www.codebuddy.cn'

/** 未披露容量的模型使用的保守上下文。 */
export const DEFAULT_CONTEXT_WINDOW = 262_144

/** 未披露输出上限的模型使用的保守值。 */
export const DEFAULT_MAX_TOKENS = 32_768

/** 环境变量/凭据引用名：可选的 ambient API Key。 */
export const API_KEY_ENV = 'CODEBUDDY_API_KEY'

/** 凭据服务中的存储引用：WorkBuddy 登录会话集合。 */
export const WORKBUDDY_SESSIONS_REF = 'CODEBUDDY_WORKBUDDY_SESSIONS'

/** 凭据服务中的存储引用：API Key 元数据集合。 */
export const API_KEY_STORE_REF = 'CODEBUDDY_API_KEYS'

/** 凭据服务中的存储引用：模型启用/禁用偏好。 */
export const MODEL_PREFS_REF = 'CODEBUDDY_MODEL_PREFS'

/** 支持的认证模式。 */
export const AUTH_MODES = ['workbuddy', 'apikey']

/** API Key 可指向的服务环境。 */
export const API_ENVIRONMENTS = ['internal', 'external', 'ioa', 'custom']

/** 环境展示名。 */
export const API_ENVIRONMENT_LABELS = {
  internal: '中国版',
  external: '海外版',
  ioa: 'iOA 企业版',
  custom: '自定义地址',
}

/** 各环境默认服务根。 */
export const API_ENVIRONMENT_ORIGINS = {
  internal: CODEBUDDY_ORIGIN,
  external: CODEBUDDY_INTL_ORIGIN,
  ioa: CODEBUDDY_ORIGIN,
  custom: '',
}

/** 设置页路由前缀。 */
export const WEB_ROUTE = '/workbuddy-lite'
