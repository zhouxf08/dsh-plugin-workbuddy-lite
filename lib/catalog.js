/**
 * CodeBuddy 模型目录与账号信息。
 *
 * 聊天平面是 OpenAI 兼容的，但目录平面不是：模型的能力、容量和思考档位只能
 * 从 `/v3/config` 读取。这里把响应解析成 adapter 需要的稳定形状，并统一两类
 * 凭据的请求头。
 *
 * @module dsh-plugin-workbuddy-lite/catalog
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  ACCOUNT_FETCH_TIMEOUT_MS,
  ACCOUNTS_PATH,
  CONFIG_PATH,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  MODEL_DISCOVERY_TIMEOUT_MS,
} from './constants.js'
import { apiKeyIdentityHeaders, workbuddyIdentityHeaders } from './clients.js'

/** 思考档位，从弱到强。 */
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * 为一次目录/账号请求构造认证头。
 * @param {any} credential
 * @returns {Record<string, string>}
 */
export function credentialHeaders(credential) {
  if (credential.kind === 'workbuddy') {
    return {
      authorization: `Bearer ${credential.value}`,
      ...workbuddyIdentityHeaders(credential.session),
    }
  }
  return {
    'x-api-key': credential.value,
    ...apiKeyIdentityHeaders(credential.entry),
  }
}

/**
 * 把调用方信号和超时合成一个信号。
 * @param {AbortSignal|undefined} signal
 * @param {number} timeoutMs
 * @returns {AbortSignal}
 */
function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/**
 * 读取 `{code,msg,data}` 信封。
 * @param {Response} response
 * @param {string} action
 * @returns {Promise<any>}
 */
