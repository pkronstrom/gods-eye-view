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
  // USD per MILLION tokens. See buildChatRequest for why this exists and why
  // it is a hard constraint worth keeping loose.
  maxPrice: Object.freeze({ prompt: 0.15, completion: 0.30 }),
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
  maxPrice = VOICE_DEFAULTS.maxPrice,
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
    // "Fastest, but not at any price."
    //
    // Speed is the binding constraint for a voice UI: a command that lands in
    // one second is a different product from one that lands in four. So sort by
    // throughput and let OpenRouter pick the quickest endpoint per request
    // rather than pinning a provider here and watching it rot. 'throughput'
    // beats 'latency' for us because the reply is a few hundred tokens on top
    // of an 18.2k-token prefill, so sustained rate dominates time-to-first-token.
    //
    // But sort alone ignores cost, and the price spread WITHIN a single model
    // is large: deepseek-v4-flash ranges from $0.068/1M (DigitalOcean) to
    // $0.440/1M (Cloudflare) across its 17 tool-capable endpoints -- 6.5x on
    // the same model. max_price bounds that. At the default ceiling 13 of 17
    // endpoints stay eligible and the worst case is ~2x the cheapest, which
    // leaves routing plenty of room to actually optimise for speed.
    //
    // CAUTION: max_price is a HARD constraint -- if no endpoint qualifies the
    // request FAILS rather than falling back to a dearer one. Keep the ceiling
    // loose enough to retain several providers, and raise it if upstream
    // pricing drifts. Set maxPrice to null to disable the cap entirely.
    // Both fields are USD per MILLION tokens. Ignored by non-OpenRouter providers.
    ...(providerSort || maxPrice
      ? {
        provider: {
          ...(providerSort ? { sort: providerSort } : {}),
          ...(maxPrice ? { max_price: maxPrice } : {}),
        },
      }
      : {}),
  };
}

/**
 * Build the SECOND request of a turn: the one that lets the model answer from
 * what its tools returned.
 *
 * Without this the pipeline is single-pass and questions cannot work. The model
 * asks for get_entity_context, the client runs it, and the answer is dropped on
 * the floor -- "what is this aircraft?" fetches the aircraft and says nothing.
 * Commands still appear to work, because for them the tool call IS the action,
 * which makes the gap easy to miss.
 *
 * Shape follows the OpenAI tool-calling convention every provider here
 * implements: the assistant turn carrying `tool_calls`, then one `tool` message
 * per call keyed by `tool_call_id`.
 *
 * @param {{instructions: string, tools: Array, transcript: string, history?: Array, model: string, toolCalls: Array<{id: string, name: string, args: object}>, results: Array<{id: string, name: string, result: unknown}>, maxHistory?: number, providerSort?: string|null, maxPrice?: object|null, maxResultChars?: number}} options
 * @returns {object}
 */
export function buildFollowUpRequest({
  instructions,
  tools,
  transcript,
  history = [],
  model,
  toolCalls,
  results,
  maxHistory = 6,
  providerSort = 'throughput',
  maxPrice = VOICE_DEFAULTS.maxPrice,
  maxResultChars = 6000,
}) {
  const base = buildChatRequest({
    instructions, tools, transcript, history, model, maxHistory, providerSort, maxPrice,
  });
  const byId = new Map((results || []).map((r) => [String(r.id), r]));
  const assistant = {
    role: 'assistant',
    content: null,
    tool_calls: (toolCalls || []).map((call) => ({
      id: String(call.id),
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
    })),
  };
  // EVERY tool_call MUST get a reply. Providers reject a follow-up with an
  // unanswered call id, so a tool that threw still reports -- as an error, not
  // as silence.
  const toolMessages = (toolCalls || []).map((call) => {
    const entry = byId.get(String(call.id));
    let content;
    try {
      content = JSON.stringify(entry ? entry.result : { error: 'tool did not run' });
    } catch {
      content = JSON.stringify({ error: 'result not serializable' });
    }
    // get_entity_context can return a very large scene dump; the prompt is
    // already ~18.2k tokens before any of this.
    if (content.length > maxResultChars) {
      content = `${content.slice(0, maxResultChars)}…[truncated]`;
    }
    return { role: 'tool', tool_call_id: String(call.id), content };
  });

  return {
    ...base,
    messages: [...base.messages, assistant, ...toolMessages],
    // The model has its data now; it should answer, not call more tools. This
    // deliberately caps a turn at one round of tools rather than looping.
    tool_choice: 'none',
  };
}

/**
 * Whisper's silence hallucinations, verbatim.
 *
 * Fed near-silence, Whisper does not return an empty string -- it returns
 * confident filler learned from the training corpus, most often subtitle
 * boilerplate. Observed here as "thank you thank you" after a stuck recorder
 * uploaded an empty room.
 *
 * This is the dangerous failure mode for a voice UI: an empty transcript is
 * obviously nothing, but a hallucinated one reads as a real utterance and gets
 * sent to the model, which then answers it. The user sees a plausible reply to
 * something they never said.
 *
 * Deliberately EXACT full-string matches only, never substrings: "thank you"
 * alone is a hallucination, but "thank you, now fly to Helsinki" is speech.
 */
const SILENCE_HALLUCINATIONS = Object.freeze(new Set([
  'you', 'thank you', 'thanks', 'thank you very much', 'thank you so much',
  'thanks for watching', 'thanks for watching!', 'thank you for watching',
  'bye', 'bye bye', 'okay', 'ok', 'so', 'oh', 'hmm', 'mm', 'uh', 'um',
  'subtitles by the amara.org community', 'subs by www.zeoranger.co.uk',
  'please subscribe', 'like and subscribe',
]));

/**
 * True when a transcript is almost certainly Whisper filling in silence.
 *
 * Collapses repetition first: the observed case was the same two words twice
 * ("thank you thank you"), which is characteristic -- the model loops on its
 * own output when there is nothing to transcribe.
 *
 * @param {string|null|undefined} transcript
 * @returns {boolean}
 */
export function isSilenceHallucination(transcript) {
  const normalized = String(transcript || '')
    .toLowerCase()
    .replace(/[.,!?;:\u2019'"()\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  if (SILENCE_HALLUCINATIONS.has(normalized)) return true;

  // Collapse an exactly-repeated phrase and re-test, so "thank you thank you"
  // and "you you you" resolve to their single form.
  const words = normalized.split(' ');
  for (let size = 1; size <= Math.floor(words.length / 2); size += 1) {
    if (words.length % size !== 0) continue;
    const unit = words.slice(0, size).join(' ');
    let repeated = true;
    for (let i = size; i < words.length; i += size) {
      if (words.slice(i, i + size).join(' ') !== unit) { repeated = false; break; }
    }
    if (repeated && SILENCE_HALLUCINATIONS.has(unit)) return true;
  }
  return false;
}
