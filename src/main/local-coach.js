import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { app } from 'electron';

function findPython() {
  const local = path.join(app.getAppPath(), '.venv', 'Scripts', 'python.exe');
  const candidates = fs.existsSync(local)
    ? [[local, []], ['python', []], ['py', ['-3']]]
    : [['python', []], ['py', ['-3']]];

  for (const [command, prefix] of candidates) {
    const result = spawnSync(command, [...prefix, '-c', 'import sys'], {
      windowsHide: true,
      stdio: 'ignore'
    });
    if (result.status === 0) return { command, prefix };
  }
  return null;
}

export class LocalCoach {
  constructor(emit) {
    this.emit = emit;
    this.child = null;
    this.buffer = '';
    this.connected = false;
  }

  async connect(options) {
    const python = findPython();
    if (!python) throw new Error('Python 3 was not found. Run setup-python.cmd first.');

    const script = path.join(app.getAppPath(), 'python', 'companion.py');
    if (!fs.existsSync(script)) throw new Error('python/companion.py is missing.');

    this.child = spawn(python.command, [...python.prefix, script], {
      cwd: app.getAppPath(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HF_TOKEN: options.hfToken || process.env.HF_TOKEN || ''
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
      const timeout = setTimeout(() => reject(new Error('Local transcription did not start in time.')), 120000);
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
        }
      });
    });

    this.#send({
      type: 'start',
      apiKey: options.apiKey,
      model: options.model,
      whisperModel: options.whisperModel,
      intervalSeconds: options.intervalSeconds,
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
