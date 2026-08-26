/**
 * On-screen subtitle for the turn-based voice pipeline.
 *
 * This backend has no speech synthesis, so the subtitle IS the assistant's
 * voice. That makes one detail load-bearing: the system prompt tells the model
 * not to speak in the same response as a tool call, so `reply` is empty exactly
 * when the user successfully did something. A subtitle that only rendered
 * `reply` would be blank on every working command and full of text only when
 * nothing happened -- precisely backwards.
 *
 * `describeTurn` therefore falls back to naming the actions taken, so the user
 * always gets confirmation that their words landed.
 *
 * The describe half is pure and unit-tested; the render half touches the DOM.
 *
 * @module voice/voiceSubtitle
 */

/**
 * Human-readable phrasing for the tool names a turn is most likely to use.
 * Anything unmapped degrades to its own name with underscores removed, which
 * reads acceptably ("set detection") rather than failing -- so a tool added
 * upstream needs no change here to stay usable.
 */
const ACTION_PHRASES = Object.freeze({
  fly_to_location: 'Flying there',
  zoom_to_globe: 'Zooming out to the globe',
  adjust_camera_zoom: 'Adjusting zoom',
  move_camera: 'Moving the camera',
  fly_route: 'Flying the route',
  set_layer_visibility: 'Updating layers',
  show_data_layers_menu: 'Opening data layers',
  set_panel_open: 'Opening panel',
  set_context_mode: 'Switching context',
  control_cockpit: 'Cockpit',
  set_visual_style: 'Changing style',
  set_map_stack: 'Switching basemap',
  set_post_processing: 'Adjusting visuals',
  set_hud: 'Updating HUD',
  set_detection: 'Updating detection',
  control_scene: 'Running scene',
  control_cctv: 'Camera feed',
  control_radio: 'Radio',
  track_entity: 'Tracking',
  stop_tracking: 'Stopped tracking',
  frame_overhead: 'Framing overhead',
  annotate_map: 'Marking the map',
  clear_annotations: 'Clearing marks',
  analyst_query: 'Looking that up',
  get_entity_context: 'Reading the scene',
  get_current_view_state: 'Checking the view',
  select_nearest_aircraft: 'Selecting nearest aircraft',
  next_iss_pass: 'Checking the ISS pass',
});

/**
 * Strip the markdown a chat model reaches for by habit.
 *
 * These replies were written to be SPOKEN -- the prompt asks for short verbal
 * confirmations -- but the model still emits **bold** and `code`. The subtitle
 * renders textContent, so without this the user reads the asterisks aloud in
 * their head: "That's **SWA2355**". Not a formatting nicety: it is the
 * difference between a caption and a diff.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripMarkdown(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, '')       // fenced blocks have no place in a caption
    .replace(/\*\*([^*]+)\*\*/g, '$1')     // **bold**
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2') // *italic*, not a bare asterisk
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1$2')   // _italic_
    .replace(/`([^`]+)`/g, '$1')          // `code`
    .replace(/^#{1,6}\s+/gm, '')           // headings
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](link)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detect a tool call that leaked into the reply text as prose.
 *
 * When a provider does not implement tool calling it ignores the `tools`
 * parameter, and the model emits its internal call syntax as content instead.
 * Observed in production as a subtitle reading
 * `<|DSML|tool_calls> <|DSML|invoke name="control_cctv">...`.
 *
 * Routing now forbids those endpoints (require_parameters), so this is the
 * backstop: showing raw markup where an answer belongs is worse than admitting
 * the turn was lost, because it looks like the app is broken rather than like
 * one command needing a retry.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeLeakedToolCall(text) {
  const t = String(text || '');
  if (!t) return false;
  return /\|?\s*DSML\s*\|/i.test(t)
    || /<\s*\|?\s*tool_calls?\s*\|?\s*>/i.test(t)
    || /<\s*\|?\s*invoke\s+name\s*=/i.test(t)
    || /<function_call|<\|python_tag\|>|<tool_call>/i.test(t);
}

/** @param {string} name @returns {string} */
function phraseFor(name) {
  return ACTION_PHRASES[name] || String(name || '').replace(/_/g, ' ');
}

/**
 * Decide what the subtitle should say for one completed turn.
 *
 * @param {{transcript?: string, reply?: string, toolCalls?: Array<{name: string}>, malformed?: string[]}|null|undefined} turn
 * @returns {{kind: 'reply'|'action'|'idle'|'empty', text: string, transcript: string, note: string}}
 */
export function describeTurn(turn) {
  const transcript = String(turn?.transcript || '').trim();
  const reply = stripMarkdown(turn?.reply);
  const calls = Array.isArray(turn?.toolCalls) ? turn.toolCalls : [];
  const malformed = Array.isArray(turn?.malformed) ? turn.malformed : [];

  // A malformed call is worth surfacing: the user asked for something and part
  // of it silently did not run. Better a small note than a phantom success.
  const note = malformed.length
    ? `Couldn't run: ${malformed.join(', ')}`
    : '';

  if (reply && looksLikeLeakedToolCall(reply)) {
    // The command is genuinely lost -- say so plainly rather than showing markup.
    return { kind: 'idle', text: "Didn't catch that — say it again", transcript, note };
  }

  if (reply) return { kind: 'reply', text: reply, transcript, note };

  if (calls.length) {
    const names = [...new Set(calls.map((c) => phraseFor(c?.name)))];
    // Two actions read fine joined; beyond that a count is kinder than a list.
    const text = names.length <= 2
      ? names.join(' · ')
      : `${names.slice(0, 2).join(' · ')} +${names.length - 2} more`;
    return { kind: 'action', text, transcript, note };
  }

  // Heard something, but the model neither spoke nor acted.
  if (transcript) return { kind: 'idle', text: 'No action taken', transcript, note };

  // Push-to-talk released with no speech in it. Not an error worth shouting about.
  return { kind: 'empty', text: '', transcript: '', note: '' };
}

