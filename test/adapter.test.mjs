import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { fetchModels } from '../lib/catalog.js'
import { CodeBuddyAdapter } from '../lib/adapter.js'

const CONFIG = {
  code: 0,
  msg: 'OK',
  data: {
    agents: [{ name: 'cli', models: ['glm-4.7'] }],
    models: [{
      id: 'glm-4.7',
      name: 'GLM-4.7',
      maxInputTokens: 200000,
      maxOutputTokens: 48000,
      supportsImages: true,
      supportsReasoning: true,
      reasoning: { supportedEfforts: ['low', 'high'], defaultEffort: 'high' },
      credits: 'x0.23 credits',
    }],
  },
}

const SSE = [
  'data: {"choices":[{"delta":{"reasoning_content":"think "}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"hello "}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n',
  'data: [DONE]\n\n',
]

async function startServer() {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body })
      if (req.url === '/v3/config') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(CONFIG))
        return
      }
      if (req.url === '/v2/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const chunk of SSE) res.write(chunk)
        res.end()
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { server, requests, origin: `http://127.0.0.1:${port}` }
}

test('fetchModels and adapter stream against a local mock', async (t) => {
  const { server, requests, origin } = await startServer()
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const credential = {
    kind: 'api-key',
    value: 'test-key',
    entry: { environment: 'custom', endpoint: origin, account: {} },
    origin,
    baseURL: `${origin}/v2`,
    account: {},
  }

  const models = await fetchModels(credential)
  assert.deepEqual(models.map((model) => model.id), ['glm-4.7'])
  assert.equal(models[0].contextWindow, 200000)
  assert.deepEqual(models[0].thinkingLevels, ['low', 'high'])

  const adapter = new CodeBuddyAdapter({
    options: () => ({ profile: { displayName: 'CodeBuddy' }, retryPolicy: undefined }),
    models: () => models,
    resolveCredential: async () => credential,
    resolveAttachments: () => undefined,
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'codebuddy',
    model: 'glm-4.7',
    system: 'be helpful',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 100,
  })) {
    chunks.push(chunk)
  }

  const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
  const reasoning = chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join('')
  const finish = chunks.find((chunk) => chunk.type === 'finish')
  assert.equal(text, 'hello world')
  assert.equal(reasoning, 'think ')
  assert.deepEqual(finish.reason, { kind: 'stop' })
  assert.equal(chunks.find((chunk) => chunk.type === 'usage').usage.totalTokens, 12)

  const chat = requests.find((request) => request.url === '/v2/chat/completions')
  assert.ok(chat)
  assert.equal(chat.headers['x-api-key'], 'test-key')
  assert.equal(chat.headers['x-ide-type'], 'CLI')
  assert.equal(chat.headers['user-agent'], 'CLI/2.169.0 CodeBuddy/2.169.0')
  assert.equal(chat.headers.accept, 'text/event-stream')
  const body = JSON.parse(chat.body)
  assert.equal(body.model, 'glm-4.7')
  assert.equal(body.stream, true)
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[1].content, 'hi')
})

test('adapter sends tool calls and tool results in OpenAI format', async (t) => {
  const { server, requests, origin } = await startServer()
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const credential = {
    kind: 'workbuddy',
    value: 'token',
    session: { auth: { domain: 'd' }, account: { uid: 'u' } },
    origin,
    baseURL: `${origin}/v2`,
    account: { uid: 'u' },
  }
  const adapter = new CodeBuddyAdapter({
    options: () => ({ profile: { displayName: 'CodeBuddy' }, retryPolicy: undefined }),
    models: () => [{ id: 'glm-4.7', name: 'GLM-4.7', contextWindow: 1000, maxTokens: 100, images: false, reasoning: false }],
    resolveCredential: async () => credential,
    resolveAttachments: () => undefined,
  })
  for await (const _chunk of adapter.stream({
    provider: 'codebuddy',
    model: 'glm-4.7',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [{
          type: 'tool-call',
          id: 'call-1',
          name: 'lookup',
          arguments: '{"q":"x"}',
        }],
      },
      {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'result' }] }],
      },
    ],
  })) {
    // consume
  }
  const chat = requests.find((request) => request.url === '/v2/chat/completions')
  const body = JSON.parse(chat.body)
  assert.equal(body.messages[1].tool_calls[0].function.name, 'lookup')
  assert.equal(body.messages[2].role, 'tool')
  assert.equal(body.messages[2].tool_call_id, 'call-1')
  assert.equal(body.messages[2].content, 'result')
  assert.equal(chat.headers.authorization, 'Bearer token')
  assert.equal(chat.headers['x-ide-type'], 'WorkBuddy')
  assert.equal(chat.headers['user-agent'], 'WorkBuddy/5.77 CodeBuddy/5.77')
})

