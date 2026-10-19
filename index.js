/**
 * WorkBuddy 浏览器登录 + CodeBuddy CLI API Key 双认证 provider。
 *
 * 插件在 `ctx.llm` 上注册 `codebuddy` 路由，并自带一个 Web 设置页：
 *  - WorkBuddy：浏览器 OAuth，登录后读取账号、模型目录并直接用于聊天；
 *  - CodeBuddy CLI：粘贴平台 API Key（中国版/海外版/iOA/自定义地址）。
 *
 * 两种模式共用同一套 OpenAI 兼容传输与模型目录解析。凭据只写入
 * `ctx.credentials`，设置页状态只回传掩码与账号元数据。
 *
 * @module dsh-plugin-workbuddy-lite
 */

import z from '@deepseek-ai/schemastery'
import {
  LlmError,
  RetryPolicySchema,
  assertUsableApiKey,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { CodeBuddyAdapter } from './lib/adapter.js'
import { fetchAccount, fetchModels } from './lib/catalog.js'
import {
  API_KEY_ENV,
  API_ENVIRONMENTS,
  AUTH_MODES,
  DISPLAY_NAME,
  NS,
  PROVIDER,
  STREAM_IDLE_TIMEOUT_MS,
  WORKBUDDY_ORIGIN,
} from './lib/constants.js'
import {
  addApiKey as storeAddApiKey,
  apiOriginOf,
  publicApiKeys,
  readAmbientApiKeyAsync,
  readApiKeyStore,
  removeApiKey as storeRemoveApiKey,
  resolveActiveApiKey,
  switchApiKey as storeSwitchApiKey,
  writeApiKeyStore,
} from './lib/api-keys.js'
import {
  activeSession,
  createSessionEntry,
  fetchWorkBuddyAccount,
  pollWorkBuddyToken,
  publicSessions,
  readSessionStore,
  refreshWorkBuddySession,
  sessionNeedsRefresh,
  startWorkBuddyLogin,
  writeSessionStore,
} from './lib/workbuddy-auth.js'
import { installWeb } from './lib/web.js'

/** Cordis 插件名。 */
export const name = 'workbuddy-lite'

/** 路由需要 LLM 服务；Web 设置页在子级里等待 webServer/credentials/settings。 */
export const inject = ['llm']

/**
 * 插件配置。
 *
 * `mode` 决定当前使用哪类凭据；其余字段是展示与传输微调。凭据本身不在配置里。
 */
export const Config = z.object({
  mode: z.union(AUTH_MODES).default('workbuddy').volatile(),
  apiKeyEnv: z.string().role('credential-ref').volatile(),
  apiKeyEnvironment: z.union(API_ENVIRONMENTS).default('internal').volatile(),
  displayName: z.string().volatile(),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).volatile(),
  retryPolicy: RetryPolicySchema.volatile(),
})

/**
 * 校验并补全配置边界。
 * @param {any} config
 * @returns {any}
 */
export function resolveProfile(config = {}) {
  const source = config ?? {}
  if (typeof source.displayName === 'string' && source.displayName.length === 0) {
    throw new Error('workbuddy-lite: displayName 不能为空')
  }
  const streamIdleTimeoutMs = source.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`workbuddy-lite: streamIdleTimeoutMs 必须是 (0, ${MAX_TIMER_DELAY_MS}] 内的数字`)
  }
  return {
    mode: AUTH_MODES.includes(source.mode) ? source.mode : 'workbuddy',
    ...(typeof source.apiKeyEnv === 'string' && source.apiKeyEnv.length > 0 ? { apiKeyEnv: source.apiKeyEnv } : {}),
    apiKeyEnvironment: API_ENVIRONMENTS.includes(source.apiKeyEnvironment) ? source.apiKeyEnvironment : 'internal',
    displayName: source.displayName ?? DISPLAY_NAME,
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(source.retryPolicy, 'workbuddy-lite: retryPolicy'),
  }
}

/**
 * 挂载插件。
 * @param {any} ctx
 * @param {any} [config]
 */
