/**
 * Client for the turn-based voice pipeline.
 *
 * The counterpart to `gevRealtime.js`, and deliberately much smaller: there is
 * no WebRTC session, no data channel and no barge-in. One push-to-talk gesture
 * produces one HTTP turn, whose tool calls are dispatched through the SAME
 * `createGevActionRunner` the Realtime backend uses -- the 28 tools are
 * transport-agnostic and are not reimplemented here.
 *
 * There is no speech synthesis: the assistant answers on screen as a subtitle.
 *
 * @module voice/voicePipelineClient
 */

import { createGevActionRunner } from './gevActions.js';
import { createVoiceControl } from './gevRealtime.js';
import { createVoiceSubtitle, describeTurn, stripMarkdown } from './voiceSubtitle.js';

/** Turns of context sent upstream. Kept short: the prompt is already ~18.2k tokens. */
const HISTORY_TURNS = 6;

/** Hard cap on a single utterance, so a stuck key cannot upload minutes of room noise. */
const MAX_UTTERANCE_MS = 30_000;

/**
 * A press shorter than this is a stray keystroke, not dictation.
 *
 * One second rather than a few hundred milliseconds: nobody issues a command in
 * under a second, and an accidental Space tap that reaches Whisper comes back
 * as confident filler ("thank you thank you") which the model then answers --
 * the user sees a plausible reply to something they never said. Discarding is
 * strictly better than transcribing near-silence.
 */
const MIN_UTTERANCE_MS = 1000;

/**
 * Pick a container MediaRecorder can produce AND the transcription upstream
 * accepts. Chrome gives webm/opus; Safari gives mp4. Both are on Groq's list.
 * @returns {string}
 */
export function pickRecorderMimeType(Recorder = globalThis.MediaRecorder) {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  if (!Recorder?.isTypeSupported) return '';
  return candidates.find((type) => Recorder.isTypeSupported(type)) || '';
}

