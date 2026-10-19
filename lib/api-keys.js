/**
 * CodeBuddy CLI API Key 的本地集合。
 *
 * 密钥本体存进凭据服务（每个 Key 一个引用），集合本身只保存引用名、展示名、
 * 环境与账号快照。因此设置页的 status 永远只返回掩码，不会回传明文。
 *
 * @module dsh-plugin-workbuddy-lite/api-keys
 */

import { randomBytes } from 'node:crypto'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  API_KEY_ENV,
  API_KEY_STORE_REF,
  API_ENVIRONMENT_LABELS,
  API_ENVIRONMENT_ORIGINS,
} from './constants.js'
import { normalizeEnvironment, normalizeOrigin, resolveApiOrigin } from './clients.js'

/**
 * 生成一个符合凭据引用语法的 Key 引用。
 * @returns {string}
 */
export function createApiKeyRef() {
  return `CODEBUDDY_API_KEY_${randomBytes(8).toString('hex').toUpperCase()}`
}

/**
 * 掩码显示。
 * @param {string|undefined} value
 * @returns {string}
 */
export function maskApiKey(value) {
  const text = typeof value === 'string' ? value : ''
  if (text.length === 0) return ''
  return text.length > 8 ? `••••${text.slice(-4)}` : '••••'
}

/**
 * 规范化 API Key 集合。
 * @param {unknown} value
 * @returns {{ version: 1, activeId?: string, entries: any[] }}
 */
export function normalizeApiKeyStore(value) {
  const raw = value !== null && typeof value === 'object' ? /** @type {any} */ (value) : {}
  const entries = []
  const seen = new Set()
  for (const entry of Array.isArray(raw.entries) ? raw.entries : []) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.ref)) continue
    const environment = normalizeEnvironment(entry.environment)
    let endpoint
    if (environment === 'custom') {
      try {
        endpoint = normalizeOrigin(entry.endpoint)
      }
      catch {
        endpoint = undefined
      }
      if (endpoint === undefined) continue
    }
    const id = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : `key:${entry.ref}`
    if (seen.has(id) || seen.has(entry.ref)) continue
    seen.add(id)
    seen.add(entry.ref)
    entries.push({
      id,
      ref: entry.ref,
      label: typeof entry.label === 'string' && entry.label.trim().length > 0 ? entry.label.trim() : 'CodeBuddy API Key',
      environment,
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(entry.account !== null && typeof entry.account === 'object' ? { account: { ...entry.account } } : {}),
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
      updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
    })
  }
  const activeId = typeof raw.activeId === 'string' && seen.has(raw.activeId) ? raw.activeId : entries[0]?.id
  return { version: 1, ...(activeId === undefined ? {} : { activeId }), entries }
}

/**
 * 读取 API Key 集合。
 * @param {any} ctx
 * @returns {Promise<any>}
 */
export async function readApiKeyStore(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return normalizeApiKeyStore(undefined)
  const stored = await credentials.resolve(credentialRef(API_KEY_STORE_REF))
  if (stored?.value === undefined) return normalizeApiKeyStore(undefined)
  try {
    return normalizeApiKeyStore(JSON.parse(stored.value))
  }
  catch {
    return normalizeApiKeyStore(undefined)
  }
}

/**
 * 写入 API Key 集合。
 * @param {any} ctx
 * @param {any} store
 * @returns {Promise<void>}
 */
export async function writeApiKeyStore(ctx, store) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) throw new Error('当前组合没有凭据服务，无法保存 API Key')
  const normalized = normalizeApiKeyStore(store)
  if (normalized.entries.length === 0) {
    await credentials.unset(credentialRef(API_KEY_STORE_REF))
    return
  }
  await credentials.set(credentialRef(API_KEY_STORE_REF), JSON.stringify(normalized))
}

/**
 * 异步读取环境变量/凭据引用里的 API Key。
 *
 * 先走凭据服务的引用平面（它会覆盖进程环境与 `.env` 文件），再走 DSH 的
 * launch environment，最后才是 `process.env`，以兼容非 Web profile。
 *
 * @param {any} ctx
 * @param {string} [ref]
 * @returns {Promise<{ value: string, source: string }|undefined>}
 */
export async function readAmbientApiKeyAsync(ctx, ref = API_KEY_ENV) {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    try {
      const stored = await credentials.resolve(credentialRef(ref))
      if (typeof stored?.value === 'string' && stored.value.length > 0) {
        return { value: stored.value, source: stored.source ?? 'credential' }
      }
    }
    catch {
      // 引用不合法/环境遮蔽：继续尝试 launch environment。
    }
  }
  try {
    const fromEnvironment = launchEnvironmentOf(ctx).get(credentialRef(ref))?.value
    if (typeof fromEnvironment === 'string' && fromEnvironment.length > 0) {
      return { value: fromEnvironment, source: 'env' }
    }
  }
  catch {
    // 非 boot 环境没有 launch environment：继续尝试 process.env。
  }
  const fromProcess = process.env[ref]
  if (typeof fromProcess === 'string' && fromProcess.length > 0) {
    return { value: fromProcess, source: 'env' }
  }
  return undefined
}

/**
 * 解析当前生效的 API Key。
 *
 * 优先级：集合里的 active 条目 → `CODEBUDDY_API_KEY` 环境变量 →
 * `config.apiKeyEnv` 指向的引用。
 *
 * @param {any} ctx
 * @param {{ apiKeyEnv?: string, apiKeyEnvironment?: string }} config
 * @returns {Promise<{ value: string, entry: any, source: 'store'|'environment'|'config' }|undefined>}
 */
