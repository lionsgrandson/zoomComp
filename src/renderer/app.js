const $ = (id) => document.getElementById(id);

const ui = {
  mode: $('mode'),
  apiKey: $('apiKey'),
  hfToken: $('hfToken'),
  context: $('context'),
  audioEnabled: $('audioEnabled'),
  alwaysOnTop: $('alwaysOnTop'),
  ollamaEnabled: $('ollamaEnabled'),
  ollamaModel: $('ollamaModel'),
  whisperModel: $('whisperModel'),
  intervalSeconds: $('intervalSeconds'),
  speechRate: $('speechRate'),
  consent: $('consent'),
  save: $('saveSettings'),
  export: $('exportSession'),
  start: $('startStop'),
  pause: $('pauseResume'),
  status: $('status'),
  statusDot: $('statusDot'),
  advice: $('advice'),
  provider: $('provider'),
  transcript: $('transcript'),
  trace: $('decisionTrace'),
  askForm: $('askForm'),
  askInput: $('askInput'),
  compact: $('compact'),
  captureInfo: $('captureInfo')
};

let running = false;
let paused = false;
let compact = false;
let transcriptLines = [];
let sessionTranscript = [];
let adviceHistory = [];
let decisionTrace = [];
let runtimeLogs = [];
let sessionStartedAt = null;
let speechQueue = [];
let speechActive = false;
let currentUtterance = null;
let lastSpeechFingerprint = '';
let lastSpeechAt = 0;

function nowIso() {
  return new Date().toISOString();
}

function pushRuntimeLog(type, message) {
  const clean = String(message || '').replace(/\s+/g, ' ').trim();
  if (!clean) return;
  runtimeLogs.push({ time: nowIso(), type, message: clean });
  if (runtimeLogs.length > 1000) runtimeLogs = runtimeLogs.slice(-1000);
}

function pushTrace(message) {
  const clean = String(message || '').replace(/\s+/g, ' ').trim();
  if (!clean) return;
  decisionTrace.push({ time: nowIso(), message: clean });
  if (decisionTrace.length > 250) decisionTrace = decisionTrace.slice(-250);

  const visible = decisionTrace.slice(-16).map((row) => {
    const time = new Date(row.time).toLocaleTimeString();
    return `${time} · ${row.message}`;
  });
  ui.trace.textContent = visible.join('\n') || 'No decisions yet.';
  ui.trace.scrollTop = ui.trace.scrollHeight;
}

function setStatus(state, detail = '') {
  const labels = {
    idle: 'Ready',
    connecting: 'Starting local companion…',
    connected: 'Listening locally',
    paused: 'Paused',
    reconnecting: 'Reconnecting…',
    stopped: 'Stopped',
    error: 'Error'
  };
  ui.status.textContent = detail
    ? `${labels[state] || state}: ${detail}`
    : (labels[state] || state);
  ui.statusDot.dataset.state = state;
  pushRuntimeLog('status', detail ? `${state}: ${detail}` : state);
}

function addTranscript(text) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return;
  sessionTranscript.push({ time: nowIso(), text: cleaned });
  transcriptLines.push(cleaned);
  if (transcriptLines.length > 24) transcriptLines = transcriptLines.slice(-24);
  ui.transcript.textContent = transcriptLines.join('\n');
  ui.transcript.scrollTop = ui.transcript.scrollHeight;
}

function preferredVoice(text) {
  const voices = speechSynthesis.getVoices();
  const hebrew = /[\u0590-\u05FF]/.test(text);
  const locale = hebrew ? 'he' : 'en';
  return voices.find((voice) => voice.lang?.toLowerCase().startsWith(locale))
    || voices.find((voice) => voice.default)
    || voices[0];
}

function speechFingerprint(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0590-\u05ff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function signalOutputSpeaking(speaking) {
  window.zoomComp.setOutputSpeaking(Boolean(speaking)).catch(() => {});
}

function finishCurrentSpeech() {
  speechActive = false;
  currentUtterance = null;
  signalOutputSpeaking(false);
  setTimeout(processSpeechQueue, 80);
}

function processSpeechQueue() {
  if (
    speechActive ||
    paused ||
    !running ||
    !ui.audioEnabled.checked ||
    !('speechSynthesis' in window) ||
    speechQueue.length === 0
  ) return;

  const text = speechQueue.shift();
  const utterance = new SpeechSynthesisUtterance(text);
  const voice = preferredVoice(text);

  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  }

  utterance.rate = Number(ui.speechRate.value) || 1.4;
  utterance.pitch = 1.0;
  utterance.volume = 1.0;
  utterance.onstart = () => signalOutputSpeaking(true);
  utterance.onend = finishCurrentSpeech;
  utterance.onerror = finishCurrentSpeech;

  speechActive = true;
  currentUtterance = utterance;
  speechSynthesis.speak(utterance);
}

function limitSpeechWords(text, maxWords) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return words.slice(0, maxWords).join(' ') + '…';
}

