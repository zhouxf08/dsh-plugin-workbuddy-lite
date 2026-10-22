/**
 * 设置页的 HTTP 路由。
 *
 * 只接受本机回环地址 + 同源 POST；响应永不包含明文凭据。路由很薄，真正的
 * 业务在 `index.js` 的 runtime 里，这样 host 端的状态与 UI 状态只有一个来源。
 *
 * @module dsh-plugin-workbuddy-lite/web
 */

import { WEB_ROUTE } from './constants.js'

/**
 * 判断请求是否来自本机 DSH 页面。
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function localRequest(req) {
  const address = req.socket.remoteAddress
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  if (!loopback) return false
  // 自定义请求头是主要判据：跨站 JS 要设置它必须先过 CORS 预检，而本服务
  // 不响应预检；跨站表单也设不了自定义头。
  if (req.headers['x-dsh-plugin'] === 'workbuddy-lite') return true
  const origin = req.headers.origin
  if (origin) {
    try {
      return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)
    }
    catch {
      return false
    }
  }
  // 同源 GET 不带 Origin，但现代浏览器都会带 Sec-Fetch-Site；Referer 兜底。
  const site = req.headers['sec-fetch-site']
  if (site === 'same-origin') return true
  const referer = req.headers.referer
  if (typeof referer === 'string') {
    try {
      return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(referer).hostname)
    }
    catch {
      return false
    }
  }
  return false
}

/**
 * 写 JSON 响应。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {any} body
 */
function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

/**
 * 读取 JSON 请求体。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
async function requestBody(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk.toString()
    if (raw.length > 64 * 1024) throw new Error('请求体过大')
  }
  if (raw.trim().length === 0) return {}
  let value
  try {
    value = JSON.parse(raw)
  }
  catch {
    throw new Error('请求参数格式无效')
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/**
 * 把任意 handler 收敛为「永不抛到 HTTP 层」。
 * @param {(req: any, res: any) => Promise<void>} handler
 * @param {string} label
 * @returns {(req: any, res: any) => Promise<void>}
 */
function wrap(handler, label) {
  return async (req, res) => {
    try {
      await handler(req, res)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      json(res, 500, { ok: false, message: `${label}：${message}` })
    }
  }
}

/**
 * 注册设置页路由。
 * @param {any} ctx
 * @param {any} runtime
 */
export function installWeb(ctx, runtime) {
  ctx.inject(['webServer', 'credentials', 'settings'], (webCtx) => {
    /**
     * 构造一个只接受 POST 的小 handler。
     * @param {string} label
     * @param {(body: any) => Promise<any>} action
     * @returns {(req: any, res: any) => Promise<void>}
     */
    const post = (label, action) => wrap(async (req, res) => {
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, message: 'Method not allowed' })
        return
      }
      if (!localRequest(req)) {
        json(res, 403, { ok: false, message: '只允许从本机 DSH 页面操作' })
        return
      }
      const body = await requestBody(req)
      const result = await action(body)
      json(res, 200, result !== null && typeof result === 'object' ? result : { ok: true })
    }, label)

    const status = wrap(async (req, res) => {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, message: 'Method not allowed' })
        return
      }
      if (!localRequest(req)) {
        json(res, 403, { ok: false, message: '只允许从本机 DSH 页面读取' })
        return
      }
      json(res, 200, await runtime.status())
    }, '读取状态')

    const register = (path, handler) => webCtx.webServer.register({
      kind: 'exact',
      path: `${WEB_ROUTE}${path}`,
      handler,
    })

    webCtx.effect(() => {
      const disposers = [
        register('/status', status),
        register('/mode', post('切换认证模式', async (body) => {
          if (body?.mode !== 'workbuddy' && body?.mode !== 'apikey') throw new Error('未知认证模式')
          return runtime.setMode(body.mode)
        })),
        register('/workbuddy/start', post('创建 WorkBuddy 登录', async () => {
          const start = await runtime.startWorkBuddyLogin()
          return { ok: true, ...start }
        })),
        register('/workbuddy/poll', post('轮询 WorkBuddy 登录', async (body) => {
          const state = typeof body?.state === 'string' ? body.state.trim() : ''
          if (state.length === 0) throw new Error('缺少登录 state')
          return runtime.pollWorkBuddyLogin(state)
        })),
        register('/workbuddy/switch', post('切换 WorkBuddy 账号', async (body) => {
          const accountId = typeof body?.accountId === 'string' ? body.accountId : ''
          if (accountId.length === 0) throw new Error('缺少账号 id')
          return runtime.switchWorkBuddy(accountId)
        })),
        register('/workbuddy/remove', post('删除 WorkBuddy 账号', async (body) => {
          const accountId = typeof body?.accountId === 'string' ? body.accountId : ''
          if (accountId.length === 0) throw new Error('缺少账号 id')
          return runtime.removeWorkBuddy(accountId)
        })),
        register('/apikey/add', post('保存 API Key', async (body) => {
          const key = typeof body?.key === 'string' ? body.key.trim() : ''
          if (key.length === 0) throw new Error('请输入 API Key')
          return runtime.addApiKey({
            key,
            label: body?.label,
            environment: body?.environment,
            endpoint: body?.endpoint,
          })
        })),
        register('/apikey/switch', post('切换 API Key', async (body) => {
          const id = typeof body?.id === 'string' ? body.id : ''
          if (id.length === 0) throw new Error('缺少 API Key id')
          return runtime.switchApiKey(id)
        })),
        register('/apikey/remove', post('删除 API Key', async (body) => {
          const id = typeof body?.id === 'string' ? body.id : ''
          if (id.length === 0) throw new Error('缺少 API Key id')
          return runtime.removeApiKey(id)
        })),
        register('/models/refresh', post('刷新模型目录', async () => runtime.refreshModels())),
        register('/models/prefs', post('保存模型偏好', async (body) => {
          const disabled = Array.isArray(body?.disabled) ? body.disabled : []
          return runtime.setModelPrefs(disabled)
        })),
        register('/credits/refresh', post('刷新积分余额', async () => runtime.refreshCredits())),
        register('/diagnose', post('诊断上游连接', async () => runtime.diagnose())),
      ]
      return () => disposers.forEach((dispose) => {
        try {
          dispose()
        }
        catch {
          // 路由已随 webServer 释放：忽略重复 dispose。
        }
      })
    }, 'workbuddy-lite: settings routes')
  })
}