test('tool results immediately follow their assistant tool calls', async (t) => {
  const { server, requests, origin } = await startServer()
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const credential = {
    kind: 'api-key',
    value: 'test-key',
    entry: { environment: 'custom', endpoint: origin, account: {} },
    origin,
    baseURL: `${origin}/v2`,
    account: {},
  }
  const adapter = new CodeBuddyAdapter({
    options: () => ({ profile: { displayName: 'CodeBuddy' }, retryPolicy: undefined }),
    models: () => [],
    resolveCredential: async () => credential,
    resolveAttachments: () => undefined,
  })
  for await (const _chunk of adapter.stream({
    provider: 'codebuddy',
    model: 'glm-4.7',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'start' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling' },
          { type: 'tool-call', id: 'c1', name: 'lookup', arguments: '{}' },
          { type: 'tool-call', id: 'c2', name: 'lookup2', arguments: '{}' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'after' },
          { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'r1' }] },
          { type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'r2' }] },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ],
  })) {
    // consume
  }
  const chat = requests.find((request) => request.url === '/v2/chat/completions')
  const body = JSON.parse(chat.body)
  assert.deepEqual(body.messages.map((message) => message.role), ['user', 'assistant', 'tool', 'tool', 'user', 'assistant'])
  assert.deepEqual(body.messages[1].tool_calls.map((call) => call.id), ['c1', 'c2'])
  assert.equal(body.messages[2].tool_call_id, 'c1')
  assert.equal(body.messages[2].content, 'r1')
  assert.equal(body.messages[3].tool_call_id, 'c2')
  assert.equal(body.messages[4].content, 'after')
})

test('unmatched tool calls and orphan tool results are dropped', async (t) => {
  const { server, requests, origin } = await startServer()
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const credential = {
    kind: 'api-key',
    value: 'test-key',
    entry: { environment: 'custom', endpoint: origin, account: {} },
    origin,
    baseURL: `${origin}/v2`,
    account: {},
  }
  const adapter = new CodeBuddyAdapter({
    options: () => ({ profile: { displayName: 'CodeBuddy' }, retryPolicy: undefined }),
    models: () => [],
    resolveCredential: async () => credential,
    resolveAttachments: () => undefined,
  })
  for await (const _chunk of adapter.stream({
    provider: 'codebuddy',
    model: 'glm-4.7',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling' },
          { type: 'tool-call', id: 'c1', name: 'lookup', arguments: '{}' },
          { type: 'tool-call', id: 'missing', name: 'lookup2', arguments: '{}' },
          { type: 'text', text: 'tail' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'r1' }] },
          { type: 'tool-result', toolCallId: 'orphan', content: [{ type: 'text', text: 'nope' }] },
        ],
      },
    ],
  })) {
    // consume
  }
  const chat = requests.find((request) => request.url === '/v2/chat/completions')
  const body = JSON.parse(chat.body)
  assert.deepEqual(body.messages.map((message) => message.role), ['assistant', 'tool'])
  assert.deepEqual(body.messages[0].tool_calls.map((call) => call.id), ['c1'])
  assert.equal(body.messages[1].tool_call_id, 'c1')
})

test('DSH 0.2.1 role:tool messages are serialized as tool messages', async (t) => {
  const { server, requests, origin } = await startServer()
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const credential = {
    kind: 'api-key',
    value: 'test-key',
    entry: { environment: 'custom', endpoint: origin, account: {} },
    origin,
    baseURL: `${origin}/v2`,
    account: {},
  }
  const adapter = new CodeBuddyAdapter({
    options: () => ({ profile: { displayName: 'CodeBuddy' }, retryPolicy: undefined }),
    models: () => [],
    resolveCredential: async () => credential,
    resolveAttachments: () => undefined,
  })
  for await (const _chunk of adapter.stream({
    provider: 'codebuddy',
    model: 'glm-4.7',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'start' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', id: 'c1', name: 'lookup', arguments: '{}' },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'c1',
        content: [{ type: 'text', text: 'tool result' }],
      },
    ],
  })) {
    // consume
  }
  const chat = requests.find((request) => request.url === '/v2/chat/completions')
  const body = JSON.parse(chat.body)
  assert.deepEqual(body.messages.map((message) => message.role), ['user', 'assistant', 'tool'])
  assert.equal(body.messages[1].content, '')
  assert.equal(body.messages[1].tool_calls[0].id, 'c1')
  assert.equal(body.messages[2].tool_call_id, 'c1')
  assert.equal(body.messages[2].content, 'tool result')
})

test('long tool call ids are bounded consistently', async (t) => {
  const { server, requests, origin } = await startServer()
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const credential = {
    kind: 'api-key',
    value: 'test-key',
    entry: { environment: 'custom', endpoint: origin, account: {} },
    origin,
    baseURL: `${origin}/v2`,
    account: {},
  }
  const adapter = new CodeBuddyAdapter({
    options: () => ({ profile: { displayName: 'CodeBuddy' }, retryPolicy: undefined }),
    models: () => [],
    resolveCredential: async () => credential,
    resolveAttachments: () => undefined,
  })
  const longId = `call_${'x'.repeat(100)}`
  for await (const _chunk of adapter.stream({
    provider: 'codebuddy',
    model: 'glm-4.7',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: longId, name: 'lookup', arguments: '{}' }],
      },
      { role: 'tool', toolCallId: longId, content: [{ type: 'text', text: 'r' }] },
    ],
  })) {
    // consume
  }
  const chat = requests.find((request) => request.url === '/v2/chat/completions')
  const body = JSON.parse(chat.body)
  const callId = body.messages[0].tool_calls[0].id
  assert.equal(callId, body.messages[1].tool_call_id)
  assert.ok(callId.length <= 64)
})