function speakAdvice(text, kind = 'automatic') {
  if (!ui.audioEnabled.checked || !text?.trim() || !('speechSynthesis' in window)) return;

  const maxWords = kind === 'direct' ? 28 : (kind === 'research' ? 18 : 12);
  const clean = limitSpeechWords(text.trim(), maxWords);
  const fingerprint = speechFingerprint(clean);
  const now = Date.now();

  if (fingerprint && fingerprint === lastSpeechFingerprint && now - lastSpeechAt < 90000) {
    return;
  }

  lastSpeechFingerprint = fingerprint;
  lastSpeechAt = now;

  // Do not build a stale backlog. If one answer is already speaking,
  // keep only the newest pending answer.
  if (speechActive) speechQueue = [clean];
  else speechQueue.push(clean);

  processSpeechQueue();
}

function clearSpeech() {
  speechQueue = [];
  speechActive = false;
  currentUtterance = null;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  signalOutputSpeaking(false);
}

async function saveSettings() {
  ui.save.disabled = true;
  try {
    const settings = await window.zoomComp.saveSettings({
      apiKey: ui.apiKey.value,
      hfToken: ui.hfToken.value,
      mode: ui.mode.value,
      context: ui.context.value,
      audioEnabled: ui.audioEnabled.checked,
      alwaysOnTop: ui.alwaysOnTop.checked,
      whisperModel: ui.whisperModel.value,
      intervalSeconds: Number(ui.intervalSeconds.value),
      speechRate: Number(ui.speechRate.value),
      ollamaEnabled: ui.ollamaEnabled.checked,
      ollamaModel: ui.ollamaModel.value
    });

    ui.apiKey.value = '';
    ui.hfToken.value = '';
    ui.apiKey.placeholder = settings.hasApiKey
      ? 'Saved securely ••••••••'
      : 'Gemini API key';
    ui.hfToken.placeholder = settings.hasHfToken
      ? 'Saved securely ••••••••'
      : 'HF token (optional)';

    ui.save.textContent = 'Saved';
    setTimeout(() => { ui.save.textContent = 'Save settings'; }, 1200);
    return settings;
  } catch (error) {
    setStatus('error', error.message);
    throw error;
  } finally {
    ui.save.disabled = false;
  }
}

async function start() {
  if (!ui.consent.checked) {
    setStatus('error', 'Confirm that you have permission to process meeting audio.');
    return;
  }

  ui.start.disabled = true;
  sessionStartedAt = nowIso();
  transcriptLines = [];
  sessionTranscript = [];
  adviceHistory = [];
  decisionTrace = [];
  runtimeLogs = [];
  ui.transcript.textContent = 'No transcript yet.';
  ui.trace.textContent = 'No decisions yet.';
  setStatus('connecting', 'Saving settings…');
  ui.provider.textContent = 'Provider: starting';
  ui.captureInfo.textContent = 'Preparing local transcription…';

  try {
    await saveSettings();
    await window.zoomComp.start();
    running = true;
    paused = false;
    ui.pause.disabled = false;
    ui.pause.textContent = 'Pause';
    ui.start.textContent = 'Stop companion';
    ui.start.classList.add('danger');
    setStatus('connected');
  } catch (error) {
    running = false;
    paused = false;
    ui.pause.disabled = true;
    try { await window.zoomComp.stop(); } catch {}
    setStatus('error', error.message);
  } finally {
    ui.start.disabled = false;
  }
}

async function stop() {
  ui.start.disabled = true;
  running = false;
  paused = false;
  ui.pause.disabled = true;
  ui.pause.textContent = 'Pause';
  try {
    clearSpeech();
    await window.zoomComp.stop();
    setStatus('stopped');
    ui.captureInfo.textContent = 'Local transcription is off.';
    ui.provider.textContent = 'Provider: stopped';
  } finally {
    ui.start.textContent = 'Start companion';
    ui.start.classList.remove('danger');
    ui.start.disabled = false;
  }
}

async function toggleRunning() {
  if (running) await stop();
  else await start();
}

async function togglePause() {
  if (!running) return;

  const nextPaused = !paused;
  const result = await window.zoomComp.pause(nextPaused);
  if (!result?.ok) {
    setStatus('error', 'The local companion is not ready to pause.');
    return;
  }

  paused = nextPaused;
  ui.pause.textContent = paused ? 'Resume' : 'Pause';

  if ('speechSynthesis' in window) {
    if (paused) speechSynthesis.pause();
    else speechSynthesis.resume();
  }

  if (paused) {
    setStatus('paused', 'Listening and analysis paused.');
    ui.captureInfo.textContent = 'Paused. No meeting audio is being processed.';
  } else {
    setStatus('connected', 'Listening locally');
    processSpeechQueue();
  }
}

