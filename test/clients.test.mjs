import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeEnvironment,
  normalizeOrigin,
  resolveApiOrigin,
  apiKeyIdentityHeaders,
  workbuddyCatalogHeaders,
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

test('normalizeOrigin strips pasted key pages and API paths', () => {
  assert.equal(normalizeOrigin('https://copilot.tencent.com/profile/'), 'https://copilot.tencent.com')
  assert.equal(normalizeOrigin('https://copilot.tencent.com/profile/keys'), 'https://copilot.tencent.com')
  assert.equal(normalizeOrigin('https://copilot.tencent.com/v2/chat/completions'), 'https://copilot.tencent.com')
  assert.equal(normalizeOrigin('https://copilot.tencent.com/v3/config'), 'https://copilot.tencent.com')
  assert.equal(normalizeOrigin('https://gateway.example.com/codebuddy/v2'), 'https://gateway.example.com/codebuddy')
  assert.equal(normalizeOrigin('copilot.tencent.com'), 'https://copilot.tencent.com')
})

test('normalizeOrigin rejects OpenAI /v1 URLs', () => {
  assert.throws(() => normalizeOrigin('https://openrouter.ai/api/v1'), /OpenAI/)
  assert.throws(() => normalizeOrigin('https://openrouter.ai/api/v1/chat/completions'), /OpenAI/)
})

test('api key identity uses CLI product headers', () => {
  const headers = apiKeyIdentityHeaders({ environment: 'internal', account: { uid: 'u1', enterpriseId: 'e1' } })
  assert.equal(headers['X-IDE-Type'], 'CLI')
  assert.equal(headers['X-IDE-Name'], 'CLI')
  assert.match(headers['user-agent'], /^CLI\/.+/)
  assert.equal(headers['X-User-Id'], 'u1')
  assert.equal(headers['X-Enterprise-Id'], 'e1')
})

test('workbuddy chat identity uses CLI product headers and domain', () => {
  const headers = workbuddyIdentityHeaders({
    auth: { domain: 'd1' },
    account: { uid: 'u1', enterpriseId: 'e1', departmentFullName: 'dept' },
  })
  assert.equal(headers['X-IDE-Type'], 'CLI')
  assert.equal(headers['X-IDE-Name'], 'CLI')
  assert.match(headers['user-agent'], /^CLI\/2\.63\.2/)
  assert.equal(headers['X-Domain'], 'd1')
  assert.equal(headers['X-Department-Info'], 'dept')
})

test('workbuddy catalog identity uses the App channel UA', () => {
  const headers = workbuddyCatalogHeaders({
    auth: { domain: 'd1' },
    account: { uid: 'u1', enterpriseId: 'e1', departmentFullName: 'dept' },
  })
  assert.equal(headers['X-IDE-Type'], 'WorkBuddy')
  assert.equal(headers['X-IDE-Name'], 'WorkBuddy')
  assert.equal(headers['user-agent'], 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0')
  assert.equal(headers['X-Domain'], 'd1')
  assert.equal(headers['X-Department-Info'], 'dept')
})

test('iOA api key uses the iOA domain and enterprise header', () => {
  const headers = apiKeyIdentityHeaders({
    environment: 'ioa',
    account: { uid: 'u1', enterpriseId: 'ent-1' },
  })
  assert.equal(headers['X-Domain'], 'tencent.sso.copilot.tencent.com')
  assert.equal(headers['X-Enterprise-Id'], 'ent-1')
  assert.equal(headers['X-User-Id'], 'u1')
})
