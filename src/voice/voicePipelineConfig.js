/**
 * Provider-agnostic configuration for the turn-based voice pipeline.
 *
 * This is the alternative voice backend to `gevRealtime.js`. Where Realtime is
 * a WebRTC speech-to-speech session against OpenAI, this pipeline is three
 * plain HTTP legs -- speech-to-text, then a tool-calling chat completion, then
 * (deliberately, for now) NO speech synthesis: the assistant's reply is shown
 * on screen as a subtitle instead.
 *
 * Everything here is pure so it can be unit-tested without a network or a
 * browser. The Vite proxy plugin owns the fetches; this module owns the
 * decisions.
 *
 * WHY TWO PROVIDERS BY DEFAULT
 *
 * The per-turn prompt is ~18.2k tokens (~6.3k of system instructions plus
 * ~11.9k of tool schemas for the 28 GEV tools). Groq's free tier allows 8k
 * tokens/minute on openai/gpt-oss-120b, so a single turn is 2.3x the whole
 * per-minute budget -- the free tier cannot serve even one chat turn with the
 * full tool set. Speech-to-text has no such prompt, and Groq's free Whisper
 * limits (7.2k audio-seconds/hour) are generous, so the split is:
 *
 *   STT  -> Groq whisper-large-v3-turbo        (free tier, fast)
 *   CHAT -> OpenRouter deepseek/deepseek-v4-flash (~$0.0016/turn at 18.2k tokens)
 *
 * Cost is not what picks the chat model at these volumes -- 1,000 voice
 * commands is $1.56 -- tool-calling reliability across 28 complex schemas is.
 * GEV_VOICE_CHAT_MODEL swaps it in one line. Measured alternatives, per turn:
 * qwen/qwen3.7-flash $0.0006, openai/gpt-oss-120b $0.0007,
 * qwen/qwen3.8-27b $0.0085 (slower, dense, but the strongest of the four).
 *
 * Both legs are independently overridable, so a Groq paid plan (or a trimmed
 * tool set that fits 8k) makes this a one-provider setup by changing env only.
 *
 * @module voice/voicePipelineConfig
 */

/** Provider ids this pipeline knows how to talk to. */
export const VOICE_PROVIDERS = Object.freeze(['groq', 'openrouter']);

/** Per-provider endpoints and the env var holding the secret. */
export const VOICE_PROVIDER_ENDPOINTS = Object.freeze({
  groq: Object.freeze({
    keyEnv: 'GROQ_API_KEY',
    chatUrl: 'https://api.groq.com/openai/v1/chat/completions',
    // Groq exposes a real transcription endpoint (multipart), unlike
    // OpenRouter, which only understands audio as a chat content part.
    transcriptionUrl: 'https://api.groq.com/openai/v1/audio/transcriptions',
    supportsTranscriptionEndpoint: true,
  }),
  openrouter: Object.freeze({
    keyEnv: 'OPENROUTER_API_KEY',
    chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
    // No dedicated STT route: transcription happens as a chat completion
    // against an audio-input model, with the audio as an input_audio part.
    transcriptionUrl: null,
    supportsTranscriptionEndpoint: false,
  }),
});

export const VOICE_DEFAULTS = Object.freeze({
  sttProvider: 'groq',
  sttModel: 'whisper-large-v3-turbo',
  chatProvider: 'openrouter',
  chatModel: 'deepseek/deepseek-v4-flash',
  // Audio-input chat model used only when the STT provider has no
  // transcription endpoint (i.e. OpenRouter).
  sttChatModel: 'google/gemini-3.7-flash',
});

/**
 * Normalize a provider id, falling back rather than throwing -- a typo in
 * .env should degrade to the default, not take the voice feature down.
 * @param {string|undefined|null} value
 * @param {string} fallback
 * @returns {string}
 */
export function normalizeProvider(value, fallback) {
  const id = String(value || '').trim().toLowerCase();
  return VOICE_PROVIDERS.includes(id) ? id : fallback;
}

/**
 * Resolve the full pipeline configuration from an env-like object.
 *
 * `configured` reports whether each leg has a usable key, so the client can be
 * told precisely what is unavailable ("no speech-to-text key") instead of a
 * generic failure after the user has already spoken.
 *
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {{stt: {provider: string, model: string, key: string|null, url: string|null, multipart: boolean}, chat: {provider: string, model: string, key: string|null, url: string}, configured: {stt: boolean, chat: boolean}}}
 */