window.zoomComp.onEvent(({ type, payload }) => {
  switch (type) {
    case 'status':
      setStatus(payload.state, payload.reason || '');
      if (payload.state === 'connected') {
        running = true;
        paused = false;
        ui.pause.disabled = false;
        ui.pause.textContent = 'Pause';
      } else if (payload.state === 'paused') {
        paused = true;
        ui.pause.textContent = 'Resume';
      }
      break;

    case 'capture-info':
      ui.captureInfo.textContent = payload.text || 'Local audio capture is active.';
      pushRuntimeLog('capture', payload.text || 'Local audio capture is active.');
      break;

    case 'setup-progress':
      ui.captureInfo.textContent = payload.message || 'Installing local dependencies…';
      pushRuntimeLog('setup', payload.message || 'Installing local dependencies…');
      break;

    case 'input-transcript':
      addTranscript(payload.text);
      break;

    case 'user-speaking':
      break;

    case 'trace':
      pushTrace(payload.message || 'decision event');
      break;

    case 'stale-advice':
      ui.provider.textContent = 'Provider: skipped stale advice';
      pushTrace(payload.reason || 'stale advice skipped');
      break;

    case 'output-transcript': {
      const text = String(payload.text || '').trim();
      if (!text) break;
      ui.advice.textContent = text;
      adviceHistory.push({
        time: nowIso(),
        text,
        provider: payload.provider || 'unknown',
        kind: payload.kind || 'automatic'
      });
      if (payload.provider) ui.provider.textContent = `Provider: ${payload.provider}`;
      pushRuntimeLog('advice', `${payload.provider || 'unknown'}: ${text}`);
      speakAdvice(text, payload.kind || 'automatic');
      break;
    }

    case 'provider':
      pushRuntimeLog(
        'provider',
        `${payload.provider || 'unknown'} ${payload.model || ''} ${payload.reason || ''}`.trim()
      );
      if (payload.provider === 'ollama') {
        ui.provider.textContent = `Provider: Ollama · ${payload.model || 'local model'}`;
      } else if (payload.provider) {
        ui.provider.textContent = `Provider: ${payload.provider}`;
      }
      break;

    case 'log':
      pushRuntimeLog('log', payload.message || '');
      if (!running && payload.message) ui.captureInfo.textContent = payload.message;
      break;

    case 'error':
      pushRuntimeLog('error', payload.message || 'Unknown companion error');
      setStatus('error', payload.message || 'Unknown companion error');
      break;

    default:
      break;
  }
});

window.zoomComp.onShortcutToggle(() => toggleRunning());

ui.save.addEventListener('click', () => {
  saveSettings().catch(() => {});
});

ui.export.addEventListener('click', async () => {
  try {
    const result = await window.zoomComp.exportSession({
      startedAt: sessionStartedAt,
      endedAt: nowIso(),
      transcript: sessionTranscript,
      advice: adviceHistory,
      trace: decisionTrace,
      logs: runtimeLogs
    });
    if (result?.ok) {
      pushRuntimeLog('export', `Session exported to ${result.filePath}`);
      ui.export.textContent = 'Exported';
      setTimeout(() => { ui.export.textContent = 'Export session'; }, 1400);
    }
  } catch (error) {
    setStatus('error', error.message);
  }
});

ui.start.addEventListener('click', toggleRunning);
ui.pause.addEventListener('click', () => {
  togglePause().catch((error) => setStatus('error', error.message));
});

ui.alwaysOnTop.addEventListener('change', () => {
  window.zoomComp.setAlwaysOnTop(ui.alwaysOnTop.checked);
});

ui.audioEnabled.addEventListener('change', () => {
  if (!ui.audioEnabled.checked) clearSpeech();
  else processSpeechQueue();
});

ui.compact.addEventListener('click', async () => {
  compact = !compact;
  document.body.classList.toggle('compact', compact);
  ui.compact.textContent = compact ? 'Expand' : 'Compact';
  await window.zoomComp.setCompact(compact);
});

ui.askForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = ui.askInput.value.trim();
  if (!text || !running) return;

  ui.askInput.value = '';
  const result = await window.zoomComp.ask(text);
  if (!result.ok) setStatus('error', 'The local companion is not ready yet.');
});

(async function init() {
  try {
    const settings = await window.zoomComp.getSettings();
    ui.mode.value = settings.mode;
    ui.context.value = settings.context || '';
    ui.audioEnabled.checked = settings.audioEnabled !== false;
    ui.alwaysOnTop.checked = settings.alwaysOnTop !== false;
    ui.ollamaEnabled.checked = settings.ollamaEnabled !== false;
    ui.ollamaModel.value = settings.ollamaModel || '';
    ui.whisperModel.value = settings.whisperModel || 'base';
    ui.intervalSeconds.value = String(settings.intervalSeconds || 2);
    ui.speechRate.value = String(settings.speechRate || 1.4);

    ui.apiKey.placeholder = settings.hasApiKey
      ? 'Saved securely ••••••••'
      : 'Gemini API key';
    ui.hfToken.placeholder = settings.hasHfToken
      ? 'Saved securely ••••••••'
      : 'HF token (optional)';

    if ('speechSynthesis' in window) speechSynthesis.getVoices();
    setStatus('idle');
  } catch (error) {
    setStatus('error', error.message);
  }
})();
