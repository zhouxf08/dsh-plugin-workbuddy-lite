/**
 * WorkBuddy 浏览器 OAuth——握手、轮询、刷新与本地会话集合。
 *
 * 流程分两段，避免一个 HTTP 请求挂在浏览器授权上：
 *  1. `startWorkBuddyLogin()` 只创建服务端 state 并返回登录 URL；
 *  2. 前端打开 URL 后反复调用 `pollWorkBuddyToken()`，服务端返回 `pending`
 *     或最终 token。
 *
 * 这里只处理 WorkBuddy 的 OAuth 平面；模型目录与聊天在 `catalog.js` /
 * `adapter.js` 里。
 *
 * @module dsh-plugin-workbuddy-lite/workbuddy-auth
 */

import { createHash } from 'node:crypto'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  AUTH_PENDING_CODE,
  WORKBUDDY_AUTH_PREFIX,
  WORKBUDDY_ORIGIN,
  WORKBUDDY_PLATFORM,
  WORKBUDDY_SESSIONS_REF,
  WORKBUDDY_VERSION,
} from './constants.js'
import { workbuddyIdentityHeaders } from './clients.js'

/** 握手请求固定跳过的身份头，与官方客户端一致。 */
const NO_ACCOUNT_HEADERS = {
  'X-No-Authorization': 'true',
  'X-No-User-Id': 'true',
  'X-No-Enterprise-Id': 'true',
  'X-No-Department-Info': 'true',
}

/** 轮询 token 时只跳过 Authorization。 */
const NO_AUTH_HEADER = { 'X-No-Authorization': 'true' }

/**
 * 规范化 OAuth token，兼容 camelCase / snake_case 两种返回。
 * @param {unknown} raw
 * @param {number} [now]
 * @returns {{ accessToken: string, refreshToken?: string, expiresAt?: number, refreshExpiresAt?: number, domain: string }}
 */
export function normalizeToken(raw, now = Date.now()) {
  if (raw === null || typeof raw !== 'object') throw new Error('WorkBuddy 登录接口没有返回 token')
  const source = /** @type {Record<string, unknown>} */ (raw)
  const str = (camel, snake) => {
    const value = source[camel] ?? source[snake]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  const num = (camel, snake) => {
    const value = source[camel] ?? source[snake]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }
  const accessToken = str('accessToken', 'access_token')
  if (accessToken === undefined) throw new Error('WorkBuddy 登录接口没有返回 access token')
  const refreshToken = str('refreshToken', 'refresh_token')
  const expiresIn = num('expiresIn', 'expires_in')
  const refreshExpiresIn = num('refreshExpiresIn', 'refresh_expires_in')
  const explicitExpiresAt = num('expiresAt', 'expires_at')
  const jwtExpiresAt = tokenExpiresAt(accessToken)
  const expiresAt = explicitExpiresAt ?? (expiresIn === undefined ? undefined : now + expiresIn * 1000) ?? jwtExpiresAt
  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(refreshExpiresIn === undefined ? {} : { refreshExpiresAt: now + refreshExpiresIn * 1000 }),
    domain: str('domain', 'domain') ?? '',
  }
}

/**
 * 从 JWT 的 exp 读取过期时间。
 * @param {string} token
 * @returns {number|undefined}
 */
function tokenExpiresAt(token) {
  try {
    const payload = token.split('.')[1]
    if (!payload) return undefined
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return typeof parsed?.exp === 'number' && Number.isFinite(parsed.exp) ? parsed.exp * 1000 : undefined
  }
  catch {
    return undefined
  }
}

/**
 * 从 JWT 里尽力读取 uid；仅用于账号 id 兜底。
 * @param {string} token
 * @returns {string|undefined}
 */
