/**
 * 设置 → CodeBuddy 的浏览器端。
 *
 * 不依赖 DSH 内部 UI 组件库：只用 React 与 DSH 的 CSS 变量，样式随深浅色
 * 自动切换。所有认证操作都走 host 的 `/workbuddy-lite` 路由；浏览器
 * 永远拿不到明文 Key 或 token。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-workbuddy-lite',
  factory: (require) => {
    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')
    const { useEffect, useRef, useState } = React

    const NS = 'settings.workbuddy-lite'
    const ROUTE = '/workbuddy-lite'

    const zh = {
      nav: 'CodeBuddy',
      title: 'CodeBuddy / WorkBuddy',
      intro: '两种认证方式任选其一：WorkBuddy 浏览器登录，或 CodeBuddy CLI 平台的 API Key。凭据只保存在本机 DSH 凭据库。',
      modeWorkbuddy: 'WorkBuddy 浏览器',
      modeApiKey: 'CodeBuddy CLI API Key',
      workbuddyHint: '点击登录会打开 WorkBuddy 授权页，完成授权后本页会自动读取账号与模型目录。',
      login: '登录 WorkBuddy',
      relogin: '添加另一个 WorkBuddy 账号',
      loggingIn: '等待浏览器授权…',
      openLogin: '重新打开授权页',
      cancelLogin: '取消等待',
      account: 'WorkBuddy 账号',
      switch: '切换',
      remove: '删除',
      noAccounts: '还没有 WorkBuddy 账号',
      loggedIn: '已登录',
      apiKeyHint: '在 CodeBuddy 平台（copilot.tencent.com/profile 或 codebuddy.ai/profile/keys）创建 API Key 后粘贴到这里。',
      apiKeyInput: '粘贴 API Key',
      apiKeyLabel: '备注名（可选）',
      apiKeyAdd: '保存并使用',
      apiKeyCurrent: '当前 API Key',
      apiKeyRemove: '删除',
      noKeys: '还没有保存的 API Key',
      environment: '服务环境',
      envInternal: '中国版（copilot.tencent.com）',
      envExternal: '海外版（codebuddy.ai）',
      envIoa: 'iOA 企业版',
      envCustom: '自定义服务地址',
      endpoint: '服务地址',
      endpointPlaceholder: 'https://your-company.example.com',
      models: '模型目录',
      modelsReady: '已加载 {count} 个模型',
      modelsMissing: '尚未加载模型',
      refreshModels: '刷新模型目录',
      refresh: '刷新',
      loading: '读取中…',
      working: '处理中…',
      saved: '已保存',
      error: '操作失败',
      active: '使用中',
      use: '使用',
      source: '模型来源',
      sourceWorkbuddy: 'WorkBuddy',
      sourceApiKey: 'API Key',
      noSource: '未配置',
      envSource: '环境变量',
      cancel: '取消',
    }

    const en = {
      nav: 'CodeBuddy',
      title: 'CodeBuddy / WorkBuddy',
      intro: 'Choose one of two sign-in methods: WorkBuddy browser OAuth, or a CodeBuddy CLI platform API key. Credentials stay in the local DSH credential store.',
      modeWorkbuddy: 'WorkBuddy browser',
      modeApiKey: 'CodeBuddy CLI API key',
      workbuddyHint: 'Clicking sign in opens the WorkBuddy authorization page. This panel then picks up the account and model catalog automatically.',
      login: 'Sign in with WorkBuddy',
      relogin: 'Add another WorkBuddy account',
      loggingIn: 'Waiting for browser authorization…',
      openLogin: 'Reopen authorization page',
      cancelLogin: 'Stop waiting',
      account: 'WorkBuddy account',
      switch: 'Switch',
      remove: 'Remove',
      noAccounts: 'No WorkBuddy account yet',
      loggedIn: 'Signed in',
      apiKeyHint: 'Create an API key at copilot.tencent.com/profile or codebuddy.ai/profile/keys, then paste it here.',
      apiKeyInput: 'Paste API key',
      apiKeyLabel: 'Label (optional)',
      apiKeyAdd: 'Save and use',
      apiKeyCurrent: 'Current API key',
      apiKeyRemove: 'Remove',
      noKeys: 'No saved API key yet',
      environment: 'Service environment',
      envInternal: 'China (copilot.tencent.com)',
      envExternal: 'International (codebuddy.ai)',
      envIoa: 'iOA enterprise',
      envCustom: 'Custom service URL',
      endpoint: 'Service URL',
      endpointPlaceholder: 'https://your-company.example.com',
      models: 'Model catalog',
      modelsReady: '{count} models loaded',
      modelsMissing: 'No models loaded yet',
      refreshModels: 'Refresh models',
      refresh: 'Refresh',
      loading: 'Loading…',
      working: 'Working…',
      saved: 'Saved',
      error: 'Operation failed',
      active: 'Active',
      use: 'Use',
      source: 'Model source',
      sourceWorkbuddy: 'WorkBuddy',
      sourceApiKey: 'API key',
      noSource: 'Not configured',
      envSource: 'Environment',
      cancel: 'Cancel',
    }

    const inputStyle = {
      boxSizing: 'border-box',
      width: '100%',
      height: 32,
      font: 'inherit',
      background: 'var(--dsw-alias-bg-layer-1, #fff)',
      color: 'var(--dsw-alias-label-primary, #111)',
      border: '1px solid var(--dsw-alias-border-l2, #d0d5dd)',
      borderRadius: 8,
      padding: '0 10px',
      fontSize: 14,
    }
    const btnStyle = {
      font: 'inherit',
      cursor: 'pointer',
      border: '1px solid var(--dsw-alias-border-l2, #d0d5dd)',
      color: 'var(--dsw-alias-label-primary, #111)',
      background: 'transparent',
      borderRadius: 14,
      height: 28,
      padding: '0 10px',
      fontSize: 12,
    }
    const primaryStyle = {
      ...btnStyle,
      border: 'none',
      background: 'var(--dsw-alias-button-primary-fill, #111)',
      color: 'var(--dsw-alias-label-primary-foreground, #fff)',
      height: 32,
      borderRadius: 18,
      padding: '0 14px',
      fontSize: 14,
    }
    const modeBtnStyle = { ...btnStyle, height: 32, borderRadius: 18, padding: '0 16px', fontSize: 13 }
    const modeBtnActive = {
      ...modeBtnStyle,
      border: 'none',
      background: 'var(--dsw-alias-button-primary-fill, #111)',
      color: 'var(--dsw-alias-label-primary-foreground, #fff)',
    }
    const cardStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      border: '1px solid var(--dsw-alias-border-l2, #d0d5dd)',
      borderRadius: 10,
      padding: 12,
    }
    const rowStyle = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
    const hintStyle = { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #667085)' }
    const labelStyle = { color: 'var(--dsw-alias-label-secondary, #475467)', fontSize: 12, fontWeight: 500 }

    function field(label, child, hint) {
      return jsxs('label', {
        style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
        children: [
          jsx('span', { style: labelStyle, children: label }),
          child,
          hint === undefined ? null : jsx('span', { style: hintStyle, children: hint }),
        ],
      })
    }

    async function call(path, body) {
      const response = await fetch(`${ROUTE}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined
          ? { 'x-dsh-plugin': 'workbuddy-lite' }
          : { 'content-type': 'application/json', 'x-dsh-plugin': 'workbuddy-lite' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store',
      })
      let data
      try {
        data = await response.json()
      }
      catch {
        data = undefined
      }
      if (!response.ok || data?.ok === false) {
        throw new Error(data?.message ?? `HTTP ${response.status}`)
      }
      return data
    }

    function accountText(account) {
      if (account === null || typeof account !== 'object') return '未命名账号'
      return account.label
        ?? account.nickname
        ?? account.enterpriseUserName
        ?? account.uin
        ?? account.id
    }

    function SettingsSection({ t }) {
      const [status, setStatus] = useState(null)
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [login, setLogin] = useState(null)
      const [keyInput, setKeyInput] = useState('')
      const [keyLabel, setKeyLabel] = useState('')
      const [environment, setEnvironment] = useState('internal')
      const [endpoint, setEndpoint] = useState('')
      const timer = useRef(null)
      const mounted = useRef(true)

      useEffect(() => {
        mounted.current = true
        void load()
        return () => {
          mounted.current = false
          if (timer.current !== null) clearTimeout(timer.current)
        }
      }, [])

      useEffect(() => {
        if (status?.apikey?.environment !== undefined) setEnvironment(status.apikey.environment)
      }, [status?.apikey?.environment])

      async function load() {
        setLoading(true)
        try {
          setStatus(await call('/status'))
          setError('')
        }
        catch (error) {
          setError(error instanceof Error ? error.message : String(error))
        }
        finally {
          setLoading(false)
        }
      }

      async function run(action, successText) {
        setBusy(true)
        setError('')
        setNotice('')
        try {
          await action()
          if (successText !== undefined) setNotice(successText)
        }
        catch (error) {
          setError(error instanceof Error ? error.message : String(error))
        }
        finally {
          setBusy(false)
        }
      }

      async function changeMode(mode) {
        await run(async () => {
          setStatus(await call('/mode', { mode }))
        })
      }

      async function startLogin() {
        setBusy(true)
        setError('')
        setNotice('')
        // 先同步开一个空白窗口再等待握手，避免 await 之后浏览器把弹窗当非用户手势拦截。
        let popup = null
        try {
          popup = window.open('about:blank', '_blank')
        }
        catch {
          popup = null
        }
        try {
          const start = await call('/workbuddy/start', {})
          setLogin({ phase: 'pending', state: start.state, authUrl: start.authUrl })
          if (popup !== null && !popup.closed) {
            try {
              popup.opener = null
              popup.location.replace(start.authUrl)
            }
            catch {
              // 个别浏览器不允许脚本改地址：退回下面的新窗口/链接。
              window.open(start.authUrl, '_blank', 'noopener,noreferrer')
            }
          }
          else {
            try {
              window.open(start.authUrl, '_blank', 'noopener,noreferrer')
            }
            catch {
              // 弹窗被拦截：界面里仍有可点击的授权链接。
            }
          }
          const deadline = Date.now() + 10 * 60 * 1000
          const tick = async () => {
            if (!mounted.current) return
            if (Date.now() > deadline) {
              setLogin({ phase: 'error', message: '登录等待超时，请重新发起' })
              setBusy(false)
              return
            }
            try {
              const result = await call('/workbuddy/poll', { state: start.state })
              if (result.phase === 'pending') {
                timer.current = setTimeout(tick, 1500)
                return
              }
              setStatus(result.state)
              setLogin({ phase: 'done', state: start.state })
              setNotice(t('saved'))
              setBusy(false)
            }
            catch (error) {
              setLogin({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
              setBusy(false)
            }
          }
          timer.current = setTimeout(tick, 1500)
        }
        catch (error) {
          if (popup !== null && !popup.closed) {
            try {
              popup.close()
            }
            catch {
              // 窗口已关闭/不可访问：忽略。
            }
          }
          setError(error instanceof Error ? error.message : String(error))
          setBusy(false)
        }
      }

      function cancelLogin() {
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = null
        setLogin(null)
        setBusy(false)
      }

      async function switchWorkBuddy(accountId) {
        await run(async () => {
          setStatus(await call('/workbuddy/switch', { accountId }))
        })
      }

      async function removeWorkBuddy(accountId) {
        await run(async () => {
          setStatus(await call('/workbuddy/remove', { accountId }))
        })
      }

      async function addApiKey() {
        if (keyInput.trim().length === 0) return
        await run(async () => {
          setStatus(await call('/apikey/add', {
            key: keyInput.trim(),
            ...(keyLabel.trim().length > 0 ? { label: keyLabel.trim() } : {}),
            environment,
            ...(environment === 'custom' ? { endpoint: endpoint.trim() } : {}),
          }))
          setKeyInput('')
          setKeyLabel('')
        }, t('saved'))
      }

      async function switchApiKey(id) {
        await run(async () => {
          setStatus(await call('/apikey/switch', { id }))
        })
      }

      async function removeApiKey(id) {
        await run(async () => {
          setStatus(await call('/apikey/remove', { id }))
        })
      }

      async function refreshModels() {
        await run(async () => {
          setStatus(await call('/models/refresh', {}))
        }, t('saved'))
      }

      const mode = status?.mode ?? 'workbuddy'
      const accounts = status?.workbuddy?.accounts ?? []
      const keys = status?.apikey?.entries ?? []
      const modelCount = status?.provider?.modelCount ?? 0
      const source = status?.provider?.modelSource === 'workbuddy'
        ? t('sourceWorkbuddy')
        : status?.provider?.modelSource === 'api-key'
          ? t('sourceApiKey')
          : t('noSource')
      const activeKeyId = status?.apikey?.activeId

      return jsxs('div', { style: { maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 16 }, children: [
        jsxs('div', { children: [
          jsx('h2', { style: { margin: 0, fontSize: 16, fontWeight: 600 }, children: t('title') }),
          jsx('p', { style: { ...hintStyle, margin: '4px 0 0' }, children: t('intro') }),
        ] }),

        jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' }, children: [
          jsx('button', {
            type: 'button',
            style: mode === 'workbuddy' ? modeBtnActive : modeBtnStyle,
            disabled: busy,
            onClick: () => changeMode('workbuddy'),
            children: t('modeWorkbuddy'),
          }),
          jsx('button', {
            type: 'button',
            style: mode === 'apikey' ? modeBtnActive : modeBtnStyle,
            disabled: busy,
            onClick: () => changeMode('apikey'),
            children: t('modeApiKey'),
          }),
        ] }),

        mode === 'workbuddy'
          ? jsxs('div', { style: cardStyle, children: [
              jsx('p', { style: hintStyle, children: t('workbuddyHint') }),
              jsxs('div', { style: rowStyle, children: [
                jsx('button', {
                  type: 'button',
                  style: primaryStyle,
                  disabled: busy || login?.phase === 'pending',
                  onClick: startLogin,
                  children: login?.phase === 'pending' ? t('loggingIn') : accounts.length > 0 ? t('relogin') : t('login'),
                }),
                login?.phase === 'pending' && login?.authUrl
                  ? jsx('a', {
                      href: login.authUrl,
                      target: '_blank',
                      rel: 'noopener noreferrer',
                      style: { fontSize: 12, color: 'var(--dsw-alias-link-primary, #2f6bff)' },
                      children: t('openLogin'),
                    })
                  : null,
                login?.phase === 'pending'
                  ? jsx('button', { type: 'button', style: btnStyle, onClick: cancelLogin, children: t('cancelLogin') })
                  : null,
              ] }),
              login?.phase === 'error'
                ? jsx('p', { style: { ...hintStyle, color: 'var(--dsw-alias-state-error-primary, #d92d20)' }, children: login.message })
                : null,
              accounts.length === 0
                ? jsx('p', { style: hintStyle, children: t('noAccounts') })
                : jsxs('div', { style: rowStyle, children: [
                    jsx('span', { style: labelStyle, children: t('account') }),
                    jsx('select', {
                      style: { ...inputStyle, flex: '1 1 220px', maxWidth: 360 },
                      value: status?.workbuddy?.activeId ?? '',
                      disabled: busy,
                      onChange: (event) => switchWorkBuddy(event.target.value),
                      children: accounts.map((account) => jsx('option', {
                        value: account.id,
                        children: `${accountText(account)}${account.enterpriseName ? ` · ${account.enterpriseName}` : ''}`,
                      }, account.id)),
                    }),
                    status?.workbuddy?.activeId
                      ? jsx('button', {
                          type: 'button',
                          style: { ...btnStyle, color: 'var(--dsw-alias-state-error-primary, #d92d20)' },
                          disabled: busy,
                          onClick: () => removeWorkBuddy(status.workbuddy.activeId),
                          children: t('remove'),
                        })
                      : null,
                  ] }),
            ] })
          : jsxs('div', { style: cardStyle, children: [
              jsx('p', { style: hintStyle, children: t('apiKeyHint') }),
              jsxs('div', { style: rowStyle, children: [
                jsx('input', {
                  type: 'password',
                  style: { ...inputStyle, flex: '1 1 240px' },
                  placeholder: t('apiKeyInput'),
                  value: keyInput,
                  disabled: busy,
                  onChange: (event) => setKeyInput(event.target.value),
                }),
                jsx('input', {
                  type: 'text',
                  style: { ...inputStyle, flex: '1 1 150px' },
                  placeholder: t('apiKeyLabel'),
                  value: keyLabel,
                  disabled: busy,
                  onChange: (event) => setKeyLabel(event.target.value),
                }),
              ] }),
              jsxs('div', { style: rowStyle, children: [
                jsx('select', {
                  style: { ...inputStyle, flex: '1 1 240px', maxWidth: 360 },
                  value: environment,
                  disabled: busy,
                  onChange: (event) => setEnvironment(event.target.value),
                  children: [
                    jsx('option', { value: 'internal', children: t('envInternal') }),
                    jsx('option', { value: 'external', children: t('envExternal') }),
                    jsx('option', { value: 'ioa', children: t('envIoa') }),
                    jsx('option', { value: 'custom', children: t('envCustom') }),
                  ],
                }),
                environment === 'custom'
                  ? jsx('input', {
                      type: 'text',
                      style: { ...inputStyle, flex: '1 1 240px' },
                      placeholder: t('endpointPlaceholder'),
                      value: endpoint,
                      disabled: busy,
                      onChange: (event) => setEndpoint(event.target.value),
                    })
                  : null,
                jsx('button', {
                  type: 'button',
                  style: primaryStyle,
                  disabled: busy || keyInput.trim().length === 0 || (environment === 'custom' && endpoint.trim().length === 0),
                  onClick: addApiKey,
                  children: t('apiKeyAdd'),
                }),
              ] }),
              keys.length === 0
                ? jsx('p', { style: hintStyle, children: t('noKeys') })
                : jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 }, children: keys.map((entry) => jsxs('div', {
                    style: {
                      ...rowStyle,
                      justifyContent: 'space-between',
                      border: '1px solid var(--dsw-alias-border-l1, #eaecf0)',
                      borderRadius: 8,
                      padding: '6px 8px',
                    },
                    children: [
                      jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }, children: [
                        jsxs('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary, #111)' }, children: [
                          entry.label,
                          entry.id === activeKeyId ? ` · ${t('active')}` : '',
                        ] }),
                        jsx('span', { style: hintStyle, children: `${entry.kind === 'environment' ? t('envSource') : entry.environmentLabel}${entry.masked ? ` · ${entry.masked}` : ''}${entry.configured ? '' : ' · 未配置'}` }),
                      ] }),
                      jsxs('div', { style: { display: 'flex', gap: 6 }, children: [
                        entry.id === activeKeyId
                          ? null
                          : jsx('button', {
                              type: 'button',
                              style: btnStyle,
                              disabled: busy,
                              onClick: () => switchApiKey(entry.id),
                              children: t('use'),
                            }),
                        entry.kind === 'environment'
                          ? null
                          : jsx('button', {
                              type: 'button',
                              style: { ...btnStyle, color: 'var(--dsw-alias-state-error-primary, #d92d20)' },
                              disabled: busy,
                              onClick: () => removeApiKey(entry.id),
                              children: t('apiKeyRemove'),
                            }),
                      ] }),
                    ],
                  }, entry.id)) }),
            ] }),

        jsxs('div', { style: { ...rowStyle, justifyContent: 'space-between' }, children: [
          jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 }, children: [
            jsx('span', { style: labelStyle, children: t('models') }),
            jsx('span', { style: hintStyle, children: modelCount > 0 ? t('modelsReady').replace('{count}', String(modelCount)) : t('modelsMissing') }),
            jsx('span', { style: hintStyle, children: `${t('source')}: ${source}` }),
          ] }),
          jsx('button', {
            type: 'button',
            style: btnStyle,
            disabled: busy,
            onClick: refreshModels,
            children: t('refreshModels'),
          }),
        ] }),

        error
          ? jsx('p', { style: { ...hintStyle, color: 'var(--dsw-alias-state-error-primary, #d92d20)' }, children: `${t('error')}：${error}` })
          : null,
        notice
          ? jsx('p', { style: { ...hintStyle, color: 'var(--dsw-alias-state-success-primary, #039855)' }, children: notice })
          : null,
        loading
          ? jsx('p', { style: hintStyle, children: t('loading') })
          : null,
        busy
          ? jsx('p', { style: hintStyle, children: t('working') })
          : null,
      ] })
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => {
        const dispose = ctx.locale.register(NS, { zh, en })
        return () => dispose()
      }, 'workbuddy-lite: locale dictionaries')
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'workbuddy-lite',
        order: 50,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ t }),
      }, SettingsSection))
    }

    return { apply, inject }
  },
})
