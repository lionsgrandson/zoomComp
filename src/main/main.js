import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, globalShortcut, ipcMain } from 'electron';
import { LocalCoach } from './local-coach.js';
import { buildSystemPrompt } from './prompts.js';
import { getApiKey, getHfToken, getPublicSettings, saveSettings } from './settings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let mainWindow = null;
let coach = null;

function emitToRenderer(type, payload = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('companion:event', { type, payload });
  }
}


function safeLine(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').trim();
}

function buildSessionMarkdown(payload = {}) {
  const startedAt = safeLine(payload.startedAt || '');
  const endedAt = safeLine(payload.endedAt || '');
  const transcript = Array.isArray(payload.transcript) ? payload.transcript : [];
  const advice = Array.isArray(payload.advice) ? payload.advice : [];
  const trace = Array.isArray(payload.trace) ? payload.trace : [];
  const logs = Array.isArray(payload.logs) ? payload.logs : [];

  const section = (title, rows, formatter) => {
    const body = rows.length ? rows.map(formatter).join('\n') : '_None_';
    return `## ${title}\n\n${body}\n`;
  };

  return [
    '# Zoom Companion Session',
    '',
    startedAt ? `Started: ${startedAt}` : '',
    endedAt ? `Ended: ${endedAt}` : '',
    '',
    section('Transcript', transcript, (row) =>
      `- ${safeLine(row.time)} ${safeLine(row.text)}`
    ),
    section('Coaching Suggestions', advice, (row) =>
      `- ${safeLine(row.time)} [${safeLine(row.provider || 'unknown')}] ${safeLine(row.text)}`
    ),
    section('Decision Trace', trace, (row) =>
      `- ${safeLine(row.time)} ${safeLine(row.message)}`
    ),
    section('Runtime Logs', logs, (row) =>
      `- ${safeLine(row.time)} [${safeLine(row.type || 'log')}] ${safeLine(row.message)}`
    )
  ].filter(Boolean).join('\n');
}

function createWindow() {
  const settings = getPublicSettings();
  mainWindow = new BrowserWindow({
    width: 460,
    height: 760,
    minWidth: 360,
    minHeight: 520,
    show: false,
    title: 'Zoom Companion',
    backgroundColor: '#0b1020',
    alwaysOnTop: settings.alwaysOnTop,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    coach?.stop();
    coach = null;
    mainWindow = null;
  });
}

function registerIpc() {
  ipcMain.handle('settings:get', () => getPublicSettings());
  ipcMain.handle('settings:save', (_event, value) => {
    const settings = saveSettings(value || {});
    mainWindow?.setAlwaysOnTop(settings.alwaysOnTop);
    return settings;
  });

  ipcMain.handle('companion:start', async () => {
    const settings = getPublicSettings();
    const apiKey = getApiKey();
    if (!apiKey) throw new Error('Add a Gemini API key first.');

    coach?.stop();
    coach = new LocalCoach(emitToRenderer);
    await coach.connect({
      apiKey,
      hfToken: getHfToken(),
      model: settings.model,
      autoModel: settings.autoModel,
      whisperModel: settings.whisperModel,
      intervalSeconds: settings.intervalSeconds,
      ollamaEnabled: settings.ollamaEnabled,
      ollamaModel: settings.ollamaModel,
      systemPrompt: buildSystemPrompt(settings.mode, settings.context)
    });
    return { ok: true };
  });


  ipcMain.handle('companion:ask', (_event, text) => ({ ok: Boolean(coach?.sendText(text)) }));
  ipcMain.handle('companion:pause', (_event, paused) => ({
    ok: Boolean(coach?.setPaused(Boolean(paused)))
  }));
  ipcMain.handle('companion:output-speaking', (_event, speaking) => ({
    ok: Boolean(coach?.setOutputSpeaking(Boolean(speaking)))
  }));
  ipcMain.handle('companion:stop', () => {
    coach?.stop();
    coach = null;
    return { ok: true };
  });

  ipcMain.handle('session:export', async (_event, payload) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Zoom Companion session',
      defaultPath: path.join(app.getPath('documents'), `zoom-companion-${stamp}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    await fs.writeFile(result.filePath, buildSessionMarkdown(payload), 'utf8');
    return { ok: true, filePath: result.filePath };
  });

  ipcMain.handle('window:always-on-top', (_event, enabled) => {
    mainWindow?.setAlwaysOnTop(Boolean(enabled));
    return { ok: true };
  });

  ipcMain.handle('window:compact', (_event, compact) => {
    if (!mainWindow) return { ok: false };
    if (compact) {
      mainWindow.setMinimumSize(340, 190);
      mainWindow.setSize(390, 220, true);
    } else {
      mainWindow.setMinimumSize(360, 520);
      mainWindow.setSize(460, 760, true);
    }
    return { ok: true };
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    mainWindow?.webContents.send('companion:shortcut-toggle');
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  coach?.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