export function resolveVoicePipelineConfig(env = {}) {
  const sttProvider = normalizeProvider(env.GEV_VOICE_STT_PROVIDER, VOICE_DEFAULTS.sttProvider);
  const chatProvider = normalizeProvider(env.GEV_VOICE_CHAT_PROVIDER, VOICE_DEFAULTS.chatProvider);

  const sttEndpoints = VOICE_PROVIDER_ENDPOINTS[sttProvider];
  const chatEndpoints = VOICE_PROVIDER_ENDPOINTS[chatProvider];

  const sttKey = (env[sttEndpoints.keyEnv] || '').trim() || null;
  const chatKey = (env[chatEndpoints.keyEnv] || '').trim() || null;

  const multipart = sttEndpoints.supportsTranscriptionEndpoint;
  const sttModel = (env.GEV_VOICE_STT_MODEL || '').trim()
    || (multipart ? VOICE_DEFAULTS.sttModel : VOICE_DEFAULTS.sttChatModel);

  return {
    stt: {
      provider: sttProvider,
      model: sttModel,
      key: sttKey,
      url: multipart ? sttEndpoints.transcriptionUrl : chatEndpointFor(sttProvider),
      multipart,
    },
    chat: {
      provider: chatProvider,
      model: (env.GEV_VOICE_CHAT_MODEL || '').trim() || VOICE_DEFAULTS.chatModel,
      key: chatKey,
      url: chatEndpoints.chatUrl,
    },
    configured: {
      stt: Boolean(sttKey),
      chat: Boolean(chatKey),
    },
  };
}

/** @param {string} provider @returns {string} */
function chatEndpointFor(provider) {
  return VOICE_PROVIDER_ENDPOINTS[provider].chatUrl;
}

/**
 * Adapt OpenAI *Realtime* tool descriptors to the Chat Completions shape.
 *
 * Realtime uses a flat `{type, name, description, parameters}`; Chat
 * Completions nests everything but `type` under `function`. Sharing one array
 * across both backends means a tool added for Realtime is automatically
 * available here, which is the whole point of not forking the tool list.
 *
 * @param {Array<{type?: string, name?: string, description?: string, parameters?: object}>} tools
 * @returns {Array<{type: 'function', function: {name: string, description: string, parameters: object}}>}
 */
export function toChatCompletionTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool) => tool && typeof tool.name === 'string' && tool.name)
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: String(tool.description || ''),
        parameters: tool.parameters || { type: 'object', properties: {} },
      },
    }));
}

/**
 * Normalize the tool calls out of a Chat Completions response into the shape
 * `createGevActionRunner` expects: a name and already-parsed arguments.
 *
 * Malformed JSON in `arguments` is dropped rather than thrown: one bad call
 * from the model must not discard the other calls in the same turn, and the
 * caller reports what it could not run.
 *
 * @param {object|null|undefined} message - `choices[0].message`.
 * @returns {{calls: Array<{id: string, name: string, args: object}>, malformed: string[]}}
 */
export function parseToolCalls(message) {
  const raw = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const calls = [];
  const malformed = [];
  for (const entry of raw) {
    const name = entry?.function?.name;
    if (typeof name !== 'string' || !name) continue;
    const argText = entry.function?.arguments;
    let args = {};
    if (typeof argText === 'string' && argText.trim()) {
      try {
        const parsed = JSON.parse(argText);
        args = (parsed && typeof parsed === 'object') ? parsed : {};
      } catch {
        malformed.push(name);
        continue;
      }
    }
    calls.push({ id: String(entry.id || name), name, args });
  }
  return { calls, malformed };
}

/**
 * The spoken-reply text for the subtitle.
 *
 * Reasoning models (gpt-oss included) can return an empty `content` when the
 * turn is purely tool calls, which is correct behaviour and not an error --
 * the caller decides what to show for a silent tool turn.
 *
 * @param {object|null|undefined} message - `choices[0].message`.
 * @returns {string}
 */
export function replyTextFrom(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  // Some providers return content as an array of parts.
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('')
      .trim();
  }
  return '';
}

/**
 * Build the chat request body for one voice turn.
 *
 * `history` is capped rather than unbounded: the system prompt plus tool
 * schemas already cost ~18.2k tokens per turn, so letting transcript history
 * grow without limit is the difference between a cheap request and a runaway
 * one. Oldest turns are dropped first.
 *
 * @param {{instructions: string, tools: Array, transcript: string, history?: Array<{role: string, content: string}>, model: string, maxHistory?: number}} options
 * @returns {object}
 */
export function buildChatRequest({
  instructions,
  tools,
  transcript,
  history = [],
  model,
  maxHistory = 6,
  providerSort = 'throughput',
}) {
  const trimmed = Array.isArray(history)
    ? history
      .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
      .slice(-Math.max(0, maxHistory))
    : [];
  return {
    model,
    messages: [
      { role: 'system', content: String(instructions || '') },
      ...trimmed.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: String(transcript || '') },
    ],
    tools: toChatCompletionTools(tools),
    tool_choice: 'auto',
    // Keep replies short: they are rendered as a one-or-two-line subtitle, not
    // spoken, so a long paragraph is worse than useless here.
    max_tokens: 400,
    // Speed is the binding constraint for a voice UI, not price -- a voice
    // command that lands in four seconds is a different product from one that
    // lands in one. A model like deepseek-v4-flash has ~17 tool-capable
    // endpoints on OpenRouter with very different speeds, so let OpenRouter
    // pick the quickest per request rather than pinning a provider here and
    // watching it rot. 'throughput' suits us over 'latency' because the reply
    // is a few hundred tokens on top of an 18.2k-token prefill, so sustained
    // rate dominates time-to-first-token. Ignored by non-OpenRouter providers.
    ...(providerSort ? { provider: { sort: providerSort } } : {}),
  };
}