/** @param {Blob} blob @returns {Promise<string>} base64 without the data: prefix */
async function blobToBase64(blob) {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  // Chunked to avoid blowing the argument limit on a long utterance.
  const CHUNK = 0x8000;
  for (let i = 0; i < buffer.length; i += CHUNK) {
    binary += String.fromCharCode(...buffer.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Start the pipeline backend and take ownership of the MIC control.
 *
 * @param {{viewer: object, styleManager: object, dataManager: object, sceneDirector?: object|null, annotations?: object|null, config?: object|null}} deps
 * @returns {object} controller with stop()
 */
export function initGevVoicePipeline({
  viewer,
  styleManager,
  dataManager,
  sceneDirector = null,
  annotations = null,
  config = null,
}) {
  if (window.__gevVoiceCommands && typeof window.__gevVoiceCommands.stop === 'function') {
    window.__gevVoiceCommands.stop({ removeUi: true });
  }

  const runner = createGevActionRunner({ viewer, styleManager, dataManager, sceneDirector, annotations });
  const ui = createVoiceControl({ reset: true });
  const subtitle = createVoiceSubtitle({});

  // The tier/cost chrome belongs to the Realtime backend's per-minute billing
  // model and means nothing here -- leaving it up would imply a session is
  // running and costing money. REMOVED rather than [hidden]: the base rules set
  // an explicit `display`, which beats the bare attribute, and winning that
  // specificity fight is more fragile than deleting a node that has no meaning
  // for this backend.
  ui.tierButton?.closest('.gev-voice-cost')?.remove();
  if (ui.helpDetail) ui.helpDetail.textContent = 'Hold Space (or hold the mic) to speak · answers appear on screen';

  const history = [];
  let recorder = null;
  let stream = null;
  let chunks = [];
  let busy = false;
  let holding = false;
  let stopTimer = null;
  // Capture is asynchronous to START (getUserMedia, MediaRecorder construction)
  // but is stopped by a synchronous key/pointer event, so a release can land
  // BEFORE the start finishes. Without these, endCapture() saw holding===false,
  // did nothing, and the recorder came up unattended -- it then ran to the
  // 30s cap recording an empty room, which Whisper transcribes as its silence
  // hallucination ("thank you thank you"), and every later press was refused
  // because `holding` was stuck true. A monotonic sequence makes the release
  // win no matter which order they land in.
  let captureSeq = 0;
  let cancelledThrough = 0;
  let starting = false;
  let startedAt = 0;

  const setStatus = (statusText, detailText) => {
    if (ui.status) ui.status.textContent = statusText;
    if (detailText && ui.detail) ui.detail.textContent = detailText;
  };

  const showError = (message) => {
    if (ui.errorDetail) ui.errorDetail.textContent = message;
    ui.root?.classList.remove('error-dismissed');
    ui.root?.classList.add('has-error');
    ui.root && (ui.root.dataset.status = 'error');
    setStatus('ERROR', 'VOICE UNAVAILABLE');
  };

  const clearError = () => {
    ui.root?.classList.remove('has-error');
  };

  /** Return the control to a state where the next press is accepted. */
  function resetToIdle() {
    holding = false;
    starting = false;
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    if (ui.root && ui.root.dataset.status !== 'error') ui.root.dataset.status = 'idle';
  }

  async function beginCapture() {
    if (busy || holding || starting) return;
    const seq = ++captureSeq;
    starting = true;
    clearError();
    try {
      if (!stream) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      // The release may already have happened while we were awaiting above.
      // Honour it instead of bringing up a recorder nobody is holding.
      if (seq <= cancelledThrough) { resetToIdle(); subtitle.clear(); setStatus('READY', 'HOLD SPACE TO SPEAK'); return; }

      const mimeType = pickRecorderMimeType();
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size) chunks.push(event.data);
      };
      recorder.onstop = () => { void finishCapture(); };
      // A timeslice means data lands continuously rather than only at stop, so
      // a recorder that ends unexpectedly still yields what it heard.
      recorder.start(250);
      startedAt = Date.now();
      starting = false;
      holding = true;

      // Re-check: the release could have landed during recorder construction.
      if (seq <= cancelledThrough) { endCapture(); return; }

      if (ui.root) ui.root.dataset.status = 'listening';
      setStatus('LISTENING', 'RELEASE TO SEND');
      subtitle.status('Listening…');
      // A stuck key must not stream the room indefinitely.
      stopTimer = setTimeout(() => endCapture(), MAX_UTTERANCE_MS);
    } catch (error) {
      resetToIdle();
      showError(error?.name === 'NotAllowedError'
        ? 'Microphone permission denied'
        : `Microphone unavailable: ${error?.message || 'unknown error'}`);
      subtitle.clear();
    }
  }

  function endCapture() {
    // Recorded synchronously so an in-flight beginCapture aborts even though
    // `holding` is not true yet.
    cancelledThrough = captureSeq;
    if (starting) return;
    if (!holding) return;
    holding = false;
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  async function finishCapture() {
    const heldMs = startedAt ? Date.now() - startedAt : 0;
    const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' });
    chunks = [];
    resetToIdle();

    // Too short to contain speech. Sending it anyway wastes a turn and invites
    // Whisper's silence hallucination, which reads as a real answer and is far
    // more confusing than nothing happening.
    if (!blob.size || heldMs < MIN_UTTERANCE_MS) {
      // Say why, briefly. Silently ignoring a press reads as a broken mic.
      if (blob.size && heldMs > 0) {
        subtitle.show('Hold a little longer', { kind: 'idle', hold: 1600 });
      } else {
        subtitle.clear();
      }
      setStatus('READY', 'HOLD SPACE TO SPEAK');
      return;
    }
    await sendTurn({ audio: await blobToBase64(blob), mimeType: blob.type });
  }

  /**
   * Send one turn and apply its result. `payload` carries either audio or an
   * already-typed transcript, so the same path serves the keyboard fallback.
   * @param {{audio?: string, mimeType?: string, transcript?: string}} payload
   */
  async function sendTurn(payload) {
    busy = true;
    if (ui.root) ui.root.dataset.status = 'thinking';
    setStatus('THINKING', 'WORKING…');
    subtitle.status('Thinking…');
    try {
      const response = await fetch('/api/voice/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, history: history.slice(-HISTORY_TURNS) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        showError(data?.error || `Voice turn failed (${response.status})`);
        subtitle.clear();
        return;
      }

      const described = describeTurn(data);
      if (described.kind === 'empty') {
        subtitle.clear();
      } else {
        subtitle.show(described.text, {
          kind: described.kind,
          transcript: described.transcript,
          note: described.note,
        });
      }

      if (data.transcript) history.push({ role: 'user', content: data.transcript });
      if (data.reply) history.push({ role: 'assistant', content: data.reply });
      while (history.length > HISTORY_TURNS) history.shift();

      // Tools run in the order the model asked for them. A failure is reported
      // rather than thrown: a compound command that half-worked should say so,
      // not lose the half that succeeded.
      const failed = [];
      const results = [];
      for (const call of data.toolCalls || []) {
        try {
          const result = await runner(call.name, call.args, { isCurrent: () => true });
          results.push({ id: call.id, name: call.name, result });
          if (result && result.ok === false) failed.push(call.name);
        } catch (error) {
          results.push({ id: call.id, name: call.name, result: { error: String(error?.message || error) } });
          failed.push(call.name);
        }
      }
      if (failed.length) {
        subtitle.show(described.text || 'Partly done', {
          kind: 'action',
          transcript: described.transcript,
          note: `Failed: ${failed.join(', ')}`,
        });
      }

      // SECOND PASS. The tools have run; now let the model answer from what
      // they returned. Without this a question like "what is this aircraft?"
      // fetches the aircraft and then says nothing -- the tool output is
      // dropped. Commands hide the gap, because for them the call IS the action.
      //
      // The action subtitle above stays up meanwhile, so this costs no
      // PERCEIVED latency for commands: the confirmation is already on screen
      // and is simply replaced if the model has something better to say.
      if (results.length) {
        try {
          const answerResponse = await fetch('/api/voice/answer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              transcript: data.transcript,
              history: history.slice(-HISTORY_TURNS),
              toolCalls: data.toolCalls,
              results,
            }),
          });
          const answer = await answerResponse.json().catch(() => ({}));
          const spoken = stripMarkdown(answer?.reply);
          if (answerResponse.ok && !spoken && !failed.length) {
            // The tools ran but the model had nothing to say -- usually because
            // the request did not survive transcription, or asks for something
            // no tool covers. Silence reads as a broken app; say which it is.
            subtitle.show("No answer for that — try rephrasing", {
              kind: 'idle',
              transcript: described.transcript,
            });
          }
          if (answerResponse.ok && spoken) {
            subtitle.show(spoken, {
              kind: 'reply',
              transcript: described.transcript,
              note: failed.length ? `Failed: ${failed.join(', ')}` : '',
            });
            history.push({ role: 'assistant', content: spoken });
            while (history.length > HISTORY_TURNS) history.shift();
          }
        } catch {
          // The actions already ran and are already confirmed on screen. A
          // failed follow-up costs the sentence, not the command.
        }
      }
    } catch (error) {
      showError(error?.message || 'Voice turn failed');
      subtitle.clear();
    } finally {
      busy = false;
      if (ui.root && ui.root.dataset.status !== 'error') ui.root.dataset.status = 'idle';
      if (ui.root?.dataset.status !== 'error') setStatus('READY', 'HOLD SPACE TO SPEAK');
    }
  }

  // ── Input bindings ────────────────────────────────────────────────────────
  const onPointerDown = (event) => { event.preventDefault(); void beginCapture(); };
  const onPointerUp = () => endCapture();
  ui.button?.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);

  const onKeyDown = (event) => {
    if (event.code !== 'Space' || event.repeat) return;
    const target = event.target;
    // Never steal Space from a text field.
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    event.preventDefault();
    void beginCapture();
  };
  const onKeyUp = (event) => {
    if (event.code !== 'Space') return;
    endCapture();
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  // If focus leaves mid-hold the keyup never arrives, which would leave the
  // recorder running and wedge the control until the 30s cap.
  const onBlur = () => endCapture();
  window.addEventListener('blur', onBlur);

  setStatus('READY', 'HOLD SPACE TO SPEAK');
  if (ui.root) ui.root.dataset.status = 'idle';

  const controller = {
    backend: 'pipeline',
    config,
    /** Text entry point, for the keyboard fallback and for testing. */
    ask: (text) => sendTurn({ transcript: String(text || '') }),
    isActive: () => holding || busy,
    stop({ removeUi = false } = {}) {
      endCapture();
      ui.button?.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      stream?.getTracks?.().forEach((track) => track.stop());
      stream = null;
      subtitle.destroy();
      if (removeUi) ui.root?.remove();
    },
  };
  window.__gevVoiceCommands = controller;
  return controller;
}
