import assert from 'node:assert/strict'
import test from 'node:test'
import {
  businessCode,
  classifyFailure,
  isUnapprovedOpening,
  neutralizeSystemText,
  startsWithNeutralHead,
} from '../lib/errors.js'

test('businessCode reads nested and direct envelopes', () => {
  assert.equal(businessCode('{"code":11128,"msg":"x"}'), 11128)
  assert.equal(businessCode('{"error":{"data":{"code":14018,"msg":"Credits exhausted."}}}'), 14018)
  assert.equal(businessCode('no code here'), undefined)
})

test('classifyFailure recognises the upstream business codes', () => {
  assert.equal(classifyFailure({ status: 400, body: '{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}' }).kind, 'channel')
  assert.equal(classifyFailure({ status: 400, body: '{"code":6020,"msg":"waiting"}' }).kind, 'queue')
  assert.equal(classifyFailure({ status: 429, body: '{"code":14003,"msg":"too many requests"}' }).kind, 'model-busy')
  assert.equal(classifyFailure({ status: 402, body: '{"code":14018,"msg":"Credits exhausted."}' }).kind, 'credits')
  assert.equal(classifyFailure({ status: 200, body: '{"msg":"Offline user session not found"}' }).kind, 'session')
  assert.equal(classifyFailure({ status: 400, body: '{"code":11140,"msg":"request illegal"}' }).kind, 'policy')
  assert.equal(classifyFailure({ status: 401, body: '' }).kind, 'auth')
  assert.equal(classifyFailure({ status: 429, body: '' }).kind, 'rate-limit')
  assert.equal(classifyFailure({ status: 502, body: '' }).kind, 'server')
  assert.equal(classifyFailure({ status: 400, body: '' }).kind, 'client')
})

test('queue and busy failures are not retryable, channel failures are', () => {
  assert.equal(classifyFailure({ status: 400, body: '{"code":6020}' }).retryable, false)
  assert.equal(classifyFailure({ status: 429, body: '{"code":14003}' }).retryable, false)
  assert.equal(classifyFailure({ status: 402, body: '{"code":14018}' }).retryable, false)
  assert.equal(classifyFailure({ status: 400, body: '{"code":11128,"msg":"from an unapproved channel"}' }).retryable, true)
})

test('credit exhaustion matches both singular and plural wording', () => {
  assert.equal(classifyFailure({ status: 402, body: 'Credit exhausted.' }).kind, 'credits')
  assert.equal(classifyFailure({ status: 402, body: 'Credits exhausted.' }).kind, 'credits')
  assert.equal(classifyFailure({ status: 400, body: '积分不足' }).kind, 'credits')
})

test('neutralizeSystemText only rewrites fingerprinted openings', () => {
  assert.equal(
    neutralizeSystemText('You are an AI agent powered by DeepSeek Harness. Do things.'),
    'You are a helpful assistant.\n\nYou are an AI agent powered by DeepSeek Harness. Do things.',
  )
  assert.equal(
    neutralizeSystemText("You are Claude Code, Anthropic's official CLI for Claude."),
    "You are a helpful assistant.\n\nYou are Claude Code, Anthropic's official CLI for Claude.",
  )
  assert.equal(neutralizeSystemText('You are a helpful coding assistant.'), 'You are a helpful coding assistant.')
  assert.equal(neutralizeSystemText(''), 'You are a helpful assistant.')
  assert.equal(neutralizeSystemText('   '), 'You are a helpful assistant.')
})

test('neutralizeSystemText is idempotent', () => {
  const once = neutralizeSystemText('You are an AI agent powered by DeepSeek Harness.')
  assert.equal(neutralizeSystemText(once), once)
})

test('opening helpers trim leading whitespace and ignore case', () => {
  assert.equal(isUnapprovedOpening('  \nYou Are An AI Agent Powered By DeepSeek Harness'), true)
  assert.equal(isUnapprovedOpening('You are a helpful assistant.'), false)
  assert.equal(startsWithNeutralHead('  you are a helpful assistant.'), true)
  assert.equal(startsWithNeutralHead('You are an AI agent'), false)
})