/**
 * How long a subtitle should stay up, scaled to how much there is to read.
 * Short confirmations vanish quickly; a real answer gets time to be read.
 *
 * @param {string} text
 * @returns {number} milliseconds
 */
export function subtitleHoldMs(text) {
  const length = String(text || '').length;
  if (!length) return 0;
  // ~45ms per character is a comfortable reading pace, clamped so a one-word
  // confirmation still registers and a long answer does not camp on screen.
  return Math.min(12_000, Math.max(2_500, Math.round(length * 45)));
}

/**
 * Create the subtitle surface.
 *
 * @param {{doc?: Document, mount?: Element|null}} [options]
 * @returns {{element: Element, show: (text: string, opts?: {kind?: string, transcript?: string, note?: string, hold?: number}) => void, status: (text: string) => void, clear: () => void, destroy: () => void}}
 */
export function createVoiceSubtitle({ doc = document, mount = null } = {}) {
  const host = mount || doc.body;
  const element = doc.createElement('div');
  element.className = 'gev-voice-subtitle';
  element.setAttribute('role', 'status');
  // Announced politely: this narrates the app's response, and an assertive
  // region would interrupt whatever a screen-reader user was already hearing.
  element.setAttribute('aria-live', 'polite');
  element.hidden = true;

  const said = doc.createElement('p');
  said.className = 'gev-voice-subtitle__said';
  const line = doc.createElement('p');
  line.className = 'gev-voice-subtitle__line';
  const note = doc.createElement('p');
  note.className = 'gev-voice-subtitle__note';

  element.append(said, line, note);
  host.appendChild(element);

  let timer = null;
  const stopTimer = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };

  function clear() {
    stopTimer();
    element.hidden = true;
    said.textContent = '';
    line.textContent = '';
    note.textContent = '';
    element.dataset.kind = '';
  }

  function show(text, { kind = 'reply', transcript = '', note: noteText = '', hold } = {}) {
    stopTimer();
    if (!text && !transcript) return clear();
    element.hidden = false;
    element.dataset.kind = kind;
    said.textContent = transcript ? `“${transcript}”` : '';
    said.hidden = !transcript;
    line.textContent = text || '';
    line.hidden = !text;
    note.textContent = noteText || '';
    note.hidden = !noteText;
    const ms = Number.isFinite(hold) ? hold : subtitleHoldMs(text || transcript);
    if (ms > 0) timer = setTimeout(clear, ms);
  }

  /** A persistent line with no auto-hide, for "Listening…" and errors. */
  function status(text) {
    stopTimer();
    if (!text) return clear();
    element.hidden = false;
    element.dataset.kind = 'status';
    said.textContent = '';
    said.hidden = true;
    line.textContent = text;
    line.hidden = false;
    note.textContent = '';
    note.hidden = true;
  }

  return {
    element,
    show,
    status,
    clear,
    destroy() {
      stopTimer();
      element.remove();
    },
  };
}
