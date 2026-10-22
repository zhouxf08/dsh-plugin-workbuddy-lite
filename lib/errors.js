/**
 * 上游失败的分类与可执行提示。
 *
 * WorkBuddy 网关用业务码表达「不是账号的问题」：渠道校验、排队、模型繁忙、
 * 积分耗尽、会话失效。若原样抛给用户，会被误读成「账号坏了 / 地址填错」，
 * 或者被宿主当成可重试的普通失败。这里把原文归类，并给出下一步动作。
 *
 * @module dsh-plugin-workbuddy-lite/errors
 */

/** 中性 system 开头：渠道指纹白名单的绕过文本。 */
export const NEUTRAL_SYSTEM_HEAD = 'You are a helpful assistant.'

/** 上游会按开头指纹拒绝的第三方 agent prompt（实测快照）。 */
export const UNAPPROVED_SYSTEM_OPENINGS = [
  'you are an ai agent powered by deepseek harness',
  "you are claude code, anthropic's official cli for claude",
]

/** 业务码：模型级限流（「稍等一分钟」），不是账号问题。 */
const MODEL_BUSY_CODE = '"code":14003'

/** 业务码：渠道校验拒绝。 */
const CHANNEL_REJECT_CODE = '"code":11128'

/** 业务码：积分耗尽。 */
const CREDITS_EXHAUSTED_CODE = '"code":14018'

/** 渠道校验里「system 开头被指纹命中」的措辞。 */
const CHANNEL_WORDING = 'unapproved channel'

/** 会话失效措辞。 */
const SESSION_DEAD_MARKERS = ['Offline user session not found', '12153']

/** 积分耗尽措辞（单复数都覆盖）。 */
const CREDIT_MARKERS = [
  'insufficient credit',
  'no credit',
  'credit exhausted',
  'credits exhausted',
  'out of credit',
  'credit not enough',
  'not enough credit',
  '积分不足',
  '额度不足',
  '余额不足',
]

/** 内容策略拒绝。 */
const POLICY_MARKERS = ['request illegal', '"code":11140']

/**
 * system 文本是否以上游会拒绝的开头起始。
 * @param {string} text
 * @returns {boolean}
 */
export function isUnapprovedOpening(text) {
  const opening = String(text ?? '').replace(/^\s+/u, '').toLowerCase()
  return UNAPPROVED_SYSTEM_OPENINGS.some((prefix) => opening.startsWith(prefix))
}

/**
 * 是否已经带着中性开头。
 * @param {string} text
 * @returns {boolean}
 */
export function startsWithNeutralHead(text) {
  return String(text ?? '').replace(/^\s+/u, '').toLowerCase().startsWith(NEUTRAL_SYSTEM_HEAD.toLowerCase())
}

/**
 * 给 system 文本加中性开头。
 * @param {string} text
 * @returns {string}
 */
export function neutralizeSystemText(text) {
  const value = typeof text === 'string' ? text : ''
  if (value.trim().length === 0) return NEUTRAL_SYSTEM_HEAD
  if (startsWithNeutralHead(value)) return value
  if (!isUnapprovedOpening(value)) return value
  return `${NEUTRAL_SYSTEM_HEAD}\n\n${value}`
}

/**
 * 解析上游错误体里的业务码。
 * @param {string} raw
 * @returns {number|undefined}
 */
export function businessCode(raw) {
  const text = String(raw ?? '')
  const withChildren = /"error"\s*:\s*\{[^{}]*"code"\s*:\s*(\d+)/u.exec(text)
  if (withChildren !== null) return Number(withChildren[1])
  const direct = /"code"\s*:\s*(\d+)/u.exec(text)
  return direct === null ? undefined : Number(direct[1])
}

/**
 * 把一次失败归类。
 * @param {{ status: number, body: string }} input
 * @returns {{ kind: string, message: string, retryable: boolean }}
 */
export function classifyFailure({ status, body }) {
  const raw = String(body ?? '')
  const lower = raw.toLowerCase()
  const code = businessCode(raw)

  if (code === 6020 || code === 6021 || code === 6022) {
    return {
      kind: 'queue',
      message: '模型排队中：上游把这条请求放进了队列。请稍后重新发送这条消息，或换一个模型。',
      // 队列跟随模型与平台，换账号拿到的是同一个位次，重试也不会更快。
      retryable: false,
    }
  }
  if (code === 11128) {
    if (lower.includes(CHANNEL_WORDING) || lower.includes('渠道校验')) {
      return {
        kind: 'channel',
        message: 'WorkBuddy 拒绝了这次调用的渠道校验。插件会自动加中性 system 开头并重试一次；若仍然失败，通常是上游收紧了客户端校验。',
        retryable: true,
      }
    }
    return {
      kind: 'channel',
      message: 'WorkBuddy 渠道校验失败（缺少会话身份）。请重试；若持续失败请升级插件。',
      retryable: true,
    }
  }
  if (code === 14003) {
    return {
      kind: 'model-busy',
      message: '该模型当前繁忙（上游 14003）。请等一会儿再发，或换一个空闲模型。',
      retryable: false,
    }
  }
  if (code === 14018 || CREDIT_MARKERS.some((marker) => lower.includes(marker))) {
    return {
      kind: 'credits',
      message: '积分已用尽。请到 WorkBuddy 客户端充值或领取积分后再试。',
      retryable: false,
    }
  }
  if (SESSION_DEAD_MARKERS.some((marker) => raw.includes(marker))) {
    return {
      kind: 'session',
      message: 'WorkBuddy 登录已失效，请在 CodeBuddy 配置里重新登录。',
      retryable: false,
    }
  }
  if (POLICY_MARKERS.some((marker) => lower.includes(marker.toLowerCase()))) {
    return {
      kind: 'policy',
      message: '请求被上游内容策略拒绝。请调整消息内容后重试。',
      retryable: false,
    }
  }
  if (status === 401 || status === 403) {
    return {
      kind: 'auth',
      message: 'WorkBuddy 拒绝了当前凭据。请重新登录，或换一个账号 / API Key。',
      retryable: false,
    }
  }
  if (status === 429) {
    return {
      kind: 'rate-limit',
      message: '上游限流（HTTP 429）。请稍后重试，或换一个模型。',
      retryable: true,
    }
  }
  if (status >= 500) {
    return {
      kind: 'server',
      message: `WorkBuddy 服务端错误（HTTP ${status}）。请稍后重试。`,
      retryable: true,
    }
  }
  return {
    kind: 'client',
    message: `请求被上游拒绝（HTTP ${status}）。`,
    retryable: false,
  }
}

/**
 * 给一段原始错误文本生成友好的单行摘要。
 * @param {{ status: number, body: string }} input
 * @returns {string}
 */
export function describeFailure({ status, body }) {
  const classified = classifyFailure({ status, body })
  const code = businessCode(body)
  return code === undefined ? classified.message : `${classified.message}（code ${code}）`
}