function tokenSubject(token) {
  try {
    const payload = token.split('.')[1]
    if (!payload) return undefined
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    const value = parsed?.uid ?? parsed?.userId ?? parsed?.sub
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  catch {
    return undefined
  }
}

/**
 * 规范化登录账号，剔除空字符串字段。
 * @param {unknown} raw
 * @param {{ accessToken: string, domain?: string }} auth
 * @returns {{ uid: string, nickname?: string, uin?: string, enterpriseId?: string, enterpriseName?: string, enterpriseUserName?: string, departmentFullName?: string }}
 */
export function normalizeAccount(raw, auth) {
  const source = raw !== null && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {}
  const pick = (key) => {
    const value = source[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  const rawUid = source.uid ?? source.userId
  const uid = (typeof rawUid === 'string' && rawUid.length > 0
    ? rawUid
    : typeof rawUid === 'number' ? String(rawUid) : undefined)
    ?? tokenSubject(auth.accessToken)
  if (uid === undefined) throw new Error('WorkBuddy 登录接口没有返回账号 uid')
  return {
    uid,
    ...(pick('nickname') === undefined ? {} : { nickname: pick('nickname') }),
    ...(pick('uin') === undefined ? {} : { uin: pick('uin') }),
    ...(pick('enterpriseId') === undefined ? {} : { enterpriseId: pick('enterpriseId') }),
    ...(pick('enterpriseName') === undefined ? {} : { enterpriseName: pick('enterpriseName') }),
    ...(pick('enterpriseUserName') === undefined ? {} : { enterpriseUserName: pick('enterpriseUserName') }),
    ...(pick('departmentFullName') === undefined ? {} : { departmentFullName: pick('departmentFullName') }),
  }
}

/**
 * 解析服务端 `{code,msg,data}` 信封。
 * @param {Response} response
 * @param {string} action
 * @returns {Promise<any>}
 */
async function readEnvelope(response, action) {
  let body
  try {
    body = await response.json()
  }
  catch (error) {
    throw new Error(`${action}返回了无法解析的数据`, { cause: error })
  }
  if (body === null || typeof body !== 'object') throw new Error(`${action}返回了无效数据`)
  return body
}

/**
 * 创建浏览器登录握手。
 * @returns {Promise<{ state: string, authUrl: string }>}
 */
export async function startWorkBuddyLogin() {
  const url = `${WORKBUDDY_ORIGIN}${WORKBUDDY_AUTH_PREFIX}/auth/state?platform=${encodeURIComponent(WORKBUDDY_PLATFORM)}`
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', ...NO_ACCOUNT_HEADERS },
    })
  }
  catch (error) {
    throw new Error('无法连接 WorkBuddy 登录服务', { cause: error })
  }
  const body = await readEnvelope(response, 'WorkBuddy 登录握手')
  if (!response.ok || body.code !== 0 || body.data === undefined) {
    throw new Error(`WorkBuddy 登录握手失败：${body.msg ?? response.status}`)
  }
  const state = body.data.state
  const authUrl = body.data.authUrl
  if (typeof state !== 'string' || state.length === 0 || typeof authUrl !== 'string' || authUrl.length === 0) {
    throw new Error('WorkBuddy 登录接口没有返回可用的登录地址')
  }
  const target = new URL(authUrl)
  target.searchParams.set('version', WORKBUDDY_VERSION)
  return { state, authUrl: target.toString() }
}

/**
 * 轮询一次登录结果。
 * @param {string} state
 * @returns {Promise<{ status: 'pending' } | { status: 'done', auth: ReturnType<typeof normalizeToken> }>}
 */
export async function pollWorkBuddyToken(state) {
  let response
  try {
    response = await fetch(
      `${WORKBUDDY_ORIGIN}${WORKBUDDY_AUTH_PREFIX}/auth/token?state=${encodeURIComponent(state)}`,
      { headers: { accept: 'application/json', ...NO_AUTH_HEADER } },
    )
  }
  catch (error) {
    throw new Error('无法连接 WorkBuddy 登录服务', { cause: error })
  }
  const body = await readEnvelope(response, 'WorkBuddy 登录轮询')
  if (body.code === AUTH_PENDING_CODE) return { status: 'pending' }
  if (!response.ok || body.code !== 0 || body.data === undefined) {
    throw new Error(`WorkBuddy 登录失败：${body.msg ?? body.message ?? response.status}`)
  }
  return { status: 'done', auth: normalizeToken(body.data) }
}

