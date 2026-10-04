const $ = (id) => document.getElementById(id);

const ui = {
  mode: $('mode'),
  apiKey: $('apiKey'),
  context: $('context'),
  audioEnabled: $('audioEnabled'),
  alwaysOnTop: $('alwaysOnTop'),
  consent: $('consent'),
  save: $('saveSettings'),
  start: $('startStop'),
  status: $('status'),
  statusDot: $('statusDot'),
  advice: $('advice'),
  transcript: $('transcript'),
  askForm: $('askForm'),
  askInput: $('askInput'),
  compact: $('compact'),
  captureInfo: $('captureInfo')
};

let running = false;
let audioContext = null;
let workletNode = null;
let silentGain = null;
let micGain = null;
let systemGain = null;
let micStream = null;
let displayStream = null;
let playbackContext = null;
let nextPlaybackTime = 0;
let activePlaybackNodes = 0;
let playbackSources = new Set();
let outputText = '';
let transcriptLines = [];
let compact = false;
let speakingRestoreTimer = null;

const VAD_PRE_ROLL_CHUNKS = 6; // 240 ms
const VAD_SILENCE_END_CHUNKS = 15; // 600 ms
const VAD_MIN_SPEECH_RMS = 0.006;
let vadPreRoll = [];
let speechActive = false;
let quietChunkCount = 0;
let noiseFloor = 0.0015;

function resetVadState() {
  vadPreRoll = [];
  speechActive = false;
  quietChunkCount = 0;
  noiseFloor = 0.0015;
}

function handleCapturedAudio(packet) {
  const audio = packet?.audio;
  const rms = Number(packet?.rms);

  if (!running || !(audio instanceof ArrayBuffer)) return;

  const level = Number.isFinite(rms) ? rms : 1;
  const startThreshold = Math.max(VAD_MIN_SPEECH_RMS, noiseFloor * 3);
  const continueThreshold = Math.max(VAD_MIN_SPEECH_RMS * 0.65, noiseFloor * 1.8);

  if (!speechActive) {
    noiseFloor = Math.max(
      0.0005,
      Math.min(0.03, (noiseFloor * 0.97) + (Math.min(level, 0.03) * 0.03))
    );

    vadPreRoll.push(audio);
    if (vadPreRoll.length > VAD_PRE_ROLL_CHUNKS) vadPreRoll.shift();

    if (level >= startThreshold) {
      speechActive = true;
      quietChunkCount = 0;
      for (const chunk of vadPreRoll) window.zoomComp.sendAudio(chunk);
      vadPreRoll = [];
    }
    return;
  }

  window.zoomComp.sendAudio(audio);

  if (level < continueThreshold) {
    quietChunkCount += 1;
  } else {
    quietChunkCount = 0;
  }

  if (quietChunkCount >= VAD_SILENCE_END_CHUNKS) {
    speechActive = false;
    quietChunkCount = 0;
    vadPreRoll = [];
    window.zoomComp.endAudioStream();
  }
}

function setStatus(state, detail = '') {
  const labels = {
    idle: 'Ready',
    connecting: 'Connecting to Gemini…',
    connected: 'Listening',
    reconnecting: 'Reconnecting…',
    stopped: 'Stopped',
    error: 'Error'
  };
  ui.status.textContent = detail ? `${labels[state] || state}: ${detail}` : (labels[state] || state);
  ui.statusDot.dataset.state = state;
}

function addTranscript(text) {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return;
  transcriptLines.push(cleaned);
  if (transcriptLines.length > 12) transcriptLines = transcriptLines.slice(-12);
  ui.transcript.textContent = transcriptLines.join(' ');
  ui.transcript.scrollTop = ui.transcript.scrollHeight;
}

function setSystemAudioSuppressed(suppressed) {
  if (!systemGain) return;
  const now = audioContext?.currentTime || 0;
  systemGain.gain.cancelScheduledValues(now);
  systemGain.gain.setTargetAtTime(suppressed ? 0 : 0.9, now, 0.015);
  ui.captureInfo.textContent = suppressed
    ? 'Listening to mic; system audio temporarily suppressed while the coach speaks.'
    : 'Listening to microphone + Windows system audio. Quota saver sends speech only.';
}

function clearPlayback() {
  for (const source of playbackSources) {
    try { source.stop(); } catch {}
  }
  playbackSources.clear();
  nextPlaybackTime = 0;
  activePlaybackNodes = 0;
  clearTimeout(speakingRestoreTimer);
  setSystemAudioSuppressed(false);
}

function decodePcm16(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }
  return samples;
}

async function playGeminiAudio(data) {
  if (!ui.audioEnabled.checked || !running) return;
  if (!playbackContext || playbackContext.state === 'closed') {
    playbackContext = new AudioContext({ sampleRate: 24000, latencyHint: 'interactive' });
  }
  if (playbackContext.state === 'suspended') await playbackContext.resume();

  clearTimeout(speakingRestoreTimer);
  setSystemAudioSuppressed(true);

  const samples = decodePcm16(data);
  const buffer = playbackContext.createBuffer(1, samples.length, 24000);
  buffer.getChannelData(0).set(samples);
  const source = playbackContext.createBufferSource();
  source.buffer = buffer;
  source.connect(playbackContext.destination);

  const startAt = Math.max(playbackContext.currentTime + 0.025, nextPlaybackTime || 0);
  nextPlaybackTime = startAt + buffer.duration;
  activePlaybackNodes += 1;
  playbackSources.add(source);
  source.onended = () => {
    playbackSources.delete(source);
    activePlaybackNodes = Math.max(0, activePlaybackNodes - 1);
    if (activePlaybackNodes === 0) {
      speakingRestoreTimer = setTimeout(() => setSystemAudioSuppressed(false), 220);
      nextPlaybackTime = 0;
    }
  };
  source.start(startAt);
}

