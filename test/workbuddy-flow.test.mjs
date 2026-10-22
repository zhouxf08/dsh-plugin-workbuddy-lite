import assert from 'node:assert/strict'
import test from 'node:test'
import {
  startWorkBuddyLogin,
  pollWorkBuddyToken,
  fetchWorkBuddyAccount,
  refreshWorkBuddySession,
} from '../lib/workbuddy-auth.js'

const realFetch = globalThis.fetch

function stubFetch(handler) {
  globalThis.fetch = async (url, init) => handler(String(url), init)
}

test.afterEach(() => {
  globalThis.fetch = realFetch
})

test('startWorkBuddyLogin performs the platform handshake and adds version', async () => {
  let seen
  stubFetch((url, init) => {
    seen = { url, init }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          code: 0,
          data: {
            state: 'state-1',
            authUrl: 'https://www.workbuddy.cn/login?platform=WorkBuddy&state=state-1',
          },
        }
      },
    }
  })
  const result = await startWorkBuddyLogin()
  assert.equal(result.state, 'state-1')
  assert.match(result.authUrl, /version=5\.8\.3/)
  assert.match(seen.url, /\/v2\/plugin\/auth\/state/)
  assert.match(seen.url, /platform=WorkBuddy/)
  assert.equal(seen.init.method, 'POST')
  assert.equal(seen.init.headers['X-No-Authorization'], 'true')
})

test('pollWorkBuddyToken reports pending and final token', async () => {
  stubFetch(() => ({
    ok: true,
    status: 200,
    async json() {
      return { code: 11217, msg: 'pending' }
    },
  }))
  assert.deepEqual(await pollWorkBuddyToken('s1'), { status: 'pending' })

  stubFetch(() => ({
    ok: true,
    status: 200,
    async json() {
      return {
        code: 0,
        data: { access_token: 'a', refresh_token: 'r', expires_in: 30, domain: 'd' },
      }
    },
  }))
  const done = await pollWorkBuddyToken('s1')
  assert.equal(done.status, 'done')
  assert.equal(done.auth.accessToken, 'a')
  assert.equal(done.auth.refreshToken, 'r')
  assert.equal(done.auth.domain, 'd')
  assert.ok(done.auth.expiresAt > Date.now())
})

test('fetchWorkBuddyAccount sends bearer and domain and normalizes the account', async () => {
  let seen
  stubFetch((url, init) => {
    seen = { url, init }
    return {
      ok: true,
      status: 200,
      async json() {
        return { code: 0, data: { uid: 'u1', nickname: 'N', enterpriseId: '' } }
      },
    }
  })
  const account = await fetchWorkBuddyAccount('s1', { accessToken: 'a', domain: 'd' })
  assert.equal(account.uid, 'u1')
  assert.equal(account.nickname, 'N')
  assert.equal('enterpriseId' in account, false)
  assert.equal(seen.init.headers.authorization, 'Bearer a')
  assert.equal(seen.init.headers['X-Domain'], 'd')
  assert.match(seen.url, /\/v2\/plugin\/login\/account\?state=s1/)
})

test('refreshWorkBuddySession keeps the old refresh token when not rotated', async () => {
  let seen
  stubFetch((url, init) => {
    seen = { url, init }
    return {
      ok: true,
      status: 200,
      async json() {
        return { code: 0, data: { accessToken: 'new-a', expiresIn: 60 } }
      },
    }
  })
  const session = {
    auth: {
      accessToken: 'old-a',
      refreshToken: 'old-r',
      domain: 'd',
      expiresAt: Date.now() - 1000,
    },
    account: { uid: 'u1' },
  }
  const next = await refreshWorkBuddySession(session)
  assert.equal(next.auth.accessToken, 'new-a')
  assert.equal(next.auth.refreshToken, 'old-r')
  assert.equal(seen.init.headers['X-Refresh-Token'], 'old-r')
  assert.equal(seen.init.headers['X-Auth-Refresh-Source'], 'plugin')
  assert.equal(seen.init.headers.authorization, 'Bearer old-a')
})
