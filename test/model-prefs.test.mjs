import assert from 'node:assert/strict'
import test from 'node:test'
import { filterEnabledModels, normalizeModelPrefs, publicModelPrefs } from '../lib/model-prefs.js'

test('normalizeModelPrefs dedupes ids and drops invalid entries', () => {
  const prefs = normalizeModelPrefs({ disabled: ['a', 'a', '', 42, null, 'b'] })
  assert.deepEqual(prefs, { version: 1, disabled: ['a', 'b'] })
})

test('normalizeModelPrefs accepts malformed input', () => {
  assert.deepEqual(normalizeModelPrefs(undefined), { version: 1, disabled: [] })
  assert.deepEqual(normalizeModelPrefs('nope'), { version: 1, disabled: [] })
  assert.deepEqual(normalizeModelPrefs({ disabled: 'a' }), { version: 1, disabled: [] })
})

test('filterEnabledModels hides only disabled ids', () => {
  const models = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepEqual(filterEnabledModels(models, { disabled: ['b'] }).map((model) => model.id), ['a', 'c'])
  assert.deepEqual(filterEnabledModels(models, { disabled: [] }).map((model) => model.id), ['a', 'b', 'c'])
  assert.deepEqual(filterEnabledModels(models, { disabled: ['a', 'b', 'c'] }), [])
})

test('publicModelPrefs copies the disabled list', () => {
  const source = { version: 1, disabled: ['a'] }
  const publicValue = publicModelPrefs(source)
  assert.deepEqual(publicValue, { disabled: ['a'] })
  publicValue.disabled.push('b')
  assert.deepEqual(source.disabled, ['a'])
})
