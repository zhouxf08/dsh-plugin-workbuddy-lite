/**
 * 模型启用/禁用偏好。
 *
 * 只保存被禁用的模型 id；未记录的一律视为启用。这样上游新增模型会默认出现，
 * 老配置也不会因为目录变化而失效。
 *
 * @module dsh-plugin-workbuddy-lite/model-prefs
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { MODEL_PREFS_REF } from './constants.js'

/**
 * 规范化偏好集合。
 * @param {unknown} value
 * @returns {{ version: 1, disabled: string[] }}
 */
export function normalizeModelPrefs(value) {
  const raw = value !== null && typeof value === 'object' ? /** @type {any} */ (value) : {}
  const disabled = []
  const seen = new Set()
  for (const id of Array.isArray(raw.disabled) ? raw.disabled : []) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    disabled.push(id)
  }
  return { version: 1, disabled }
}

/**
 * 读取偏好。
 * @param {any} ctx
 * @returns {Promise<ReturnType<typeof normalizeModelPrefs>>}
 */
export async function readModelPrefs(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return normalizeModelPrefs(undefined)
  const stored = await credentials.resolve(credentialRef(MODEL_PREFS_REF))
  if (stored?.value === undefined) return normalizeModelPrefs(undefined)
  try {
    return normalizeModelPrefs(JSON.parse(stored.value))
  }
  catch {
    return normalizeModelPrefs(undefined)
  }
}

/**
 * 写入偏好。
 * @param {any} ctx
 * @param {unknown} prefs
 * @returns {Promise<ReturnType<typeof normalizeModelPrefs>>}
 */
export async function writeModelPrefs(ctx, prefs) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) throw new Error('当前组合没有凭据服务，无法保存模型偏好')
  const normalized = normalizeModelPrefs(prefs)
  await credentials.set(credentialRef(MODEL_PREFS_REF), JSON.stringify(normalized))
  return normalized
}

/**
 * 过滤出启用的模型。
 * @param {Array<any>} models
 * @param {ReturnType<typeof normalizeModelPrefs>} prefs
 * @returns {Array<any>}
 */
export function filterEnabledModels(models, prefs) {
  const disabled = new Set(normalizeModelPrefs(prefs).disabled)
  return models.filter((model) => !disabled.has(model.id))
}

/**
 * 给设置页的公开偏好。
 * @param {ReturnType<typeof normalizeModelPrefs>} prefs
 * @returns {{ disabled: string[] }}
 */
export function publicModelPrefs(prefs) {
  return { disabled: [...normalizeModelPrefs(prefs).disabled] }
}
