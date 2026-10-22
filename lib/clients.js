/**
 * 客户端身份与请求头。
 *
 * 两类凭据访问的是不同客户端身份下的同一套 CodeBuddy 服务：
 *  - WorkBuddy 浏览器登录：`Authorization: Bearer` + WorkBuddy 产品头；
 *  - CodeBuddy CLI API Key：`X-API-Key` + CLI 产品头。
 *
 * 服务端会按产品头把流量归因到具体客户端，因此这里必须严格跟随凭据类型，
 * 不能混用。
 *
 * @module dsh-plugin-workbuddy-lite/clients
 */

import {
  API_ENVIRONMENT_ORIGINS,
  API_ENVIRONMENTS,
  CLI_PLATFORM,
  CLI_VERSION,
  CODEBUDDY_IOA_DOMAIN,
  WORKBUDDY_APP_UA,
  WORKBUDDY_CLI_UA,
  WORKBUDDY_CLI_VERSION,
  WORKBUDDY_PLATFORM,
  WORKBUDDY_VERSION,
} from './constants.js'

/**
 * 把任意输入收敛为受支持的环境 id。
 * @param {unknown} value
 * @returns {'internal'|'external'|'ioa'|'custom'}
 */
export function normalizeEnvironment(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return API_ENVIRONMENTS.includes(text) ? text : 'internal'
}

/**
 * 规范化服务地址：去掉末尾斜杠；非 http(s) 地址拒绝。
 * @param {unknown} value
 * @returns {string|undefined}
 */
export function normalizeOrigin(value) {
  if (typeof value !== 'string') return undefined
  let text = value.trim()
  if (text.length === 0) return undefined
  // 用户经常只填主机名；默认补 https://。
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`
  let url
  try {
    url = new URL(text)
  }
  catch {
    throw new Error('服务地址不是合法 URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('服务地址必须使用 http(s)')
  }
  let path = url.pathname.replace(/\/+$/, '')
  // 常见误填：把 Key 页面、聊天端点或目录端点当成服务根。
  if (/\/v1(?:\/|$)/u.test(path)) {
    throw new Error('这是 OpenAI 兼容地址（/v1）；请填 CodeBuddy 服务根地址，例如 https://copilot.tencent.com')
  }
  path = path
    .replace(/\/(?:v[23]\/)?(?:chat\/completions|config|plugin)$/u, '')
    .replace(/\/profile(?:\/.*)?$/u, '')
    .replace(/\/console(?:\/.*)?$/u, '')
    .replace(/\/login$/u, '')
    .replace(/\/v[23]$/u, '')
    .replace(/\/+$/, '')
  return `${url.origin}${path}`
}

/**
 * 解析 API Key 条目的服务根。
 * @param {{ environment?: string, endpoint?: string }} entry
 * @returns {string}
 */
export function resolveApiOrigin(entry) {
  const environment = normalizeEnvironment(entry?.environment)
  if (environment === 'custom') {
    const custom = normalizeOrigin(entry?.endpoint)
    if (custom === undefined) throw new Error('自定义环境缺少服务地址')
    // 用户可能把聊天基址（.../v2）当成服务根填进来；目录端点需要的是根。
    return custom.replace(/\/v2$/u, '')
  }
  return API_ENVIRONMENT_ORIGINS[environment]
}

/**
 * WorkBuddy 会话的客户端身份头（不含 Authorization）。
 * @param {{ account?: { uid?: string, enterpriseId?: string, departmentFullName?: string }, auth?: { domain?: string } }} session
 * @returns {Record<string, string>}
 */
export function workbuddyIdentityHeaders(session) {
  /** @type {Record<string, string>} */
  const headers = {
    'X-IDE-Type': 'CLI',
    'X-IDE-Name': 'CLI',
    'X-IDE-Version': WORKBUDDY_CLI_VERSION,
    'user-agent': WORKBUDDY_CLI_UA,
    'X-Product': 'SaaS',
  }
  // 官方客户端即使 domain 为空也会带上该头；缺失时服务端可能按不同租户解析。
  headers['X-Domain'] = session?.auth?.domain ?? ''
  if (session?.account?.uid) headers['X-User-Id'] = session.account.uid
  if (session?.account?.enterpriseId) headers['X-Enterprise-Id'] = session.account.enterpriseId
  if (session?.account?.departmentFullName) headers['X-Department-Info'] = session.account.departmentFullName
  return headers
}

/**
 * WorkBuddy App 读取 `/v3/config` 的身份头。
 *
 * 上游按 User-Agent 的「客户端通道」下发不同的目录：CLI 通道只拿到 App 通道
 * 的子集。这里必须使用官方 App 的三段式 UA（App 两次 + CLI 一次），否则
 * 新版模型（如 DeepSeek-V4.1-Flash、GLM-5.3、Kimi-K3）不会出现在目录里。
 * @param {{ account?: { uid?: string, enterpriseId?: string, departmentFullName?: string }, auth?: { domain?: string } }} session
 * @returns {Record<string, string>}
 */
export function workbuddyCatalogHeaders(session) {
  /** @type {Record<string, string>} */
  const headers = {
    'X-IDE-Type': WORKBUDDY_PLATFORM,
    'X-IDE-Name': WORKBUDDY_PLATFORM,
    'X-IDE-Version': WORKBUDDY_VERSION,
    'user-agent': WORKBUDDY_APP_UA,
    'X-Product': 'SaaS',
  }
  headers['X-Domain'] = session?.auth?.domain ?? ''
  if (session?.account?.uid) headers['X-User-Id'] = session.account.uid
  if (session?.account?.enterpriseId) headers['X-Enterprise-Id'] = session.account.enterpriseId
  if (session?.account?.departmentFullName) headers['X-Department-Info'] = session.account.departmentFullName
  return headers
}

/**
 * CodeBuddy CLI API Key 的客户端身份头（不含 X-API-Key）。
 * @param {{ environment?: string, account?: { uid?: string, enterpriseId?: string } }} entry
 * @returns {Record<string, string>}
 */
export function apiKeyIdentityHeaders(entry) {
  /** @type {Record<string, string>} */
  const headers = {
    'X-IDE-Type': CLI_PLATFORM,
    'X-IDE-Name': CLI_PLATFORM,
    'X-IDE-Version': CLI_VERSION,
    'user-agent': `${CLI_PLATFORM}/${CLI_VERSION} CodeBuddy/${CLI_VERSION}`,
    'X-Product': 'SaaS',
  }
  const environment = normalizeEnvironment(entry?.environment)
  if (environment === 'ioa') headers['X-Domain'] = CODEBUDDY_IOA_DOMAIN
  if (entry?.account?.uid) headers['X-User-Id'] = entry.account.uid
  if (entry?.account?.enterpriseId) headers['X-Enterprise-Id'] = entry.account.enterpriseId
  return headers
}
