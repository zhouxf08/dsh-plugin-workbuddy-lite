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

test('parseModels uses the WorkBuddy craft agent when cli is absent', () => {
  const models = parseModels({
    agents: [
      { name: 'craft', models: ['deepseek-v4-flash', 'glm-5.1'] },
      { name: 'chat', models: ['hunyuan-chat'] },
    ],
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', maxInputTokens: 1000000, maxOutputTokens: 50000, supportsImages: true },
      { id: 'glm-5.1', name: 'GLM-5.1', maxInputTokens: 200000, maxOutputTokens: 48000, supportsImages: true },
      { id: 'hunyuan-chat', name: 'Hunyuan Chat', maxInputTokens: 128000, maxOutputTokens: 16000 },
    ],
  }, 'craft')
  assert.deepEqual(models.map((model) => model.id), ['deepseek-v4-flash', 'glm-5.1'])
  assert.equal(models[0].contextWindow, 1000000)
})

test('parseModels falls back to the first agent with models', () => {
  const models = parseModels({
    agents: [
      { name: 'unknown', models: [] },
      { name: 'craft', models: ['a'] },
    ],
    models: [{ id: 'a', name: 'A', maxInputTokens: 1000, maxOutputTokens: 100 }],
  }, 'cli')
  assert.deepEqual(models.map((model) => model.id), ['a'])
})
