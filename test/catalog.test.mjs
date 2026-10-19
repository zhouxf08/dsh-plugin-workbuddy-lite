import assert from 'node:assert/strict'
import test from 'node:test'
import { parseModels } from '../lib/catalog.js'

const config = {
  agents: [
    { name: 'cli', models: ['glm-4.7', 'hy3', 'missing'] },
    { name: 'other', models: ['other-model'] },
  ],
  models: [
    {
      id: 'glm-4.7',
      name: 'GLM-4.7',
      maxInputTokens: 200000,
      maxOutputTokens: 48000,
      supportsImages: true,
      supportsReasoning: true,
      reasoning: { effort: 'medium' },
      credits: 'x0.23 credits',
    },
    {
      id: 'hy3',
      name: 'Hy3',
      contextWindow: { defaultLength: 192000, supportedLengths: [64000, 192000] },
      maxOutputTokens: 64000,
      supportsImages: false,
      supportsReasoning: true,
      reasoning: { supportedEfforts: ['low', 'high'], defaultEffort: 'high', canDisableThinking: true },
      credits: 'x0.00 credits',
    },
    {
      id: 'no-capacity',
      name: 'No capacity',
      supportsImages: true,
    },
  ],
}

test('parseModels keeps only cli models with disclosed capacity', () => {
  const models = parseModels(config)
  assert.deepEqual(models.map((model) => model.id), ['glm-4.7', 'hy3'])
  assert.equal(models[0].contextWindow, 200000)
  assert.equal(models[0].maxTokens, 48000)
  assert.equal(models[0].images, true)
  assert.match(models[0].name, /x0\.23/)
  assert.deepEqual(models[0].thinkingLevels, ['medium'])
  assert.equal(models[1].contextWindow, 192000)
  assert.deepEqual(models[1].thinkingLevels, ['low', 'high'])
  assert.equal(models[1].defaultReasoningEffort, 'high')
})

test('parseModels falls back to all models when agents are absent', () => {
  const models = parseModels({
    models: [
      { id: 'a', name: 'A', maxInputTokens: 1000, maxOutputTokens: 100 },
      { id: 'b', name: 'B', maxInputTokens: 2000, maxOutputTokens: 200 },
    ],
  })
  assert.deepEqual(models.map((model) => model.id), ['a', 'b'])
})

test('parseModels drops entries without output capacity', () => {
  const models = parseModels({
    agents: [{ name: 'cli', models: ['a'] }],
    models: [{ id: 'a', name: 'A', maxInputTokens: 1000 }],
  })
  assert.deepEqual(models, [])
})
