import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { app } from 'electron';

function systemPython() {
  const candidates = [['python', []], ['py', ['-3']]];
  for (const [command, prefix] of candidates) {
    const result = spawnSync(command, [...prefix, '-c', 'import sys'], {
      windowsHide: true,
      stdio: 'ignore'
    });
    if (result.status === 0) return { command, prefix };
  }
  return null;
}

function resourcePath(...parts) {
  return app.isPackaged
    ? path.join(process.resourcesPath, ...parts)
    : path.join(app.getAppPath(), ...parts);
}

function run(command, args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const handle = (chunk) => {
      const line = String(chunk || '').trim();
      if (line) onLine?.(line);
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Process exited with code ${code}.`));
    });
  });
}

export class LocalCoach {
  constructor(emit) {
    this.emit = emit;
    this.child = null;
    this.buffer = '';
    this.connected = false;
  }

  async #ensurePythonEnvironment() {
    const basePython = systemPython();
    if (!basePython) {
      throw new Error('Python 3.11+ was not found. Install Python, then start Zoom Companion again.');
    }

    const envDir = path.join(app.getPath('userData'), 'python-env');
    const envPython = path.join(envDir, 'Scripts', 'python.exe');
    const requirements = resourcePath('requirements-python.txt');

    if (!fs.existsSync(envPython)) {
      this.emit('status', { state: 'connecting', reason: 'Creating local Python environment…' });
      await run(basePython.command, [...basePython.prefix, '-m', 'venv', envDir]);
    }

    const importCheck = spawnSync(
      envPython,
      ['-c', 'import numpy, pyaudiowpatch, faster_whisper; from google import genai'],
      { windowsHide: true, stdio: 'ignore' }
    );

    if (importCheck.status !== 0) {
      this.emit('status', { state: 'connecting', reason: 'Installing local transcription dependencies…' });
      await run(
        envPython,
        ['-m', 'pip', 'install', '-r', requirements],
        (line) => this.emit('setup-progress', { message: line })
      );
    }

    return envPython;
  }

  async connect(options) {
    const python = await this.#ensurePythonEnvironment();
    const script = resourcePath('python', 'companion.py');
    if (!fs.existsSync(script)) throw new Error('python/companion.py is missing.');

    this.child = spawn(python, [script], {
      cwd: app.getPath('userData'),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HF_TOKEN: options.hfToken || process.env.HF_TOKEN || '',
        PYTHONUTF8: '1'
      }
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.#onStdout(chunk));
    this.child.stderr.on('data', (chunk) => {
      const message = String(chunk || '').trim();
      if (message) this.emit('log', { message });
    });

    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Local transcription did not start in time.')), 600000);
      const onReady = (payload) => {
        if (payload?.state !== 'connected') return;
        clearTimeout(timeout);
        this._readyHandler = null;
        resolve({ ok: true });
      };
      this._readyHandler = onReady;

      this.child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      this.child.once('exit', (code) => {
        if (!this.connected) {
          clearTimeout(timeout);
          reject(new Error(`Local transcription exited with code ${code ?? 'unknown'}.`));
          return;
        }
        this.connected = false;
        if (code && code !== 0) {
          this.emit('error', { message: `Local transcription stopped unexpectedly with code ${code}.` });
        } else {
          this.emit('status', { state: 'stopped', reason: 'Local transcription ended.' });
        }
      });
    });

    this.#send({
      type: 'start',
      apiKey: options.apiKey,
      model: options.model,
      autoModel: options.autoModel || 'gemini-3.5-flash-lite',
      whisperModel: options.whisperModel || 'base',
      intervalSeconds: options.intervalSeconds || 2,
      systemPrompt: options.systemPrompt,
      ollamaEnabled: options.ollamaEnabled,
      ollamaModel: options.ollamaModel
    });

    return ready;
  }

  #onStdout(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event?.type === 'status' && event?.payload?.state === 'connected') {
          this.connected = true;
          this._readyHandler?.(event.payload);
        }
        this.emit(event?.type || 'log', event?.payload || {});
      } catch {
        this.emit('log', { message: line });
      }
    }
  }

  #send(message) {
    if (!this.child?.stdin || this.child.stdin.destroyed) return false;
    this.child.stdin.write(JSON.stringify(message) + '\n');
    return true;
  }

  sendText(text) {
    return this.#send({ type: 'ask', text });
  }

  setPaused(paused) {
    return this.#send({ type: paused ? 'pause' : 'resume' });
  }

  setOutputSpeaking(speaking) {
    return this.#send({ type: 'output-speaking', speaking: Boolean(speaking) });
  }

  stop() {
    const child = this.child;
    this.connected = false;
    if (!child) return;
    this.#send({ type: 'stop' });
    setTimeout(() => {
      if (this.child === child) {
        try { child.kill(); } catch {}
      }
    }, 1500);
    this.child = null;
  }
}
