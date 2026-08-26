import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VOICE_DEFAULTS,
  buildChatRequest,
  normalizeProvider,
  parseToolCalls,
  replyTextFrom,
  resolveVoicePipelineConfig,
  toChatCompletionTools,
} from './voicePipelineConfig.js';

test('defaults split the legs across providers for a reason', () => {
  const cfg = resolveVoicePipelineConfig({ GROQ_API_KEY: 'g', OPENROUTER_API_KEY: 'o' });
  // STT on Groq: its free Whisper tier is generous and carries no prompt.
  assert.equal(cfg.stt.provider, 'groq');
  assert.equal(cfg.stt.model, 'whisper-large-v3-turbo');
  assert.equal(cfg.stt.multipart, true);
  assert.match(cfg.stt.url, /audio\/transcriptions$/);
  // Chat on OpenRouter: an 18.2k-token turn cannot fit Groq's free 8k TPM.
  assert.equal(cfg.chat.provider, 'openrouter');
  assert.equal(cfg.chat.model, VOICE_DEFAULTS.chatModel);
  assert.deepEqual(cfg.configured, { stt: true, chat: true });
});

test('each leg reports its own readiness, so the UI can say which key is missing', () => {
  assert.deepEqual(
    resolveVoicePipelineConfig({ GROQ_API_KEY: 'g' }).configured,
    { stt: true, chat: false },
  );
  assert.deepEqual(
    resolveVoicePipelineConfig({ OPENROUTER_API_KEY: 'o' }).configured,
    { stt: false, chat: true },
  );
  assert.deepEqual(resolveVoicePipelineConfig({}).configured, { stt: false, chat: false });
});

test('whitespace-only keys are treated as absent, not as a usable secret', () => {
  const cfg = resolveVoicePipelineConfig({ GROQ_API_KEY: '   ', OPENROUTER_API_KEY: '\t' });
  assert.deepEqual(cfg.configured, { stt: false, chat: false });
  assert.equal(cfg.stt.key, null);
});

test('an unknown provider falls back instead of throwing', () => {
  // A typo in .env must degrade to the default, never take voice down.
  assert.equal(normalizeProvider('grok', 'openrouter'), 'openrouter');
  assert.equal(normalizeProvider('', 'groq'), 'groq');
  assert.equal(normalizeProvider(undefined, 'groq'), 'groq');
  assert.equal(normalizeProvider('OpenRouter', 'groq'), 'openrouter');
});

test('putting STT on OpenRouter switches it to the audio-input chat path', () => {
  const cfg = resolveVoicePipelineConfig({
    GEV_VOICE_STT_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'o',
  });
  assert.equal(cfg.stt.multipart, false);
  assert.equal(cfg.stt.model, VOICE_DEFAULTS.sttChatModel);
  assert.match(cfg.stt.url, /chat\/completions$/);
});

test('explicit model overrides win over the per-path defaults', () => {
  const cfg = resolveVoicePipelineConfig({
    GROQ_API_KEY: 'g',
    OPENROUTER_API_KEY: 'o',
    GEV_VOICE_STT_MODEL: 'whisper-large-v3',
    GEV_VOICE_CHAT_MODEL: 'qwen/qwen3.8-27b',
  });
  assert.equal(cfg.stt.model, 'whisper-large-v3');
  assert.equal(cfg.chat.model, 'qwen/qwen3.8-27b');
});