/**
 * 用登录 state 读取账号资料。
 * @param {string} state
 * @param {{ accessToken: string, domain: string }} auth
 * @returns {Promise<ReturnType<typeof normalizeAccount>>}
 */
export async function fetchWorkBuddyAccount(state, auth) {
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${auth.accessToken}`,
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-Department-Info': 'true',
    'X-Domain': auth.domain ?? '',
  }
  let response
  try {
    response = await fetch(
      `${WORKBUDDY_ORIGIN}${WORKBUDDY_AUTH_PREFIX}/login/account?state=${encodeURIComponent(state)}`,
      { headers },
    )
  }
  catch (error) {
    throw new Error('无法读取 WorkBuddy 账号信息', { cause: error })
  }
  const body = await readEnvelope(response, 'WorkBuddy 账号读取')
  if (!response.ok || body.code !== 0 || body.data === undefined) {
    throw new Error(`WorkBuddy 账号读取失败：${body.msg ?? response.status}`)
  }
  return normalizeAccount(body.data, auth)
}

/**
 * 刷新 WorkBuddy 会话。
 * @param {{ auth: { accessToken: string, refreshToken?: string, domain?: string, expiresAt?: number, refreshExpiresAt?: number }, account: { uid: string, enterpriseId?: string, departmentFullName?: string } }} session
 * @returns {Promise<typeof session>}
 */
export async function refreshWorkBuddySession(session) {
  const refreshToken = session?.auth?.refreshToken
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new Error('WorkBuddy 登录凭据缺少 refresh token，请重新登录')
  }
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${session.auth.accessToken}`,
    'X-Refresh-Token': refreshToken,
    'X-Auth-Refresh-Source': 'plugin',
    ...workbuddyIdentityHeaders(session),
  }
  let response
  try {
    response = await fetch(`${WORKBUDDY_ORIGIN}${WORKBUDDY_AUTH_PREFIX}/auth/token/refresh`, {
      method: 'POST',
      headers,
    })
  }
  catch (error) {
    throw new Error('无法刷新 WorkBuddy 登录凭据', { cause: error })
  }
  const body = await readEnvelope(response, 'WorkBuddy 登录刷新')
  if (!response.ok || body.code !== 0 || body.data === undefined) {
    throw new Error(`WorkBuddy 登录刷新失败：${body.msg ?? response.status}`)
  }
  const fresh = normalizeToken(body.data)
  return {
    ...session,
    auth: {
      ...session.auth,
      ...fresh,
      // 服务端可能不轮换 refresh token，此时必须保留旧值。
      refreshToken: fresh.refreshToken ?? session.auth.refreshToken,
    },
  }
}

/**
 * 会话是否需要在下次请求前刷新。
 * @param {{ auth?: { expiresAt?: number } }} session
 * @param {number} [now]
 * @returns {boolean}
 */
export function sessionNeedsRefresh(session, now = Date.now()) {
  const expiresAt = session?.auth?.expiresAt
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) {
    return expiresAt <= now + 60_000
  }
  return true
}

/**
 * 生成稳定账号 id。
 * @param {{ account: { uid: string } }} session
 * @returns {string}
 */
export function workbuddySessionId(session) {
  return `workbuddy:${session.account.uid}`
}

/**
 * 生成展示名。
 * @param {{ account: { nickname?: string, enterpriseUserName?: string, uin?: string, uid: string } }} session
 * @returns {string}
 */
export function workbuddySessionLabel(session) {
  return session.account.nickname
    ?? session.account.enterpriseUserName
    ?? session.account.uin
    ?? `WorkBuddy ${session.account.uid.slice(-6)}`
}

/**
 * 把刚完成的登录结果组装成会话条目。
 * @param {{ auth: ReturnType<typeof normalizeToken>, account: ReturnType<typeof normalizeAccount> }} input
 * @returns {any}
 */
export function createSessionEntry(input, now = Date.now()) {
  const base = { auth: input.auth, account: input.account }
  return {
    id: workbuddySessionId(base),
    label: workbuddySessionLabel(base),
    createdAt: now,
    updatedAt: now,
    ...base,
  }
}

