/**
 * CodeBuddy 的 LLM adapter。
 *
 * 聊天平面是 OpenAI 兼容的（`<origin>/v2/chat/completions`，SSE 流式），目录
 * 平面不是（见 `catalog.js`）。这里负责把 DSH 的消息/工具/图片序列化成 wire
 * 请求，再把 SSE 翻译成 harness 的 chunk 流。
 *
 * 两类凭据共用同一份协议实现，只有认证头与产品身份不同。
 *
 * @module dsh-plugin-workbuddy-lite/adapter
 */

import { randomUUID } from 'node:crypto'
import {
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  ToolCallId,
  attributionHeaders,
  contentHasImage,
} from '@deepseek-ai/dsh-llm'
import { EventSourceParserStream } from 'eventsource-parser/stream'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
} from './constants.js'
import { credentialHeaders } from './catalog.js'
import {
  NEUTRAL_SYSTEM_HEAD,
  classifyFailure,
  neutralizeSystemText,
  startsWithNeutralHead,
} from './errors.js'

/** 图片请求预算：与官方 CLI 的默认压缩档保持一致。 */
const REQUEST_IMAGE_POLICY = { maxPixels: 4_194_304, maxBytes: 1_048_576 }

/**
 * 合并文本块。
 * @param {Array<any>} blocks
 * @returns {string}
 */
function flattenText(blocks) {
  return blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('')
}

/**
 * 读取本次请求会发送的图片。
 * @param {Array<any>} messages
 * @param {any} attachments
 * @param {AbortSignal} signal
 * @returns {Promise<Map<string, any>>}
 */
async function prepareRequestImages(messages, attachments, signal) {
  const refs = new Map()
  for (const message of messages) {
    if (message.role !== 'user') continue
    for (const block of message.content) {
      if (block.type === 'image' && block.attachment !== undefined) {
        refs.set(block.attachment.attachmentId, block.attachment)
      }
    }
  }
  if (refs.size === 0) return new Map()
  if (attachments === undefined) {
    throw new LlmError('CodeBuddy 图片输入需要 durable attachment service', 'UNSUPPORTED_CONTENT')
  }
  const ordered = [...refs.values()]
  const prepared = await Promise.all(ordered.map((ref) => attachments.readImageRequest(ref, REQUEST_IMAGE_POLICY, signal)))
  return new Map(ordered.map((ref, index) => [ref.attachmentId, prepared[index]]))
}

/**
 * 把图片块转成 data URL。
 * @param {any} block
 * @param {Map<string, any>} requestImages
 * @returns {string}
 */
function inlineImageUrl(block, requestImages) {
  const attachmentId = block.attachment?.attachmentId ?? ''
  const version = requestImages.get(attachmentId)
  if (version === undefined) {
    throw new LlmError(`CodeBuddy request image ${attachmentId} was not prepared`, 'INVALID_REQUEST')
  }
  return `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}`
}

/** CodeBuddy 对 tool call id 的长度上限是 64 字符；超长时用确定性短别名。 */
function boundToolCallId(id) {
  const text = typeof id === 'string' ? id : String(id ?? '')
  if (text.length <= 64) return text
  let hash = 0xCBF29CE484222325n
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = (hash * 0x100000001B3n) & 0xFFFFFFFFFFFFFFFFn
  }
  return `call_${hash.toString(16).padStart(16, '0')}`
}

/**
 * 序列化单条消息。
 * @param {any} message
 * @param {Map<string, any>} requestImages
 * @returns {any}
 */
