import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeEnvironment,
  normalizeOrigin,
  resolveApiOrigin,
  apiKeyIdentityHeaders,
  workbuddyIdentityHeaders,
} from '../lib/clients.js'

test('normalizeEnvironment falls back to internal', () => {
  assert.equal(normalizeEnvironment(undefined), 'internal')
  assert.equal(normalizeEnvironment(' EXTERNAL '), 'external')
  assert.equal(normalizeEnvironment('ioa'), 'ioa')
  assert.equal(normalizeEnvironment('nope'), 'internal')
})

test('resolveApiOrigin maps each environment', () => {
  assert.equal(resolveApiOrigin({ environment: 'internal' }), 'https://copilot.tencent.com')
  assert.equal(resolveApiOrigin({ environment: 'external' }), 'https://www.codebuddy.ai')
  assert.equal(resolveApiOrigin({ environment: 'custom', endpoint: 'https://corp.example.com/' }), 'https://corp.example.com')
  assert.throws(() => resolveApiOrigin({ environment: 'custom' }), /缺少服务地址/)
})

test('normalizeOrigin rejects non-http(s)', () => {
  assert.equal(normalizeOrigin('https://a.example.com/path/'), 'https://a.example.com/path')
  assert.throws(() => normalizeOrigin('ftp://a.example.com'), /http/)
  assert.throws(() => normalizeOrigin('not a url'), /合法/)
})

test('api key identity uses CLI product headers', () => {
  const headers = apiKeyIdentityHeaders({ environment: 'internal', account: { uid: 'u1', enterpriseId: 'e1' } })
  assert.equal(headers['X-IDE-Type'], 'CLI')
  assert.equal(headers['X-IDE-Name'], 'CLI')
  assert.match(headers['user-agent'], /^CLI\/.+/)
  assert.equal(headers['X-User-Id'], 'u1')
  assert.equal(headers['X-Enterprise-Id'], 'e1')
})

test('workbuddy identity uses WorkBuddy product headers and domain', () => {
  const headers = workbuddyIdentityHeaders({
    auth: { domain: 'd1' },
    account: { uid: 'u1', enterpriseId: 'e1', departmentFullName: 'dept' },
  })
  assert.equal(headers['X-IDE-Type'], 'WorkBuddy')
  assert.equal(headers['X-IDE-Name'], 'WorkBuddy')
  assert.match(headers['user-agent'], /^WorkBuddy\//)
  assert.equal(headers['X-Domain'], 'd1')
  assert.equal(headers['X-Department-Info'], 'dept')
})
