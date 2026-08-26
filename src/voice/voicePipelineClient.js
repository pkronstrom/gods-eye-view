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
import { createVoiceSubtitle, describeTurn } from './voiceSubtitle.js';

/** Turns of context sent upstream. Kept short: the prompt is already ~18.2k tokens. */
const HISTORY_TURNS = 6;

/** Hard cap on a single utterance, so a stuck key cannot upload minutes of room noise. */
const MAX_UTTERANCE_MS = 30_000;

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

  async function beginCapture() {
    if (busy || holding) return;
    clearError();
    try {
      if (!stream) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      const mimeType = pickRecorderMimeType();
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size) chunks.push(event.data);
      };
      recorder.onstop = () => { void finishCapture(); };
      recorder.start();
      holding = true;
      if (ui.root) ui.root.dataset.status = 'listening';
      setStatus('LISTENING', 'RELEASE TO SEND');
      subtitle.status('Listening…');
      // A stuck key must not stream the room indefinitely.
      stopTimer = setTimeout(() => endCapture(), MAX_UTTERANCE_MS);
    } catch (error) {
      holding = false;
      showError(error?.name === 'NotAllowedError'
        ? 'Microphone permission denied'
        : `Microphone unavailable: ${error?.message || 'unknown error'}`);
      subtitle.clear();
    }
  }

  function endCapture() {
    if (!holding) return;
    holding = false;
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  async function finishCapture() {
    const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' });
    chunks = [];
    if (!blob.size) {
      subtitle.clear();
      setStatus('OFF', 'VOICE STANDBY');
      if (ui.root) ui.root.dataset.status = 'idle';
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
      for (const call of data.toolCalls || []) {
        try {
          const result = await runner(call.name, call.args, { isCurrent: () => true });
          if (result && result.ok === false) failed.push(call.name);
        } catch {
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
      stream?.getTracks?.().forEach((track) => track.stop());
      stream = null;
      subtitle.destroy();
      if (removeUi) ui.root?.remove();
    },
  };
  window.__gevVoiceCommands = controller;
  return controller;
}
