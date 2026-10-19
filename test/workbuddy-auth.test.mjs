import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeToken,
  normalizeAccount,
  normalizeSessionStore,
  upsertSession,
  createSessionEntry,
  sessionNeedsRefresh,
  workbuddySessionId,
} from '../lib/workbuddy-auth.js'

test('normalizeToken accepts camelCase and computes expiry', () => {
  const now = 1_000_000
  const token = normalizeToken({ accessToken: 'a', refreshToken: 'r', expiresIn: 10, domain: 'd' }, now)
  assert.equal(token.accessToken, 'a')
  assert.equal(token.refreshToken, 'r')
  assert.equal(token.expiresAt, now + 10_000)
  assert.equal(token.domain, 'd')
})

test('normalizeToken accepts snake_case', () => {
  const token = normalizeToken({ access_token: 'a', refresh_token: 'r', expires_in: 5 })
  assert.equal(token.accessToken, 'a')
  assert.equal(token.refreshToken, 'r')
  assert.ok(token.expiresAt > 0)
})

test('normalizeToken requires an access token', () => {
  assert.throws(() => normalizeToken({}), /access token/)
})

test('normalizeAccount reads uid and omits empty strings', () => {
  const account = normalizeAccount({ uid: 'u1', nickname: '', uin: '123', enterpriseId: 'e1' }, { accessToken: 'x' })
  assert.equal(account.uid, 'u1')
  assert.equal(account.uin, '123')
  assert.equal(account.enterpriseId, 'e1')
  assert.equal('nickname' in account, false)
})

test('normalizeSessionStore ignores malformed entries and selects first active', () => {
  const store = normalizeSessionStore({
    sessions: [
      { auth: { accessToken: 'a' }, account: { uid: 'u1' } },
      { auth: {}, account: { uid: 'u2' } },
      null,
    ],
  })
  assert.equal(store.sessions.length, 1)
  assert.equal(store.activeId, 'workbuddy:u1')
})

test('upsertSession replaces an existing account and keeps createdAt', () => {
  const first = createSessionEntry({
    auth: { accessToken: 'a', domain: '' },
    account: { uid: 'u1', nickname: 'A' },
  }, 100)
  const store = { version: 1, activeId: first.id, sessions: [first] }
  const second = createSessionEntry({
    auth: { accessToken: 'b', domain: '' },
    account: { uid: 'u1', nickname: 'B' },
  }, 200)
  const next = upsertSession(store, second)
  assert.equal(next.sessions.length, 1)
  assert.equal(next.sessions[0].createdAt, 100)
  assert.equal(next.sessions[0].account.nickname, 'B')
  assert.equal(next.activeId, workbuddySessionId(second))
})

test('sessionNeedsRefresh respects expiry skew', () => {
  assert.equal(sessionNeedsRefresh({ auth: { expiresAt: Date.now() + 10 * 60_000 } }), false)
  assert.equal(sessionNeedsRefresh({ auth: { expiresAt: Date.now() + 1_000 } }), true)
  assert.equal(sessionNeedsRefresh({ auth: {} }), true)
})