async function readEnvelope(response, action, url) {
  let body
  try {
    body = await response.json()
  }
  catch (error) {
    throw new LlmError(`${action}返回了无法解析的数据（${url}）`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (body === null || typeof body !== 'object') {
    throw new LlmError(`${action}返回了无效数据（${url}）`, 'DISCOVERY_FAILED')
  }
  if (!response.ok) {
    throw new LlmError(
      `${action}失败（HTTP ${response.status}）：${url}`,
      response.status === 401 || response.status === 403 ? 'AUTH' : 'DISCOVERY_FAILED',
    )
  }
  if (body.code !== 0) {
    throw new LlmError(`${action}失败：${body.msg ?? body.message ?? body.code}（${url}）`, 'DISCOVERY_FAILED')
  }
  return body
}

/**
 * 读取模型目录。
 * @param {any} credential
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Array<any>>}
 */
export async function fetchModels(credential, options = {}) {
  const origin = credential.origin
  if (typeof origin !== 'string' || origin.length === 0) {
    throw new LlmError('CodeBuddy 服务地址为空', 'DISCOVERY_FAILED')
  }
  const url = `${origin}${CONFIG_PATH}`
  let response
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'x-product': 'SaaS',
        'x-requested-with': 'XMLHttpRequest',
        ...credentialHeaders(credential),
      },
      signal: withTimeout(options.signal, MODEL_DISCOVERY_TIMEOUT_MS),
    })
  }
  catch (error) {
    if (options.signal?.aborted) throw new LlmError('CodeBuddy 模型目录读取已取消', 'ABORTED', { cause: error })
    throw new LlmError(`无法连接 CodeBuddy 模型目录接口：${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  const body = await readEnvelope(response, 'CodeBuddy 模型目录', url)
  return parseModels(body.data)
}

/**
 * 尽力读取账号信息（企业头与展示名）。
 * @param {any} credential
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ uid?: string, enterpriseId?: string, enterpriseName?: string, nickname?: string, enterpriseUserName?: string, type?: string }|undefined>}
 */
export async function fetchAccount(credential, options = {}) {
  const url = `${credential.origin}${ACCOUNTS_PATH}`
  let response
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...credentialHeaders(credential),
      },
      signal: withTimeout(options.signal, ACCOUNT_FETCH_TIMEOUT_MS),
    })
  }
  catch {
    return undefined
  }
  if (!response.ok) return undefined
  let body
  try {
    body = await response.json()
  }
  catch {
    return undefined
  }
  const data = body?.data
  const accounts = Array.isArray(data?.accounts)
    ? data.accounts
    : Array.isArray(data)
      ? data
      : data !== null && typeof data === 'object' && (data.uid !== undefined || data.userId !== undefined)
        ? [data]
        : []
  const first = accounts[0]
  if (first === null || typeof first !== 'object') return undefined
  const pick = (key) => typeof first[key] === 'string' && first[key].length > 0 ? first[key] : undefined
  return {
    ...(pick('uid') === undefined ? {} : { uid: pick('uid') }),
    ...(pick('userId') === undefined ? {} : { uid: pick('userId') }),
    ...(pick('enterpriseId') === undefined ? {} : { enterpriseId: pick('enterpriseId') }),
    ...(pick('enterpriseName') === undefined ? {} : { enterpriseName: pick('enterpriseName') }),
    ...(pick('nickname') === undefined ? {} : { nickname: pick('nickname') }),
    ...(pick('enterpriseUserName') === undefined ? {} : { enterpriseUserName: pick('enterpriseUserName') }),
    ...(pick('type') === undefined ? {} : { type: pick('type') }),
  }
}

/**
 * 从目录响应解析模型。
 * @param {any} data
 * @returns {Array<any>}
 */
export function parseModels(data) {
  const raw = data !== null && typeof data === 'object' ? data : {}
  const agents = Array.isArray(raw.agents)
    ? raw.agents
    : raw.agent !== null && typeof raw.agent === 'object' && Array.isArray(raw.agent.agents)
      ? raw.agent.agents
      : undefined
  const cli = Array.isArray(agents) ? agents.find((agent) => agent?.name === 'cli') : undefined
  let allowed = Array.isArray(cli?.models) ? cli.models : []
  const source = Array.isArray(raw.models)
    ? raw.models
    : raw.agent !== null && typeof raw.agent === 'object' && Array.isArray(raw.agent.models)
      ? raw.agent.models
      : []
  const byId = new Map(source.filter((model) => model?.id !== undefined).map((model) => [model.id, model]))
  // 旧响应没有 agents：暴露全量 models，保持与旧 /v3/config 兼容。
  if (allowed.length === 0 && !Array.isArray(agents)) {
    allowed = source.map((model) => model?.id).filter((id) => id !== undefined)
  }
  const models = []
  for (const id of allowed) {
    if (typeof id !== 'string') continue
    const model = byId.get(id)
    if (model === undefined) continue
    const parsed = parseModel(model)
    if (parsed !== undefined) models.push(parsed)
  }
  return models
}

/**
 * 解析单个模型条目。
 * @param {any} raw
 * @returns {any|undefined}
 */
function parseModel(raw) {
  const id = typeof raw?.id === 'string' && raw.id.length > 0 ? raw.id : undefined
  if (id === undefined) return undefined
  const contextWindow = positiveInteger(
    raw.maxInputTokens,
    contextWindowLength(raw.contextWindow),
    raw.maxAllowedSize,
  )
  const maxTokens = positiveInteger(raw.maxOutputTokens)
  if (contextWindow === undefined || maxTokens === undefined) return undefined
  const credits = typeof raw.credits === 'string' ? /x[\d.]+/i.exec(raw.credits)?.[0] : undefined
  const baseName = typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : id
  const reasoning = remoteModelReasoning(raw)
  return {
    id,
    name: credits === undefined ? baseName : `${baseName} · ${credits}`,
    contextWindow,
    maxTokens,
    images: raw.supportsImages === true,
    ...reasoning,
  }
}

/**
 * 解析思考能力。只有服务端明确声明支持推理时才声明。
 * @param {any} raw
 * @returns {{ reasoning: boolean, onlyReasoning?: boolean, thinkingLevels?: string[], defaultReasoningEffort?: string }}
 */
function remoteModelReasoning(raw) {
  const supported = Array.isArray(raw?.reasoning?.supportedEfforts)
    ? raw.reasoning.supportedEfforts
    : undefined
  const declared = raw?.thinkingLevelMap !== null && typeof raw?.thinkingLevelMap === 'object'
    ? raw.thinkingLevelMap
    : undefined
  const mapped = declared === undefined
    ? undefined
    : EFFORTS.filter((level) => typeof declared[level] === 'string' && declared[level].length > 0)
  const fromSupported = supported === undefined
    ? undefined
    : EFFORTS.filter((level) => supported.includes(level))
  // 固定档位形态：`reasoning: { effort: "high" }` 表示只有一个可用档位。
  const fixed = typeof raw?.reasoning?.effort === 'string' && EFFORTS.includes(raw.reasoning.effort)
    ? [raw.reasoning.effort]
    : undefined
  const thinkingLevels = fromSupported
    ?? (mapped !== undefined && mapped.length > 0 ? mapped : undefined)
    ?? fixed
  const reasoning = raw?.supportsReasoning === true
    || raw?.onlyReasoning === true
    || thinkingLevels !== undefined
  if (!reasoning) return { reasoning: false }
  const candidate = raw?.reasoning?.defaultEffort ?? raw?.reasoning?.effort
  const defaultReasoningEffort = typeof candidate === 'string' && EFFORTS.includes(candidate)
    ? candidate
    : undefined
  return {
    reasoning: true,
    ...(raw?.onlyReasoning === true ? { onlyReasoning: true } : {}),
    ...(thinkingLevels === undefined || thinkingLevels.length === 0 ? {} : { thinkingLevels }),
    ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }),
  }
}

/**
 * 取第一个正安全整数。
 * @param {...(number|undefined)} values
 * @returns {number|undefined}
 */
function positiveInteger(...values) {
  for (const value of values) {
    if (Number.isSafeInteger(value) && value > 0) return value
  }
  return undefined
}

/**
 * 解析 `contextWindow`：旧版为数字，新版为 `{ defaultLength, supportedLengths }`。
 * @param {unknown} value
 * @returns {number|undefined}
 */
function contextWindowLength(value) {
  if (typeof value === 'number') return positiveInteger(value)
  if (value === null || typeof value !== 'object') return undefined
  const raw = /** @type {any} */ (value)
  const supported = Array.isArray(raw.supportedLengths)
    ? raw.supportedLengths.filter((length) => Number.isSafeInteger(length) && length > 0)
    : []
  const defaultLength = positiveInteger(raw.defaultLength)
  if (supported.length === 0) return defaultLength
  const max = Math.max(...supported)
  if (defaultLength !== undefined && defaultLength <= max) return defaultLength
  return Math.min(...supported)
}

/**
 * 模型目录读取失败时的兜底显示：不编造容量，只保留已知 id。
 * @param {string[]} ids
 * @returns {Array<any>}
 */
export function fallbackModels(ids) {
  return ids.map((id) => ({
    id,
    name: id,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    images: false,
    reasoning: false,
  }))
}
