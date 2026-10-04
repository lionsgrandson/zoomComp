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
  consent: $('consent'),
  save: $('saveSettings'),
  start: $('startStop'),
  status: $('status'),
  statusDot: $('statusDot'),
  advice: $('advice'),
  provider: $('provider'),
  transcript: $('transcript'),
  askForm: $('askForm'),
  askInput: $('askInput'),
  compact: $('compact'),
  captureInfo: $('captureInfo')
};

let running = false;
let compact = false;
let transcriptLines = [];

function setStatus(state, detail = '') {
  const labels = {
    idle: 'Ready',
    connecting: 'Starting local companion…',
    connected: 'Listening locally',
    reconnecting: 'Reconnecting…',
    stopped: 'Stopped',
    error: 'Error'
  };
  ui.status.textContent = detail
    ? `${labels[state] || state}: ${detail}`
    : (labels[state] || state);
  ui.statusDot.dataset.state = state;
}

function addTranscript(text) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return;
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

function speakAdvice(text) {
  if (!ui.audioEnabled.checked || !text?.trim() || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text.trim());
  const voice = preferredVoice(text);
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  }
  utterance.rate = 1.05;
  speechSynthesis.speak(utterance);
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
  setStatus('connecting', 'Saving settings…');
  ui.provider.textContent = 'Provider: starting';
  ui.captureInfo.textContent = 'Preparing local transcription…';

  try {
    await saveSettings();
    await window.zoomComp.start();
    running = true;
    ui.start.textContent = 'Stop companion';
    ui.start.classList.add('danger');
    setStatus('connected');
  } catch (error) {
    running = false;
    try { await window.zoomComp.stop(); } catch {}
    setStatus('error', error.message);
  } finally {
    ui.start.disabled = false;
  }
}

async function stop() {
  ui.start.disabled = true;
  running = false;
  try {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
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

window.zoomComp.onEvent(({ type, payload }) => {
  switch (type) {
    case 'status':
      setStatus(payload.state, payload.reason || '');
      if (payload.state === 'connected') running = true;
      break;

    case 'capture-info':
      ui.captureInfo.textContent = payload.text || 'Local audio capture is active.';
      break;

    case 'setup-progress':
      ui.captureInfo.textContent = payload.message || 'Installing local dependencies…';
      break;

    case 'input-transcript':
      addTranscript(payload.text);
      break;

    case 'output-transcript': {
      const text = String(payload.text || '').trim();
      if (!text) break;
      ui.advice.textContent = text;
      if (payload.provider) ui.provider.textContent = `Provider: ${payload.provider}`;
      speakAdvice(text);
      break;
    }

    case 'provider':
      if (payload.provider === 'ollama') {
        ui.provider.textContent = `Provider: Ollama · ${payload.model || 'local model'}`;
      } else if (payload.provider) {
        ui.provider.textContent = `Provider: ${payload.provider}`;
      }
      break;

    case 'log':
      if (!running && payload.message) ui.captureInfo.textContent = payload.message;
      break;

    case 'error':
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

ui.start.addEventListener('click', toggleRunning);

ui.alwaysOnTop.addEventListener('change', () => {
  window.zoomComp.setAlwaysOnTop(ui.alwaysOnTop.checked);
});

ui.audioEnabled.addEventListener('change', () => {
  if (!ui.audioEnabled.checked && 'speechSynthesis' in window) speechSynthesis.cancel();
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
    ui.whisperModel.value = settings.whisperModel || 'small';
    ui.intervalSeconds.value = String(settings.intervalSeconds || 12);

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
