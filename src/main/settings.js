import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';

const DEFAULTS = {
  mode: 'sales',
  context: '',
  audioEnabled: true,
  alwaysOnTop: true,
  model: 'gemini-3.8-flash',
  autoModel: 'gemini-3.5-flash-lite',
  whisperModel: 'small',
  intervalSeconds: 4,
  ollamaEnabled: true,
  ollamaModel: '',
  speechRate: 1.4
};

function normalizeModel(value) {
  const model = typeof value === 'string' ? value.trim() : '';
  if (!model || model.includes('-live')) return DEFAULTS.model;
  return model;
}

function normalizedInterval(raw) {
  const current = Number(raw.intervalSeconds || DEFAULTS.intervalSeconds);
  if (!raw.realtimeProfileVersion) {
    if (current === 12 || current === 8) return 4;
  }
  if (Number(raw.realtimeProfileVersion || 0) < 2 && current === 8) return 4;
  return Math.max(3, Math.min(60, current));
}

function filePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(filePath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeRaw(value) {
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
}

export function getPublicSettings() {
  const raw = readRaw();
  return {
    ...DEFAULTS,
    mode: raw.mode || DEFAULTS.mode,
    context: typeof raw.context === 'string' ? raw.context : '',
    audioEnabled: raw.audioEnabled !== false,
    alwaysOnTop: raw.alwaysOnTop !== false,
    model: normalizeModel(raw.model),
    autoModel: typeof raw.autoModel === 'string' && raw.autoModel.trim()
      ? raw.autoModel.trim()
      : DEFAULTS.autoModel,
    whisperModel: raw.whisperModel || DEFAULTS.whisperModel,
    intervalSeconds: normalizedInterval(raw),
    ollamaEnabled: raw.ollamaEnabled !== false,
    ollamaModel: typeof raw.ollamaModel === 'string' ? raw.ollamaModel : '',
    speechRate: Number(raw.speechRate || DEFAULTS.speechRate),
    hasApiKey: Boolean(process.env.GEMINI_API_KEY || raw.apiKeyEncrypted),
    hasHfToken: Boolean(process.env.HF_TOKEN || raw.hfTokenEncrypted)
  };
}

export function saveSettings(next = {}) {
  const raw = readRaw();
  const merged = {
    ...raw,
    mode: ['sales', 'interview', 'general'].includes(next.mode) ? next.mode : (raw.mode || DEFAULTS.mode),
    context: typeof next.context === 'string' ? next.context.slice(0, 20000) : (raw.context || ''),
    audioEnabled: typeof next.audioEnabled === 'boolean' ? next.audioEnabled : raw.audioEnabled !== false,
    alwaysOnTop: typeof next.alwaysOnTop === 'boolean' ? next.alwaysOnTop : raw.alwaysOnTop !== false,
    model: normalizeModel(
      typeof next.model === 'string' && next.model.trim() ? next.model : raw.model
    ),
    autoModel: typeof next.autoModel === 'string' && next.autoModel.trim()
      ? next.autoModel.trim()
      : (raw.autoModel || DEFAULTS.autoModel),
    whisperModel: typeof next.whisperModel === 'string' && next.whisperModel.trim()
      ? next.whisperModel.trim()
      : (raw.whisperModel || DEFAULTS.whisperModel),
    intervalSeconds: Number.isFinite(Number(next.intervalSeconds))
      ? Math.max(3, Math.min(60, Number(next.intervalSeconds)))
      : Number(raw.intervalSeconds || DEFAULTS.intervalSeconds),
    ollamaEnabled: typeof next.ollamaEnabled === 'boolean'
      ? next.ollamaEnabled
      : raw.ollamaEnabled !== false,
    ollamaModel: typeof next.ollamaModel === 'string'
      ? next.ollamaModel.trim()
      : (raw.ollamaModel || ''),
    speechRate: Number.isFinite(Number(next.speechRate))
      ? Math.max(0.8, Math.min(2.0, Number(next.speechRate)))
      : Number(raw.speechRate || DEFAULTS.speechRate),
    realtimeProfileVersion: 2
  };

  if (typeof next.apiKey === 'string' && next.apiKey.trim()) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure OS key storage is not available on this computer. Set GEMINI_API_KEY in the environment instead.');
    }
    merged.apiKeyEncrypted = safeStorage.encryptString(next.apiKey.trim()).toString('base64');
  }

  if (typeof next.hfToken === 'string' && next.hfToken.trim()) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure OS key storage is not available on this computer. Set HF_TOKEN in the environment instead.');
    }
    merged.hfTokenEncrypted = safeStorage.encryptString(next.hfToken.trim()).toString('base64');
  }

  writeRaw(merged);
  return getPublicSettings();
}

export function getApiKey() {
  if (process.env.GEMINI_API_KEY?.trim()) return process.env.GEMINI_API_KEY.trim();
  const raw = readRaw();
  if (!raw.apiKeyEncrypted) return '';
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure OS key storage is unavailable, so the saved Gemini key cannot be decrypted.');
  }
  return safeStorage.decryptString(Buffer.from(raw.apiKeyEncrypted, 'base64'));
}


export function getHfToken() {
  if (process.env.HF_TOKEN?.trim()) return process.env.HF_TOKEN.trim();
  const raw = readRaw();
  if (!raw.hfTokenEncrypted) return '';
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure OS key storage is unavailable, so the saved Hugging Face token cannot be decrypted.');
  }
  return safeStorage.decryptString(Buffer.from(raw.hfTokenEncrypted, 'base64'));
}