async function createCapture() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1
    },
    video: false
  });

  let displayError = null;
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  } catch (error) {
    displayError = error;
  }

  audioContext = new AudioContext({ latencyHint: 'interactive' });
  await audioContext.audioWorklet.addModule('./audio-worklet.js');
  await audioContext.resume();

  workletNode = new AudioWorkletNode(audioContext, 'meeting-pcm-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1]
  });
  resetVadState();
  workletNode.port.onmessage = (event) => {
    handleCapturedAudio(event.data);
  };

  silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  workletNode.connect(silentGain).connect(audioContext.destination);

  const micSource = audioContext.createMediaStreamSource(micStream);
  micGain = audioContext.createGain();
  micGain.gain.value = 1;
  micSource.connect(micGain).connect(workletNode);

  const systemAudioTracks = displayStream?.getAudioTracks() || [];
  if (systemAudioTracks.length) {
    const audioOnly = new MediaStream(systemAudioTracks);
    const systemSource = audioContext.createMediaStreamSource(audioOnly);
    systemGain = audioContext.createGain();
    systemGain.gain.value = 0.9;
    systemSource.connect(systemGain).connect(workletNode);
    for (const track of displayStream.getVideoTracks()) track.enabled = false;
    ui.captureInfo.textContent = 'Listening to microphone + Windows system audio. Quota saver sends speech only.';
  } else {
    ui.captureInfo.textContent = displayError
      ? `Microphone only. System audio capture failed: ${displayError.message}`
      : 'Microphone only. Windows system audio was not available.';
  }
}

async function stopCapture() {
  for (const track of micStream?.getTracks() || []) track.stop();
  for (const track of displayStream?.getTracks() || []) track.stop();
  micStream = null;
  displayStream = null;
  systemGain = null;
  micGain = null;
  try { workletNode?.disconnect(); } catch {}
  workletNode = null;
  try { await audioContext?.close(); } catch {}
  audioContext = null;
  clearPlayback();
  try { await playbackContext?.close(); } catch {}
  playbackContext = null;
  resetVadState();
  ui.captureInfo.textContent = 'Audio capture is off.';
}

async function saveSettings() {
  ui.save.disabled = true;
  try {
    const settings = await window.zoomComp.saveSettings({
      apiKey: ui.apiKey.value,
      mode: ui.mode.value,
      context: ui.context.value,
      audioEnabled: ui.audioEnabled.checked,
      alwaysOnTop: ui.alwaysOnTop.checked
    });
    ui.apiKey.value = '';
    ui.apiKey.placeholder = settings.hasApiKey ? 'Saved securely ••••••••' : 'Gemini API key';
    ui.save.textContent = 'Saved';
    setTimeout(() => { ui.save.textContent = 'Save settings'; }, 1200);
  } catch (error) {
    setStatus('error', error.message);
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
  setStatus('connecting');
  try {
    await saveSettings();
    await window.zoomComp.start();
    running = true;
    await createCapture();
    ui.start.textContent = 'Stop companion';
    ui.start.classList.add('danger');
    setStatus('connected');
  } catch (error) {
    running = false;
    await stopCapture();
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
    await stopCapture();
    await window.zoomComp.stop();
    setStatus('stopped');
  } finally {
    ui.start.textContent = 'Start companion';
    ui.start.classList.remove('danger');
    ui.start.disabled = false;
  }
}

async function toggleRunning() {
  if (running) await stop(); else await start();
}

window.zoomComp.onEvent(({ type, payload }) => {
  switch (type) {
    case 'status':
      if (payload.state !== 'stopped' || !running) setStatus(payload.state, payload.reason || '');
      break;
    case 'input-transcript':
      addTranscript(payload.text);
      break;
    case 'output-transcript':
      outputText += payload.text;
      ui.advice.textContent = outputText.trim();
      break;
    case 'audio':
      playGeminiAudio(payload.data).catch((error) => setStatus('error', error.message));
      break;
    case 'generation-complete':
      outputText = '';
      break;
    case 'interrupted':
      clearPlayback();
      break;
    case 'error':
      setStatus('error', payload.message);
      break;
  }
});

window.zoomComp.onShortcutToggle(() => toggleRunning());

ui.save.addEventListener('click', saveSettings);
ui.start.addEventListener('click', toggleRunning);
ui.alwaysOnTop.addEventListener('change', () => window.zoomComp.setAlwaysOnTop(ui.alwaysOnTop.checked));
ui.audioEnabled.addEventListener('change', () => { if (!ui.audioEnabled.checked) clearPlayback(); });
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
  if (!result.ok) setStatus('error', 'The Gemini session is not connected yet.');
});

(async function init() {
  try {
    const settings = await window.zoomComp.getSettings();
    ui.mode.value = settings.mode;
    ui.context.value = settings.context || '';
    ui.audioEnabled.checked = settings.audioEnabled !== false;
    ui.alwaysOnTop.checked = settings.alwaysOnTop !== false;
    ui.apiKey.placeholder = settings.hasApiKey ? 'Saved securely ••••••••' : 'Gemini API key';
    setStatus('idle');
  } catch (error) {
    setStatus('error', error.message);
  }
})();