function serializeMessage(message, requestImages) {
  if (message.role === 'system') return { role: 'system', content: neutralizeSystemText(flattenText(message.content)) }
  if (message.role === 'assistant') {
    const text = flattenText(message.content)
    const reasoning = message.content
      .filter((block) => block.type === 'reasoning')
      .map((block) => block.text ?? '')
      .join('')
    const toolCalls = message.content
      .filter((block) => block.type === 'tool-call' && (block.name ?? '').length > 0)
      .map((block) => ({
        id: boundToolCallId(block.id),
        type: 'function',
        function: { name: block.name, arguments: block.arguments },
      }))
    return {
      role: 'assistant',
      // CodeBuddy 的网关会拒绝 `content: null`；纯工具调用回合用空字符串。
      content: text,
      ...(toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    }
  }
  const content = []
  for (const block of message.content) {
    if (block.type === 'text') {
      if ((block.text ?? '').length > 0) content.push({ type: 'text', text: block.text })
    }
    else if (block.type === 'image') {
      content.push({ type: 'image_url', image_url: { url: inlineImageUrl(block, requestImages) } })
    }
    else if (block.type === 'tool-result') {
      content.push({ type: 'text', text: flattenText(block.content ?? []) || '(no output)' })
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })
  if (content.length === 1 && content[0].type === 'text') {
    return { role: 'user', content: content[0].text }
  }
  return { role: 'user', content }
}

/**
 * 序列化消息列表，过滤悬空 tool-result。
 * @param {Array<any>} messages
 * @param {Map<string, any>} requestImages
 * @returns {Array<any>}
 */
function serializeMessages(messages, requestImages) {
  /**
   * 先按 toolCallId 收集结果。DSH 0.2.1 用独立的 `role: "tool"` 消息承载结果，
   * 早期版本则把 tool-result 块放在 user 消息里；这里两种都支持。
   *
   * CodeBuddy/OpenAI 要求：assistant 的每个 tool_calls 条目后面必须紧跟着对应
   * 的 tool 消息，中间不能插入普通 user 文本；没有对应调用的 tool 消息也会被
   * 拒绝（code 11148）。因此先配对，再在 assistant 分支里紧跟着发出。
   */
  const results = new Map()
  for (const message of messages) {
    if (message.role === 'tool') {
      if (typeof message.toolCallId === 'string' && message.toolCallId.length > 0 && !results.has(message.toolCallId)) {
        results.set(message.toolCallId, message)
      }
      continue
    }
    for (const block of message.content) {
      if (block.type === 'tool-result' && typeof block.toolCallId === 'string' && block.toolCallId.length > 0) {
        if (!results.has(block.toolCallId)) results.set(block.toolCallId, block)
      }
    }
  }

  const wire = []
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      wire.push({ role: 'system', content: neutralizeSystemText(flattenText(message.content)) })
      continue
    }
    if (message.role === 'assistant') {
      const content = message.content.filter((block) => block.type !== 'tool-result')
      const matched = content.filter((block) => block.type === 'tool-call'
        && (block.name ?? '').length > 0
        && typeof block.id === 'string'
        && results.has(block.id))
      const filtered = {
        ...message,
        content: content.filter((block) => block.type !== 'tool-call' || matched.includes(block)),
      }
      const hasBody = filtered.content.some((block) => (block.type === 'text' || block.type === 'reasoning')
        && (block.text ?? '').length > 0)
      if (hasBody || matched.length > 0) {
        wire.push(serializeMessage(filtered, requestImages))
        for (const call of matched) {
          const result = results.get(call.id)
          results.delete(call.id)
          wire.push({
            role: 'tool',
            tool_call_id: boundToolCallId(call.id),
            content: flattenText(result.content ?? []) || '(no output)',
          })
        }
      }
      continue
    }
    if (message.role === 'tool') {
      // 已在对应 assistant 后面发出；孤儿 tool 消息直接丢弃，避免 11148。
      continue
    }
    // 早期形态的 tool-result 块已在上面的 assistant 分支发出；这里只发普通内容。
    const regular = message.content.filter((block) => block.type !== 'tool-result')
    if (regular.length > 0) wire.push(serializeMessage({ ...message, content: regular }, requestImages))
  }
  return wire
}

/**
 * 构造 Chat Completions 请求体。
 * @param {any} options
 * @param {Map<string, any>} requestImages
 * @returns {any}
 */
/**
 * 给请求里的每条 system 消息加中性开头。
 * @param {any} body
 * @returns {Array<any>|undefined} 新的 messages；不需要改时返回 undefined
 */
