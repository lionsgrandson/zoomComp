import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';

const DEFAULTS = {
  mode: 'sales',
  context: '',
  audioEnabled: true,
  alwaysOnTop: true,
  model: 'gemini-3.8-live'
};

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
    model: raw.model || DEFAULTS.model,
    hasApiKey: Boolean(process.env.GEMINI_API_KEY || raw.apiKeyEncrypted)
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
    model: typeof next.model === 'string' && next.model.trim() ? next.model.trim() : (raw.model || DEFAULTS.model)
  };

  if (typeof next.apiKey === 'string' && next.apiKey.trim()) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure OS key storage is not available on this computer. Set GEMINI_API_KEY in the environment instead.');
    }
    merged.apiKeyEncrypted = safeStorage.encryptString(next.apiKey.trim()).toString('base64');
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