export function apply(ctx, config = {}) {
  /**
   * 读取 Cordis 的实时配置。
   *
   * rc.2 的 Loader 用 volatile getter 提供配置；直接解构会把值冻结在加载时。
   * 这里每次读一遍，并在配置对象没变时复用上一次的解析结果。
   */
  let lastRaw
  let lastGood
  const current = () => {
    const values = {}
    for (const [key, value] of Object.entries(config ?? {})) {
      values[key] = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
    }
    return values
  }
  const options = () => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = { profile: resolveProfile(raw) }
      lastRaw = raw
      lastGood = next
      return next
    }
    catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('workbuddy-lite: 配置无效，继续使用上一次有效值')
      ctx.logger.error(error)
      return lastGood
    }
  }

  /** 当前进程内的模型事实（不落设置节）。 */
  let models = []
  let modelSource
  let modelUpdatedAt = 0
  let lastError
  /** 凭据/账号变化代际：异步刷新落定时不一致就丢弃。 */
  let generation = 0
  /** WorkBuddy 刷新按会话 id 单飞。 */
  const refreshes = new Map()

  /**
   * 读取当前 WorkBuddy 凭据，必要时刷新。
   * @param {any} profile
   * @returns {Promise<any>}
   */
  const loadWorkBuddyCredential = async (profile) => {
    const store = await readSessionStore(ctx)
    const session = activeSession(store)
    if (session === undefined) {
      throw new LlmError(
        'workbuddy-lite: 尚未登录 WorkBuddy，请在设置 → CodeBuddy 里完成浏览器登录',
        'MISSING_CREDENTIAL',
      )
    }
    let currentSession = session
    if (sessionNeedsRefresh(session)) {
      let pending = refreshes.get(session.id)
      if (pending === undefined) {
        pending = refreshWorkBuddySession(session)
          .then(async (fresh) => {
            const latest = await readSessionStore(ctx)
            const updated = {
              ...fresh,
              updatedAt: Date.now(),
              createdAt: latest.sessions.find((entry) => entry.id === fresh.id)?.createdAt ?? fresh.createdAt ?? Date.now(),
            }
            const sessions = latest.sessions.map((entry) => entry.id === updated.id ? updated : entry)
            // 刷新不应改变用户当前选中的账号：保留 latest.activeId。
            await writeSessionStore(ctx, { ...latest, sessions })
            return updated
          })
          .finally(() => { refreshes.delete(session.id) })
        refreshes.set(session.id, pending)
      }
      try {
        currentSession = await pending
      }
      catch (error) {
        throw new LlmError(
          'workbuddy-lite: WorkBuddy 登录已过期，请重新登录',
          'MISSING_CREDENTIAL',
          { cause: error },
        )
      }
    }
    return {
      kind: 'workbuddy',
      value: currentSession.auth.accessToken,
      session: currentSession,
      account: currentSession.account,
      sessionId: currentSession.id,
      origin: WORKBUDDY_ORIGIN,
      baseURL: `${WORKBUDDY_ORIGIN}/v2`,
    }
  }

  /**
   * 读取当前 API Key 凭据。
   * @param {any} profile
   * @returns {Promise<any>}
   */
  const loadApiKeyCredential = async (profile) => {
    const resolved = await resolveActiveApiKey(ctx, profile)
    if (resolved === undefined) {
      throw new LlmError(
        'workbuddy-lite: 尚未配置 CodeBuddy API Key，请在设置 → CodeBuddy 里添加',
        'MISSING_CREDENTIAL',
      )
    }
    const origin = apiOriginOf(resolved.entry)
    const value = assertUsableApiKey(resolved.value, name, resolved.entry.ref ?? API_KEY_ENV)
    return {
      kind: 'api-key',
      value,
      entry: resolved.entry,
      source: resolved.source,
      account: resolved.entry.account ?? {},
      origin,
      baseURL: `${origin}/v2`,
    }
  }

  /**
   * 按当前模式解析凭据。
   * @param {string} _provider
   * @param {any} profile
   * @returns {Promise<any>}
   */
  const resolveCredential = async (_provider, profile) => {
    return profile.mode === 'apikey'
      ? loadApiKeyCredential(profile)
      : loadWorkBuddyCredential(profile)
  }

  /**
   * 拉取并缓存模型目录。
   * @param {any} credential
   * @param {AbortSignal} [signal]
   * @returns {Promise<Array<any>>}
   */
  const loadModels = async (credential, signal) => {
    const list = await fetchModels(credential, { signal })
    if (list.length === 0) {
      throw new LlmError('CodeBuddy 没有返回该凭据可用的模型', 'DISCOVERY_FAILED')
    }
    return list
  }

  /**
   * 用给定凭据刷新缓存并通知模型选择器。
   * @param {any} credential
   * @param {AbortSignal} [signal]
   * @returns {Promise<Array<any>>}
   */
  const refreshModelsWith = async (credential, signal) => {
    const issued = ++generation
    const list = await loadModels(credential, signal)
    if (issued !== generation) return models
    models = list
    modelSource = credential.kind
    modelUpdatedAt = Date.now()
    lastError = undefined
    registration?.replace([PROVIDER])
    return list
  }

  /**
   * 把账号信息写回当前凭据条目（best-effort）。
   * @param {any} credential
   * @param {any} account
   * @returns {Promise<void>}
   */
  const rememberAccount = async (credential, account) => {
    if (account === undefined || account === null) return
    if (credential.kind === 'workbuddy') {
      const store = await readSessionStore(ctx)
      const session = store.sessions.find((entry) => entry.id === credential.sessionId)
      if (session === undefined) return
      const updated = {
        ...session,
        account: { ...session.account, ...account },
        updatedAt: Date.now(),
      }
      await writeSessionStore(ctx, {
        ...store,
        sessions: store.sessions.map((entry) => entry.id === updated.id ? updated : entry),
      })
      return
    }
    const store = await readApiKeyStore(ctx)
    const entry = store.entries.find((item) => item.id === credential.entry.id)
    if (entry === undefined) return
    const updated = { ...entry, account: { ...(entry.account ?? {}), ...account }, updatedAt: Date.now() }
    await writeApiKeyStore(ctx, {
      ...store,
      entries: store.entries.map((item) => item.id === updated.id ? updated : item),
    })
  }

  /**
   * 启动时预热：解析凭据、补账号、拉目录。失败只记录，不影响挂载。
   * @returns {Promise<void>}
   */
  const warm = async () => {
    try {
      const profile = options().profile
      const credential = await resolveCredential(PROVIDER, profile)
      const account = await fetchAccount(credential)
      await rememberAccount(credential, account)
      await refreshModelsWith(credential)
    }
    catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      ctx.logger.info(`workbuddy-lite: 尚未就绪（${lastError}）`)
    }
  }

  const adapter = new CodeBuddyAdapter({
    options,
    models: () => models,
    resolveCredential,
    resolveAttachments: () => ctx.get('attachments'),
  })

  /** 注册路由；`replace` 用于账号切换后让模型选择器重拉目录。 */
  let registration
  try {
    registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  }
  catch (error) {
    ctx.logger.error('workbuddy-lite: 注册 codebuddy 路由失败')
    ctx.logger.error(error)
  }

  /**
   * 把 provider 登记到官方模型页的目录里。
   *
   * 只注册 adapter 时模型选择器不会枚举这个 provider；DSH 的模型选择器从
   * `registerConfigurableProviders` 的条目建立 provider 列表，再通过 adapter
   * 的 `listModels` 拉模型。settingsPath 为空表示没有 schema 字段要渲染，
   * 认证入口由本插件自己的 settings.section 提供。
   */
  const directoryEntry = () => ({
    provider: PROVIDER,
    displayName: options().profile.displayName ?? DISPLAY_NAME,
    settingsNs: NS,
    settingsPath: [],
    declared: false,
  })
  let directory
  try {
    directory = ctx.llm.registerConfigurableProviders?.([directoryEntry()])
  }
  catch (error) {
    ctx.logger.warn('workbuddy-lite: 注册 provider 目录失败（模型选择器可能不显示）')
    ctx.logger.warn(error)
  }

  // 模型发现：DSH 的模型选择器/设置页通过它读取目录。
  ctx.llm.registerModelDiscovery?.(NS, async (request, signal) => {
    if (request?.provider !== PROVIDER) return []
    try {
      const credential = request?.apiKey
        ? {
            kind: 'api-key',
            value: assertUsableApiKey(request.apiKey, name, 'model-discovery'),
            entry: { environment: options().profile.apiKeyEnvironment ?? 'internal', account: {} },
            origin: apiOriginOf({ environment: options().profile.apiKeyEnvironment ?? 'internal' }),
            baseURL: '',
          }
        : await resolveCredential(PROVIDER, options().profile)
      const list = await loadModels(credential, signal ?? request?.signal)
      const issued = ++generation
      if (issued === generation) {
        models = list
        modelSource = credential.kind
        modelUpdatedAt = Date.now()
      }
      return list.map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        ...(model.images ? { inputModalities: ['text', 'image'] } : {}),
      }))
    }
    catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      throw error
    }
  })

  /**
   * 设置页状态（绝不包含明文凭据）。
   * @returns {Promise<any>}
   */
  const status = async () => {
    const profile = options().profile
    const sessions = await readSessionStore(ctx)
    const keyStore = await readApiKeyStore(ctx)
    const keys = await publicApiKeys(ctx, keyStore)
    // 环境变量里的 Key 不落库，但要在设置页可见（只显示掩码）。
    const ambient = await readAmbientApiKeyAsync(ctx)
    if (ambient !== undefined && !keys.some((entry) => entry.id === 'env:CODEBUDDY_API_KEY')) {
      keys.unshift({
        id: 'env:CODEBUDDY_API_KEY',
        kind: 'environment',
        label: `环境变量 ${API_KEY_ENV}`,
        environment: profile.apiKeyEnvironment,
        environmentLabel: '环境变量',
        masked: ambient.value.length > 8 ? `••••${ambient.value.slice(-4)}` : '••••',
        configured: true,
        account: null,
        updatedAt: Date.now(),
      })
    }
    const active = activeSession(sessions)
    // 与 resolveActiveApiKey 的优先级一致：保存的 Key 优先于环境变量。
    const activeKey = keys.find((entry) => entry.kind === 'dsh' && entry.id === keyStore.activeId)
      ?? keys.find((entry) => entry.kind === 'dsh')
      ?? keys[0]
    return {
      ok: true,
      mode: profile.mode,
      displayName: profile.displayName,
      provider: {
        id: PROVIDER,
        active: models.length > 0,
        modelCount: models.length,
        modelSource: modelSource ?? null,
        modelUpdatedAt: modelUpdatedAt || null,
        error: lastError ?? null,
      },
      workbuddy: {
        authenticated: active !== undefined,
        activeId: active?.id ?? null,
        accounts: publicSessions(sessions),
      },
      apikey: {
        configured: Boolean(activeKey?.configured),
        activeId: activeKey?.id ?? null,
        entries: keys,
        environment: activeKey?.environment ?? profile.apiKeyEnvironment,
      },
    }
  }

  /**
   * 当前凭据变化后重新解析并刷新模型。
   * @returns {Promise<void>}
   */
  const refreshAfterChange = async () => {
    try {
      const credential = await resolveCredential(PROVIDER, options().profile)
      await refreshModelsWith(credential)
    }
    catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      models = []
      modelSource = undefined
      modelUpdatedAt = 0
      registration?.replace([PROVIDER])
      throw error
    }
  }

  /**
   * 写设置里的 mode。
   * @param {'workbuddy'|'apikey'} mode
   * @returns {Promise<void>}
   */
  const setMode = async (mode) => {
    if (!AUTH_MODES.includes(mode)) throw new Error('未知认证模式')
    const settings = ctx.get('settings')
    if (settings === undefined) throw new Error('当前组合没有设置服务，无法切换认证模式')
    await settings.mutate(NS, [{ op: 'set', path: ['mode'], value: mode }])
  }

  /**
   * 设置页可调用的运行时。
   */
  const runtime = {
    status,
    async setMode(mode) {
      await setMode(mode)
      await refreshAfterChange().catch(() => {})
      return status()
    },
    async startWorkBuddyLogin() {
      return startWorkBuddyLogin()
    },
    async pollWorkBuddyLogin(state) {
      const result = await pollWorkBuddyToken(state)
      if (result.status === 'pending') return { ok: true, phase: 'pending', state: await status() }
      const account = await fetchWorkBuddyAccount(state, result.auth)
      const session = createSessionEntry({ auth: result.auth, account })
      const store = await readSessionStore(ctx)
      const existing = store.sessions.find((entry) => entry.id === session.id)
      const sessions = store.sessions.filter((entry) => entry.id !== session.id)
      await writeSessionStore(ctx, {
        version: 1,
        activeId: session.id,
        sessions: [...sessions, { ...session, createdAt: existing?.createdAt ?? Date.now() }],
      })
      await setMode('workbuddy')
      try {
        await refreshAfterChange()
      }
      catch {
        // 登录成功但目录拉取失败时仍保留会话，让用户稍后重试刷新。
      }
      return { ok: true, phase: 'done', state: await status() }
    },
    async switchWorkBuddy(accountId) {
      const store = await readSessionStore(ctx)
      if (!store.sessions.some((entry) => entry.id === accountId)) throw new Error('没有找到该 WorkBuddy 账号')
      await writeSessionStore(ctx, { ...store, activeId: accountId })
      await setMode('workbuddy')
      await refreshAfterChange().catch(() => {})
      return status()
    },
    async removeWorkBuddy(accountId) {
      const store = await readSessionStore(ctx)
      const sessions = store.sessions.filter((entry) => entry.id !== accountId)
      if (sessions.length === store.sessions.length) throw new Error('没有找到该 WorkBuddy 账号')
      const activeId = store.activeId === accountId ? sessions[0]?.id : store.activeId
      await writeSessionStore(ctx, { version: 1, ...(activeId === undefined ? {} : { activeId }), sessions })
      if (sessions.length === 0 && options().profile.mode === 'workbuddy') {
        // 没有 WorkBuddy 账号了：如果还有 API Key，自动切过去，避免 provider 悬空。
        const keys = await readApiKeyStore(ctx)
        if (keys.entries.length > 0) await setMode('apikey')
      }
      await refreshAfterChange().catch(() => {})
      return status()
    },
    async addApiKey(input) {
      const profile = options().profile
      const environment = input?.environment ?? profile.apiKeyEnvironment
      const probe = {
        kind: 'api-key',
        value: input?.key,
        entry: {
          environment,
          ...(environment === 'custom' ? { endpoint: input?.endpoint } : {}),
          account: {},
        },
        origin: apiOriginOf({
          environment,
          ...(environment === 'custom' ? { endpoint: input?.endpoint } : {}),
        }),
        baseURL: '',
      }
      // 先补企业上下文，再拉目录：企业 Key 的模型列表可能按 enterpriseId 裁剪。
      const account = await fetchAccount(probe)
      if (account !== undefined) {
        probe.account = account
        probe.entry.account = account
      }
      const list = await loadModels(probe)
      await storeAddApiKey(ctx, {
        key: input?.key,
        label: input?.label,
        environment,
        ...(environment === 'custom' ? { endpoint: input?.endpoint } : {}),
        ...(account === undefined ? {} : { account }),
      })
      await setMode('apikey')
      models = list
      modelSource = 'api-key'
      modelUpdatedAt = Date.now()
      lastError = undefined
      registration?.replace([PROVIDER])
      return status()
    },
    async switchApiKey(id) {
      // 环境变量 Key 不在集合里：只需把模式切到 apikey，解析时自然会用它。
      if (id !== 'env:CODEBUDDY_API_KEY') await storeSwitchApiKey(ctx, id)
      await setMode('apikey')
      await refreshAfterChange().catch(() => {})
      return status()
    },
    async removeApiKey(id) {
      if (id === 'env:CODEBUDDY_API_KEY') {
        throw new Error('环境变量 CODEBUDDY_API_KEY 不能在设置页删除；请修改启动环境')
      }
      await storeRemoveApiKey(ctx, id)
      const keys = await readApiKeyStore(ctx)
      if (keys.entries.length === 0 && options().profile.mode === 'apikey') {
        const sessions = await readSessionStore(ctx)
        if (sessions.sessions.length > 0) await setMode('workbuddy')
      }
      await refreshAfterChange().catch(() => {})
      return status()
    },
    async refreshModels() {
      await refreshAfterChange()
      return status()
    },
  }

  installWeb(ctx, runtime)

  // 设置页由本插件自绘，关掉 schema 自动表单，避免同一份值出现两个编辑入口。
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(
      () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
      'workbuddy-lite: settings page policy',
    )
  })

  // 配置热更新后重新广播路由，让模型选择器读取新的 displayName/profile。
  ctx.on('loader/volatile-update', () => {
    lastRaw = undefined
    registration?.replace([PROVIDER])
    directory?.replace?.([directoryEntry()])
  })

  // 凭据是异步挂载的服务：在它可用之前 warm 会读到空集合，表现为「重启后
  // 明明有 Key 却提示未配置」。把预热放进 credentials 的 inject 子级。
  ctx.inject(['credentials', 'settings'], () => {
    void warm()
  })
}