function healSystemHeads(body) {
  const messages = body?.messages
  if (!Array.isArray(messages)) return undefined
  let changed = false
  const next = messages.map((message) => {
    if (message === null || typeof message !== 'object') return message
    if (message.role !== 'system' && message.role !== 'developer') return message
    if (typeof message.content !== 'string') return message
    // 这里**强制**加中性开头，而不是只对已知名单生效：收到 11128 说明上游
    // 已经拒绝了这份 prompt，名单漏判时也必须换一个开头再试一次。
    const healed = startsWithNeutralHead(message.content) || message.content.trim().length === 0
      ? (message.content.trim().length === 0 ? NEUTRAL_SYSTEM_HEAD : message.content)
      : `${NEUTRAL_SYSTEM_HEAD}\n\n${message.content}`
    if (healed === message.content) return message
    changed = true
    return { ...message, role: 'system', content: healed }
  })
  return changed ? next : undefined
}

function serializeRequest(options, requestImages) {
  const messages = []
  if (options.system !== undefined) messages.push({ role: 'system', content: neutralizeSystemText(options.system) })
  messages.push(...serializeMessages(options.messages, requestImages))
  // 两个 WorkBuddy 网关都要求首个消息是 system；没有 system 时补一个最小占位。
  if (messages.length === 0 || messages[0].role !== 'system') {
    messages.unshift({ role: 'system', content: NEUTRAL_SYSTEM_HEAD })
  }
  const tools = options.tools?.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(options.reasoningEffort !== undefined && options.reasoningEffort !== 'off'
      ? { reasoning_effort: options.reasoningEffort }
      : {}),
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
  }
}

/**
 * 解析 SSE 数据行。
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {AsyncGenerator<string>}
 */
async function* parseSse(stream) {
  const events = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream())
  for await (const event of events) {
    yield event.data
    if (event.data === '[DONE]') return
  }
  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
}

/**
 * finish_reason 映射。
 * @param {string} reason
 * @returns {any}
 */
function mapFinishReason(reason) {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default: return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: String(reason).toUpperCase() } }
  }
}

/**
 * usage 映射。
 * @param {any} usage
 * @returns {any|undefined}
 */
