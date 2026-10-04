import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, globalShortcut, ipcMain } from 'electron';
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
      whisperModel: settings.whisperModel,
      intervalSeconds: settings.intervalSeconds,
      ollamaEnabled: settings.ollamaEnabled,
      ollamaModel: settings.ollamaModel,
      systemPrompt: buildSystemPrompt(settings.mode, settings.context)
    });
    return { ok: true };
  });


  ipcMain.handle('companion:ask', (_event, text) => ({ ok: Boolean(coach?.sendText(text)) }));
  ipcMain.handle('companion:stop', () => {
    coach?.stop();
    coach = null;
    return { ok: true };
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