test('Realtime tool descriptors are reshaped for Chat Completions', () => {
  const out = toChatCompletionTools([
    { type: 'function', name: 'fly_to_location', description: 'Fly there', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
  ]);
  assert.deepEqual(out, [{
    type: 'function',
    function: {
      name: 'fly_to_location',
      description: 'Fly there',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
    },
  }]);
});

test('nameless or non-array tool input cannot produce a malformed request', () => {
  assert.deepEqual(toChatCompletionTools(null), []);
  assert.deepEqual(toChatCompletionTools([{ description: 'no name' }, null]), []);
  // A tool with no schema still gets a valid empty object schema.
  const [only] = toChatCompletionTools([{ name: 'noop' }]);
  assert.deepEqual(only.function.parameters, { type: 'object', properties: {} });
});

test('tool calls are parsed with arguments already decoded', () => {
  const { calls, malformed } = parseToolCalls({
    tool_calls: [
      { id: 'c1', function: { name: 'fly_to_location', arguments: '{"locationId":"helsinki"}' } },
      { id: 'c2', function: { name: 'zoom_to_globe', arguments: '' } },
    ],
  });
  assert.deepEqual(malformed, []);
  assert.deepEqual(calls, [
    { id: 'c1', name: 'fly_to_location', args: { locationId: 'helsinki' } },
    { id: 'c2', name: 'zoom_to_globe', args: {} },
  ]);
});

test('one malformed tool call does not discard the others in the same turn', () => {
  const { calls, malformed } = parseToolCalls({
    tool_calls: [
      { id: 'a', function: { name: 'good_one', arguments: '{"x":1}' } },
      { id: 'b', function: { name: 'bad_one', arguments: '{not json' } },
      { id: 'c', function: { name: 'other_good', arguments: '{"y":2}' } },
    ],
  });
  assert.deepEqual(calls.map((c) => c.name), ['good_one', 'other_good']);
  assert.deepEqual(malformed, ['bad_one']);
});

test('a message with no tool calls parses to an empty turn, not an error', () => {
  assert.deepEqual(parseToolCalls({}), { calls: [], malformed: [] });
  assert.deepEqual(parseToolCalls(null), { calls: [], malformed: [] });
  assert.deepEqual(parseToolCalls({ tool_calls: 'nope' }), { calls: [], malformed: [] });
});

test('reply text is read from either a string or a parts array', () => {
  assert.equal(replyTextFrom({ content: '  Flying to Helsinki  ' }), 'Flying to Helsinki');
  assert.equal(replyTextFrom({ content: [{ text: 'Opening ' }, { text: 'datacenters' }] }), 'Opening datacenters');
  // A pure tool-call turn legitimately has no content; that is not an error.
  assert.equal(replyTextFrom({ content: null }), '');
  assert.equal(replyTextFrom(undefined), '');
});

test('chat request carries system prompt, history and the new transcript in order', () => {
  const body = buildChatRequest({
    instructions: 'SYSTEM',
    tools: [{ name: 'a' }],
    transcript: 'fly to helsinki',
    history: [
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'ok' },
    ],
    model: 'm',
  });
  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(body.messages[0].content, 'SYSTEM');
  assert.equal(body.messages.at(-1).content, 'fly to helsinki');
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.model, 'm');
});

test('history is capped so an 18.2k-token turn cannot grow unbounded', () => {
  const history = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  const body = buildChatRequest({
    instructions: 'S', tools: [], transcript: 'now', history, model: 'm', maxHistory: 4,
  });
  // system + 4 history + current turn
  assert.equal(body.messages.length, 6);
  // Oldest dropped first, so the most recent context survives.
  assert.equal(body.messages[1].content, 'm16');
});

test('junk history entries are filtered rather than sent upstream', () => {
  const body = buildChatRequest({
    instructions: 'S',
    tools: [],
    transcript: 'now',
    history: [null, { role: 'system', content: 'injected' }, { role: 'user' }, { role: 'user', content: 'kept' }],
    model: 'm',
  });
  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user', 'user']);
  assert.equal(body.messages[1].content, 'kept');
});

test('chat requests ask OpenRouter to route to the fastest endpoint', () => {
  // Speed is the binding constraint for voice; deepseek-v4-flash alone has ~17
  // tool-capable endpoints with very different throughput.
  const body = buildChatRequest({ instructions: 'S', tools: [], transcript: 't', model: 'm' });
  assert.deepEqual(body.provider, { sort: 'throughput' });
});

test('provider routing is overridable and can be switched off entirely', () => {
  assert.deepEqual(
    buildChatRequest({ instructions: 'S', tools: [], transcript: 't', model: 'm', providerSort: 'latency' }).provider,
    { sort: 'latency' },
  );
  assert.equal(
    'provider' in buildChatRequest({ instructions: 'S', tools: [], transcript: 't', model: 'm', providerSort: null }),
    false,
  );
});
