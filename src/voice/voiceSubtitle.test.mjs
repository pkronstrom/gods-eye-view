import assert from 'node:assert/strict';
import test from 'node:test';

import { describeTurn, looksLikeLeakedToolCall, stripMarkdown, subtitleHoldMs } from './voiceSubtitle.js';

test('a spoken reply is shown verbatim alongside what was heard', () => {
  const out = describeTurn({ transcript: 'what is that', reply: 'That is the Palace of Fine Arts.' });
  assert.equal(out.kind, 'reply');
  assert.equal(out.text, 'That is the Palace of Fine Arts.');
  assert.equal(out.transcript, 'what is that');
});

test('a tool-only turn still confirms something happened', () => {
  // THE load-bearing case. The system prompt forbids speaking in the same
  // response as a tool call, so `reply` is empty exactly when the command
  // WORKED. Rendering reply alone would leave the subtitle blank on every
  // successful command -- precisely backwards.
  const out = describeTurn({
    transcript: 'fly to helsinki',
    reply: '',
    toolCalls: [{ name: 'fly_to_location' }],
  });
  assert.equal(out.kind, 'action');
  assert.equal(out.text, 'Flying there');
});

test('two actions are joined; more than two collapse to a count', () => {
  const two = describeTurn({
    toolCalls: [{ name: 'fly_to_location' }, { name: 'set_layer_visibility' }],
  });
  assert.equal(two.text, 'Flying there · Updating layers');

  const many = describeTurn({
    toolCalls: [
      { name: 'fly_to_location' }, { name: 'set_layer_visibility' },
      { name: 'set_map_stack' }, { name: 'set_hud' },
    ],
  });
  assert.equal(many.text, 'Flying there · Updating layers +2 more');
});

test('repeated calls to one tool read as a single action', () => {
  // The model often emits several set_layer_visibility calls for one request;
  // "Updating layers · Updating layers · Updating layers" is noise.
  const out = describeTurn({
    toolCalls: [
      { name: 'set_layer_visibility' }, { name: 'set_layer_visibility' },
      { name: 'set_layer_visibility' },
    ],
  });
  assert.equal(out.text, 'Updating layers');
});

test('an unmapped tool name degrades to readable words rather than failing', () => {
  // A tool added upstream must stay usable here with no change to the map.
  const out = describeTurn({ toolCalls: [{ name: 'some_new_tool' }] });
  assert.equal(out.text, 'some new tool');
});

test('heard but did nothing is stated plainly, not left blank', () => {
  const out = describeTurn({ transcript: 'mumble mumble', reply: '', toolCalls: [] });
  assert.equal(out.kind, 'idle');
  assert.equal(out.text, 'No action taken');
});

test('an empty turn shows nothing at all', () => {
  // Push-to-talk tapped with no speech in it: not an error worth shouting about.
  const out = describeTurn({ transcript: '', reply: '', toolCalls: [] });
  assert.equal(out.kind, 'empty');
  assert.equal(out.text, '');
  assert.deepEqual(describeTurn(null).kind, 'empty');
});

test('malformed tool calls are surfaced instead of silently dropped', () => {
  const out = describeTurn({
    transcript: 'do the thing',
    toolCalls: [{ name: 'fly_to_location' }],
    malformed: ['annotate_map'],
  });
  assert.equal(out.text, 'Flying there');
  assert.match(out.note, /annotate_map/);
});

test('hold time scales with reading length, within sane bounds', () => {
  assert.equal(subtitleHoldMs(''), 0);
  // A two-word confirmation still stays long enough to register.
  assert.equal(subtitleHoldMs('Flying there'), 2500);
  // A long answer gets more time, but never camps on screen.
  assert.equal(subtitleHoldMs('x'.repeat(1000)), 12_000);
  const medium = subtitleHoldMs('x'.repeat(100));
  assert.ok(medium > 2500 && medium < 12_000, `expected a mid-range hold, got ${medium}`);
});

test('markdown is stripped so a caption does not read like a diff', () => {
  // Real observed reply: the prompt asks for spoken confirmations but the model
  // still emits bold. The subtitle renders textContent, so asterisks show.
  assert.equal(
    stripMarkdown("That's Southwest flight **SWA2355**, a **Boeing 737-8**."),
    "That's Southwest flight SWA2355, a Boeing 737-8.",
  );
  assert.equal(stripMarkdown('Use `set_map_stack` for that'), 'Use set_map_stack for that');
  assert.equal(stripMarkdown('## Heading\nbody'), 'Heading body');
  assert.equal(stripMarkdown('see [the docs](https://x.example)'), 'see the docs');
});

test('stripping markdown leaves ordinary prose and lone symbols alone', () => {
  assert.equal(stripMarkdown('5 * 3 aircraft'), '5 * 3 aircraft');
  assert.equal(stripMarkdown('snake_case_name stays'), 'snake_case_name stays');
  assert.equal(stripMarkdown(''), '');
  assert.equal(stripMarkdown(null), '');
});

test('a markdown-formatted reply reaches the subtitle already clean', () => {
  const out = describeTurn({ transcript: 'what is that', reply: 'It is **Helsinki**.' });
  assert.equal(out.text, 'It is Helsinki.');
});

test('leaked tool markup is never shown as though it were an answer', () => {
  // Showing raw markup makes the app look broken; admitting the turn was lost
  // reads as one command needing a retry.
  const leaked = '<|DSML|tool_calls> <|DSML|invoke name="control_cctv">';
  assert.equal(looksLikeLeakedToolCall(leaked), true);
  const out = describeTurn({ transcript: 'show me a camera', reply: leaked });
  assert.equal(out.kind, 'idle');
  assert.match(out.text, /say it again/i);
});

test('a normal answer mentioning a tool name is not flagged as leakage', () => {
  assert.equal(looksLikeLeakedToolCall('I used set_map_stack to switch that.'), false);
  assert.equal(looksLikeLeakedToolCall('That is Helsinki.'), false);
  assert.equal(looksLikeLeakedToolCall(''), false);
});
