/**
 * WorkBuddy 只读积分余额。
 *
 * 走官方客户端的 billing 端点，只读、不扣费；只对 WorkBuddy 登录凭据有效，
 * API Key 没有用户 token，不查询。
 *
 * @module dsh-plugin-workbuddy-lite/credits
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import { CREDITS_ORIGIN, CREDITS_TIMEOUT_MS } from './constants.js'

/**
 * 把 Date 格式化为上游要求的本地时间。
 * @param {Date} date
 * @returns {string}
 */
function formatDate(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 解析 billing 响应里的剩余积分。
 *
 * 上游把整数容量和精确小数分开返回（`CapacityRemain` / `CapacityRemainPrecise`），
 * 官方客户端读的是精确字段；优先用精确值，缺失时退回整数。
 * @param {any} body
 * @returns {{ total: number, packages: number }}
 */
export function parseCredits(body) {
  const accounts = body?.data?.Response?.Data?.Accounts
  if (!Array.isArray(accounts)) return { total: 0, packages: 0 }
  let total = 0
  let packages = 0
  for (const account of accounts) {
    if (account === null || typeof account !== 'object') continue
    const precise = (key) => {
      const raw = account[`${key}Precise`]
      if (typeof raw === 'string' && raw !== '') {
        const parsed = Number.parseFloat(raw)
        if (Number.isFinite(parsed)) return parsed
      }
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw
      const integer = account[key]
      return typeof integer === 'number' && Number.isFinite(integer) ? integer : 0
    }
    const hasCycle = account.CycleCapacityRemain !== undefined || account.CycleCapacityRemainPrecise !== undefined
    const remain = hasCycle ? precise('CycleCapacityRemain') : precise('CapacityRemain')
    if (remain > 0) {
      total += remain
      packages += 1
    }
  }
  return { total: Math.round(total * 100) / 100, packages }
}

/**
 * 查询一次积分余额。
 * @param {any} credential
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ total: number, packages: number, updatedAt: number }>}
 */
export async function fetchCredits(credential, options = {}) {
  if (credential?.kind !== 'workbuddy') {
    throw new LlmError('积分余额只支持 WorkBuddy 登录凭据', 'UNSUPPORTED')
  }
  const now = new Date()
  const url = `${CREDITS_ORIGIN}/v2/billing/meter/get-user-resource`
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${credential.value}`,
  }
  const account = credential.account ?? {}
  if (typeof account.uid === 'string' && account.uid.length > 0) headers['X-User-Id'] = account.uid
  if (typeof account.enterpriseId === 'string' && account.enterpriseId.length > 0) {
    headers['X-Enterprise-Id'] = account.enterpriseId
    headers['X-Tenant-Id'] = account.enterpriseId
  }
  const domain = credential.session?.auth?.domain
  if (typeof domain === 'string' && domain.length > 0) headers['X-Domain'] = domain

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: 'p_tcaca',
        Status: [0, 3],
        PackageEndTimeRangeBegin: formatDate(now),
        PackageEndTimeRangeEnd: formatDate(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
      }),
      signal: options.signal === undefined
        ? AbortSignal.timeout(CREDITS_TIMEOUT_MS)
        : AbortSignal.any([options.signal, AbortSignal.timeout(CREDITS_TIMEOUT_MS)]),
    })
  }
  catch (error) {
    if (options.signal?.aborted) throw new LlmError('积分余额查询已取消', 'ABORTED', { cause: error })
    throw new LlmError(`无法连接积分接口：${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  let body
  try {
    body = await response.json()
  }
  catch (error) {
    throw new LlmError('积分接口返回了无法解析的数据', 'DISCOVERY_FAILED', { cause: error })
  }
  if (!response.ok || body?.code !== 0) {
    throw new LlmError(
      `积分查询失败：${body?.msg ?? body?.message ?? `HTTP ${response.status}`}`,
      response.status === 401 || response.status === 403 ? 'AUTH' : 'DISCOVERY_FAILED',
    )
  }
  return { ...parseCredits(body), updatedAt: Date.now() }
}