export async function resolveActiveApiKey(ctx, config = {}) {
  const store = await readApiKeyStore(ctx)
  const active = store.entries.find((entry) => entry.id === store.activeId) ?? store.entries[0]
  if (active !== undefined) {
    const credentials = ctx.get('credentials')
    const stored = await credentials?.resolve(credentialRef(active.ref))
    if (typeof stored?.value === 'string' && stored.value.length > 0) {
      return { value: stored.value, entry: active, source: 'store' }
    }
  }
  const environment = normalizeEnvironment(
    config.apiKeyEnvironment ?? process.env.CODEBUDDY_INTERNET_ENVIRONMENT,
  )
  const ambient = await readAmbientApiKeyAsync(ctx)
  if (ambient !== undefined) {
    return {
      value: ambient.value,
      entry: {
        id: 'env:CODEBUDDY_API_KEY',
        ref: API_KEY_ENV,
        label: '环境变量 CODEBUDDY_API_KEY',
        environment,
        ...(environment === 'custom' ? {} : {}),
        account: {},
      },
      source: 'environment',
    }
  }
  if (typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.length > 0 && config.apiKeyEnv !== API_KEY_ENV) {
    const configured = await readAmbientApiKeyAsync(ctx, config.apiKeyEnv)
    if (configured !== undefined) {
      return {
        value: configured.value,
        entry: {
          id: `ref:${config.apiKeyEnv}`,
          ref: config.apiKeyEnv,
          label: `凭据 ${config.apiKeyEnv}`,
          environment,
          account: {},
        },
        source: 'config',
      }
    }
  }
  return undefined
}

/**
 * 新增或更新一个 API Key 条目（密钥本体单独写入）。
 * @param {any} ctx
 * @param {{ key: string, label?: string, environment?: string, endpoint?: string, account?: object }} input
 * @returns {Promise<any>}
 */
export async function addApiKey(ctx, input) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) throw new Error('当前组合没有凭据服务，无法保存 API Key')
  const key = typeof input.key === 'string' ? input.key.trim() : ''
  if (key.length === 0) throw new Error('请输入 API Key')
  if (key.length > 16 * 1024) throw new Error('API Key 长度超出限制')
  const environment = normalizeEnvironment(input.environment)
  const endpoint = environment === 'custom' ? normalizeOrigin(input.endpoint) : undefined
  if (environment === 'custom' && endpoint === undefined) throw new Error('自定义环境需要填写服务地址')

  const ref = createApiKeyRef()
  const now = Date.now()
  const entry = {
    id: `key:${ref}`,
    ref,
    label: typeof input.label === 'string' && input.label.trim().length > 0 ? input.label.trim() : 'CodeBuddy API Key',
    environment,
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(input.account !== null && typeof input.account === 'object' ? { account: { ...input.account } } : {}),
    createdAt: now,
    updatedAt: now,
  }
  await credentials.set(credentialRef(ref), key)
  try {
    const store = await readApiKeyStore(ctx)
    const next = { version: 1, activeId: entry.id, entries: [...store.entries, entry] }
    await writeApiKeyStore(ctx, next)
    return entry
  }
  catch (error) {
    await credentials.unset(credentialRef(ref)).catch(() => {})
    throw error
  }
}

/**
 * 删除一个 API Key 条目及密钥本体。
 * @param {any} ctx
 * @param {string} id
 * @returns {Promise<any>}
 */
export async function removeApiKey(ctx, id) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) throw new Error('当前组合没有凭据服务，无法删除 API Key')
  const store = await readApiKeyStore(ctx)
  const entry = store.entries.find((item) => item.id === id)
  if (entry === undefined) throw new Error('没有找到该 API Key')
  await credentials.unset(credentialRef(entry.ref)).catch(() => {})
  const entries = store.entries.filter((item) => item.id !== id)
  const next = { version: 1, ...(entries[0] === undefined ? {} : { activeId: entries[0].id }), entries }
  await writeApiKeyStore(ctx, next)
  return next
}

/**
 * 切换当前 API Key。
 * @param {any} ctx
 * @param {string} id
 * @returns {Promise<any>}
 */
export async function switchApiKey(ctx, id) {
  const store = await readApiKeyStore(ctx)
  if (!store.entries.some((entry) => entry.id === id)) throw new Error('没有找到该 API Key')
  const next = { ...store, activeId: id }
  await writeApiKeyStore(ctx, next)
  return next
}

/**
 * 脱敏后的 API Key 列表。
 * @param {any} ctx
 * @param {any} [store]
 * @returns {Promise<Array<object>>}
 */
export async function publicApiKeys(ctx, store) {
  const normalized = store ?? await readApiKeyStore(ctx)
  const credentials = ctx.get('credentials')
  const items = []
  for (const entry of normalized.entries) {
    const stored = credentials === undefined
      ? undefined
      : await credentials.resolve(credentialRef(entry.ref)).catch(() => undefined)
    items.push({
      id: entry.id,
      kind: 'dsh',
      label: entry.label,
      environment: entry.environment,
      environmentLabel: API_ENVIRONMENT_LABELS[entry.environment] ?? entry.environment,
      endpoint: entry.environment === 'custom' ? entry.endpoint : API_ENVIRONMENT_ORIGINS[entry.environment],
      masked: maskApiKey(stored?.value),
      configured: typeof stored?.value === 'string' && stored.value.length > 0,
      account: entry.account ?? null,
      updatedAt: entry.updatedAt,
    })
  }
  return items
}

/**
 * 解析 API Key 条目的服务根（含自定义环境校验）。
 * @param {any} entry
 * @returns {string}
 */
export function apiOriginOf(entry) {
  return resolveApiOrigin(entry)
}