/**
 * 规范化磁盘/凭据里的会话集合。
 * @param {unknown} value
 * @returns {{ version: 1, activeId?: string, sessions: any[] }}
 */
export function normalizeSessionStore(value) {
  const raw = value !== null && typeof value === 'object' ? /** @type {any} */ (value) : {}
  const sessions = []
  const seen = new Set()
  for (const entry of Array.isArray(raw.sessions) ? raw.sessions : []) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.auth?.accessToken !== 'string' || entry.auth.accessToken.length === 0) continue
    if (typeof entry.account?.uid !== 'string' || entry.account.uid.length === 0) continue
    const normalized = {
      id: typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : `workbuddy:${entry.account.uid}`,
      label: typeof entry.label === 'string' && entry.label.length > 0 ? entry.label : `WorkBuddy ${entry.account.uid.slice(-6)}`,
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
      updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
      auth: { ...entry.auth },
      account: { ...entry.account },
    }
    if (seen.has(normalized.id)) continue
    seen.add(normalized.id)
    sessions.push(normalized)
  }
  const activeId = typeof raw.activeId === 'string' && seen.has(raw.activeId)
    ? raw.activeId
    : sessions[0]?.id
  return { version: 1, ...(activeId === undefined ? {} : { activeId }), sessions }
}

/**
 * 插入或更新一个会话。
 * @param {any} store
 * @param {any} session
 * @returns {any}
 */
export function upsertSession(store, session) {
  const current = normalizeSessionStore(store)
  const index = current.sessions.findIndex((entry) => entry.id === session.id)
  const next = index >= 0
    ? current.sessions.map((entry, position) => position === index ? { ...session, createdAt: entry.createdAt } : entry)
    : [...current.sessions, session]
  return { version: 1, activeId: session.id, sessions: next }
}

/**
 * 从凭据服务读取 WorkBuddy 会话集合。
 * @param {any} ctx
 * @returns {Promise<any>}
 */
export async function readSessionStore(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return normalizeSessionStore(undefined)
  const stored = await credentials.resolve(credentialRef(WORKBUDDY_SESSIONS_REF))
  if (stored?.value === undefined) return normalizeSessionStore(undefined)
  try {
    return normalizeSessionStore(JSON.parse(stored.value))
  }
  catch {
    return normalizeSessionStore(undefined)
  }
}

/**
 * 写回 WorkBuddy 会话集合。
 * @param {any} ctx
 * @param {any} store
 * @returns {Promise<void>}
 */
export async function writeSessionStore(ctx, store) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) throw new Error('当前组合没有凭据服务，无法保存 WorkBuddy 登录')
  const normalized = normalizeSessionStore(store)
  if (normalized.sessions.length === 0) {
    await credentials.unset(credentialRef(WORKBUDDY_SESSIONS_REF))
    return
  }
  await credentials.set(credentialRef(WORKBUDDY_SESSIONS_REF), JSON.stringify(normalized))
}

/**
 * 取当前会话。
 * @param {any} store
 * @returns {any|undefined}
 */
export function activeSession(store) {
  const normalized = normalizeSessionStore(store)
  return normalized.sessions.find((entry) => entry.id === normalized.activeId) ?? normalized.sessions[0]
}

/**
 * 脱敏后的账号列表，供设置页展示。
 * @param {any} store
 * @returns {Array<object>}
 */
export function publicSessions(store) {
  const normalized = normalizeSessionStore(store)
  return normalized.sessions.map((session) => ({
    id: session.id,
    label: session.label,
    uid: session.account.uid,
    nickname: session.account.nickname ?? null,
    uin: session.account.uin ?? null,
    enterpriseId: session.account.enterpriseId ?? null,
    enterpriseName: session.account.enterpriseName ?? null,
    enterpriseUserName: session.account.enterpriseUserName ?? null,
    updatedAt: session.updatedAt,
    expiresAt: session.auth.expiresAt ?? null,
  }))
}

/**
 * 把 token 指纹用于日志/错误，不暴露原文。
 * @param {string} token
 * @returns {string}
 */
export function tokenFingerprint(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 8)
}