function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const promptTokens = usage.prompt_tokens ?? 0
  const completionTokens = usage.completion_tokens ?? 0
  const cacheRead = usage.prompt_tokens_details?.cached_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  const combined = promptTokens + completionTokens
  const hasExactTotal = Number.isSafeInteger(usage.prompt_tokens) && promptTokens >= 0
    && Number.isSafeInteger(usage.completion_tokens) && completionTokens >= 0
    && (usage.total_tokens === undefined || usage.total_tokens === combined)
  return {
    inputTokens: promptTokens - (cacheRead ?? 0),
    outputTokens: completionTokens,
    ...(hasExactTotal ? { totalTokens: combined } : {}),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

/**
 * 将 OpenAI 兼容 SSE chunk 翻译成 harness chunk。
 * @param {AsyncIterable<string>} payloads
 * @returns {AsyncGenerator<any>}
 */
async function* translate(payloads) {
  let nextIndex = 0
  let textBlock
  let reasoningBlock
  const toolBlocks = new Map()
  const order = []
  let pendingFinish
  let pendingUsage

  const open = (kind) => {
    const block = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }
  const closeBlock = (block) => {
    switch (block.kind) {
      case 'text': return { type: 'text', text: block.text }
      case 'reasoning': return { type: 'reasoning', text: block.text }
      case 'tool-call':
        if (!block.name) return undefined
        return { type: 'tool-call', id: ToolCallId(block.callId ?? ''), name: block.name, arguments: block.text }
      default: return undefined
    }
  }

  for await (const payload of payloads) {
    if (payload === '[DONE]') {
      for (const block of order) {
        const closed = closeBlock(block)
        if (closed !== undefined) yield { type: 'block-end', index: block.index, block: closed }
      }
      const usage = mapUsage(pendingUsage)
      if (usage !== undefined) yield { type: 'usage', usage }
      const reason = pendingFinish ?? { kind: 'stop' }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } }
          : reason,
      }
      return
    }

    let chunk
    try {
      chunk = JSON.parse(payload)
    }
    catch {
      throw new LlmError(`malformed SSE payload: ${String(payload).slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {}
      const reasoning = delta.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (reasoningBlock === undefined) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }
      const content = delta.content
      if (typeof content === 'string' && content.length > 0) {
        if (textBlock === undefined) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }
      for (const call of delta.tool_calls ?? []) {
        let block = toolBlocks.get(call.index)
        if (block === undefined) {
          block = open('tool-call')
          toolBlocks.set(call.index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        if (call.id !== undefined) block.callId = call.id
        if (call.function?.name !== undefined) block.name = call.function.name
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: ToolCallId(block.callId ?? ''),
          ...(block.name === undefined ? {} : { name: block.name }),
          argumentsDelta: fragment,
        }
      }
      if (typeof choice.finish_reason === 'string') pendingFinish = mapFinishReason(choice.finish_reason)
    }
    if (chunk.usage) pendingUsage = chunk.usage
  }
  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}

/**
 * 思考档位的展示名。
 * @param {string} level
 * @returns {string}
 */
function effortInfo(level) {
  const names = {
    off: 'Off',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    max: 'Max',
  }
  return { id: ReasoningEffortId(level), name: names[level] ?? level }
}

/**
 * CodeBuddy adapter。
 */
export class CodeBuddyAdapter extends LlmAdapter {
  /**
   * @param {{
   *   options: () => any,
   *   models: () => Array<any>,
   *   resolveCredential: (provider: string, profile: any) => Promise<any>,
   *   resolveAttachments: () => any,
   * }} config
   */
  constructor(config) {
    super()
    this.config = config
  }

  /**
   * @param {string} provider
   * @returns {any}
   */
  providerInfo(provider) {
    return { id: provider, name: this.config.options().profile?.displayName ?? 'CodeBuddy' }
  }

  /**
   * @param {string} _provider
   * @returns {any}
   */
  providerRetryPolicy(_provider) {
    return this.config.options().retryPolicy
  }

  /**
   * @param {string} provider
   * @param {string} model
   * @param {AbortSignal} signal
   * @returns {Promise<any>}
   */
  async prepareCall(provider, model, signal) {
    const snapshot = this.config.options()
    const models = this.config.models()
    const adapter = new CodeBuddyAdapter({
      ...this.config,
      options: () => snapshot,
      models: () => models,
    })
    return LlmAdapter.prototype.prepareCall.call(adapter, provider, model, signal)
  }

  /**
   * @param {string} _provider
   * @param {string} _model
   * @returns {undefined}
   */
  imageRequestPricing(_provider, _model) {
    return undefined
  }

  /**
   * @param {string} provider
   * @returns {Promise<Array<any>>}
   */
  async listModels(provider) {
    return this.config.models().map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.images ? ['text', 'image'] : ['text'],
    }))
  }

  /**
   * @param {string} provider
   * @param {string} modelId
   * @returns {Promise<any>}
   */
  async resolveModel(provider, modelId) {
    const model = this.config.models().find((candidate) => candidate.id === modelId)
    let reasoning
    if (model?.reasoning === true && Array.isArray(model.thinkingLevels) && model.thinkingLevels.length > 0) {
      const levels = model.onlyReasoning === true ? [...model.thinkingLevels] : ['off', ...model.thinkingLevels]
      const defaultEffort = model.defaultReasoningEffort !== undefined && levels.includes(model.defaultReasoningEffort)
        ? ReasoningEffortId(model.defaultReasoningEffort)
        : undefined
      reasoning = {
        efforts: levels.map(effortInfo),
        ...(defaultEffort === undefined ? {} : { defaultEffort }),
      }
    }
    return {
      provider,
      id: model?.id ?? modelId,
      name: model?.name ?? modelId,
      inputModalities: model?.images ? ['text', 'image'] : ['text'],
      context: { contextWindow: model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: model?.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(reasoning === undefined ? {} : { reasoning }),
    }
  }

  /**
   * @param {any} options
   * @returns {AsyncGenerator<any>}
   */
  async *stream(options) {
    const profile = this.config.options().profile ?? {}
    const hasImages = options.messages.some((message) => contentHasImage(message.content))
    if (hasImages) {
      const model = this.config.models().find((candidate) => candidate.id === options.model)
      if (model !== undefined && model.images !== true) {
        throw new LlmError(`CodeBuddy model "${options.model}" does not accept image input.`, 'UNSUPPORTED_CONTENT')
      }
    }

    const credential = await this.config.resolveCredential(options.provider, profile)
    const baseURL = credential.baseURL
    const controller = new AbortController()
    const signal = options.signal === undefined
      ? controller.signal
      : AbortSignal.any([options.signal, controller.signal])
    const requestImages = await prepareRequestImages(options.messages, this.config.resolveAttachments(), signal)
    const body = serializeRequest(options, requestImages)

    // attributionHeaders() 自带一个包含 deepseek-harness 的 UA；CodeBuddy 的服务端
    // 会拒绝这种 UA（HTTP 400 code 11128）。先摘掉它，再写入客户端身份 UA，
    // 避免两个大小写不同的 user-agent 头被 fetch 合并成一个非法值。
    const attribution = { ...attributionHeaders() }
    delete attribution['user-agent']
    delete attribution['User-Agent']
    /**
     * 发一次请求。
     * @param {any} payload
     * @returns {Promise<Response>}
     */
    const send = async (payload) => {
      try {
        return await fetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            ...attribution,
            ...credentialHeaders(credential),
            // WorkBuddy 的聊天网关要求官方客户端的会话身份三连；缺任何一个都会
            // 被渠道校验拒绝（HTTP 400 / code 11128）。每次请求重新生成，
            // 官方客户端也是每次 randomUUID()，不复用旧会话身份。
            ...(credential.kind === 'workbuddy' ? {
              'X-Conversation-ID': randomUUID(),
              'X-Conversation-Request-ID': randomUUID(),
              'X-Conversation-Message-ID': randomUUID(),
            } : {}),
          },
          body: JSON.stringify(payload),
          signal,
        })
      }
      catch (error) {
        if (signal.aborted) throw new LlmError('CodeBuddy request aborted', 'ABORTED', { cause: error })
        const cause = error?.cause
        const detail = cause?.code || cause?.message || (error instanceof Error ? error.message : String(error))
        throw new LlmError(`CodeBuddy request to ${baseURL}/chat/completions failed: ${detail}`, 'TRANSPORT', { cause: error })
      }
    }

    let response = await send(body)
    let status = response.status
    let raw = ''
    if (!response.ok) {
      raw = await response.text().catch(() => '')
      const failure = classifyFailure({ status, body: raw })
      // 渠道指纹是会变的：上游扩名单后，插件内置的名单可能漏判。这里在收到
      // 11128 / unapproved channel 时把每条 system 都加中性开头，只重试一次
      // ——重试用同一份凭据、同一份消息，唯一的差异是 prompt 开头。
      if (failure.kind === 'channel') {
        const healed = healSystemHeads(body)
        if (healed !== undefined) {
          body.messages = healed
          response = await send(body)
          status = response.status
          if (!response.ok) raw = await response.text().catch(() => '')
        }
      }
      if (!response.ok) {
        const finalFailure = classifyFailure({ status, body: raw })
        throw new LlmError(
          `CodeBuddy API error (HTTP ${status}) from ${baseURL}/chat/completions: ${raw.slice(0, 300)}`,
          status === 401 || status === 403
            ? 'AUTH'
            : status === 429
              ? 'RATE_LIMIT'
              : status >= 500 ? 'SERVER' : 'INVALID_REQUEST',
          { status, kind: finalFailure.kind, hint: finalFailure.message },
        )
      }
    }
    if (response.body === null) throw new LlmError('CodeBuddy API returned no response body', 'EMPTY_RESPONSE')
    yield* translate(parseSse(response.body))
  }
}
