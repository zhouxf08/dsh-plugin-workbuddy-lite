import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeApiKeyStore,
  maskApiKey,
  createApiKeyRef,
  resolveActiveApiKey,
} from '../lib/api-keys.js'

test('maskApiKey never returns the full key', () => {
  assert.equal(maskApiKey('sk-1234567890'), '••••7890')
  assert.equal(maskApiKey('short'), '••••')
  assert.equal(maskApiKey(''), '')
})

test('createApiKeyRef is a valid credential reference', () => {
  const ref = createApiKeyRef()
  assert.match(ref, /^[A-Za-z_][A-Za-z0-9_]*$/)
  assert.notEqual(ref, createApiKeyRef())
})

test('normalizeApiKeyStore drops invalid entries and custom without endpoint', () => {
  const store = normalizeApiKeyStore({
    entries: [
      { id: 'a', ref: 'CODEBUDDY_API_KEY_A', environment: 'internal' },
      { id: 'b', ref: 'bad-ref', environment: 'internal' },
      { id: 'c', ref: 'CODEBUDDY_API_KEY_C', environment: 'custom' },
      { id: 'd', ref: 'CODEBUDDY_API_KEY_D', environment: 'custom', endpoint: 'https://corp.example.com' },
    ],
  })
  assert.deepEqual(store.entries.map((entry) => entry.id), ['a', 'd'])
  assert.equal(store.activeId, 'a')
})

test('resolveActiveApiKey prefers stored key over environment', async () => {
  const values = new Map([
    ['CODEBUDDY_API_KEYS', JSON.stringify({
      version: 1,
      activeId: 'key:CODEBUDDY_API_KEY_A',
      entries: [{ id: 'key:CODEBUDDY_API_KEY_A', ref: 'CODEBUDDY_API_KEY_A', environment: 'internal' }],
    })],
    ['CODEBUDDY_API_KEY_A', 'stored-key'],
    ['CODEBUDDY_API_KEY', 'env-key'],
  ])
  const credentials = {
    async resolve(ref) {
      const value = values.get(String(ref))
      return value === undefined ? undefined : { value, source: 'test' }
    },
  }
  const ctx = {
    get(name) {
      return name === 'credentials' ? credentials : undefined
    },
  }
  const resolved = await resolveActiveApiKey(ctx, {})
  assert.equal(resolved.source, 'store')
  assert.equal(resolved.value, 'stored-key')
  assert.equal(resolved.entry.environment, 'internal')
})
