import { GoogleGenAI, Modality } from '@google/genai';
import { buildSystemPrompt } from './prompts.js';

const RECONNECT_DELAYS = [1000, 2500, 5000, 10000, 20000, 30000];
const MAX_RECONNECT_ATTEMPTS = RECONNECT_DELAYS.length;

function isQuotaError(value) {
  const text = [
    value?.message,
    value?.reason,
    value?.error?.message,
    value?.code,
    value?.error?.code
  ].filter(Boolean).join(' ').toLowerCase();

  return (
    text.includes('quota') ||
    text.includes('resource_exhausted') ||
    text.includes('resource has been exhausted') ||
    text.includes('too many requests') ||
    text.includes('rate limit') ||
    text.includes('billing') ||
    text.includes('429')
  );
}

export class GeminiCoach {
  constructor(emit) {
    this.emit = emit;
    this.session = null;
    this.ai = null;
    this.options = null;
    this.resumeHandle = undefined;
    this.manualStop = false;
    this.connecting = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
  }

  async connect(options) {
    this.options = { ...options };
    this.manualStop = false;
    this.reconnectAttempt = 0;
    await this.#open();
  }

  async #open() {
    if (this.connecting || this.manualStop) return;
    this.connecting = true;
    this.emit('status', { state: this.resumeHandle ? 'reconnecting' : 'connecting' });

    try {
      this.ai = new GoogleGenAI({
        apiKey: this.options.apiKey,
        httpOptions: { apiVersion: 'v1beta' }
      });

      const config = {
        responseModalities: [Modality.AUDIO],
        systemInstruction: buildSystemPrompt(this.options.mode, this.options.context),
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        contextWindowCompression: { slidingWindow: {} },
        sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
        tools: [{ googleSearch: {} }],
        temperature: 0.25
      };

      this.session = await this.ai.live.connect({
        model: this.options.model || 'gemini-3.8-live',
        config,
        callbacks: {
          onopen: () => {
            this.reconnectAttempt = 0;
            this.emit('status', { state: 'connected' });
          },
          onmessage: (message) => this.#onMessage(message),
          onerror: (event) => {
            const message = event?.message || event?.error?.message || 'Gemini Live connection error';
            if (isQuotaError(event)) {
              this.manualStop = true;
              clearTimeout(this.reconnectTimer);
              this.reconnectTimer = null;
              this.emit('error', {
                message: `${message}. Automatic reconnect stopped to avoid consuming more quota.`
              });
              return;
            }
            this.emit('error', { message });
          },
          onclose: (event) => {
            this.session = null;
            if (isQuotaError(event)) {
              this.manualStop = true;
              clearTimeout(this.reconnectTimer);
              this.reconnectTimer = null;
              this.emit('error', {
                message: `${event?.reason || 'Gemini quota exceeded'}. Automatic reconnect stopped to avoid consuming more quota.`
              });
              return;
            }
            if (!this.manualStop) {
              this.emit('status', { state: 'reconnecting', reason: event?.reason || 'connection closed' });
              this.#scheduleReconnect();
            }
          }
        }
      });
    } catch (error) {
      this.session = null;
      const message = error?.message || String(error);
      if (isQuotaError(error)) {
        this.manualStop = true;
        this.emit('error', {
          message: `${message}. Automatic reconnect stopped to avoid consuming more quota.`
        });
      } else {
        this.emit('error', { message });
        if (!this.manualStop) this.#scheduleReconnect();
      }
      throw error;
    } finally {
      this.connecting = false;
    }
  }

  #scheduleReconnect() {
    if (this.manualStop || this.reconnectTimer) return;
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      this.manualStop = true;
      this.emit('error', {
        message: 'Gemini could not reconnect after several attempts. Automatic reconnect stopped.'
      });
      return;
    }
    const delay = RECONNECT_DELAYS[this.reconnectAttempt];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.#open();
      } catch {
        // #open schedules the next attempt.
      }
    }, delay);
  }

  #onMessage(message) {
    const resumption = message?.sessionResumptionUpdate;
    if (resumption?.resumable && resumption?.newHandle) {
      this.resumeHandle = resumption.newHandle;
    }

    if (message?.goAway) {
      this.emit('status', { state: 'reconnecting', reason: 'Gemini is rotating the live connection' });
    }

    const content = message?.serverContent;
    if (!content) return;

    if (content.interrupted) {
      this.emit('interrupted', {});
    }

    if (content.inputTranscription?.text) {
      this.emit('input-transcript', { text: content.inputTranscription.text });
    }

    if (content.outputTranscription?.text) {
      this.emit('output-transcript', { text: content.outputTranscription.text });
    }

    for (const part of content.modelTurn?.parts || []) {
      const inline = part.inlineData;
      if (inline?.data && inline?.mimeType?.startsWith('audio/')) {
        this.emit('audio', { data: inline.data, mimeType: inline.mimeType });
      }
    }

    if (content.generationComplete || content.turnComplete) {
      this.emit('generation-complete', {});
    }
  }

  sendAudio(arrayBuffer) {
    if (!this.session || this.manualStop) return false;
    try {
      const bytes = Buffer.from(new Uint8Array(arrayBuffer));
      this.session.sendRealtimeInput({
        audio: {
          data: bytes.toString('base64'),
          mimeType: 'audio/pcm;rate=16000'
        }
      });
      return true;
    } catch (error) {
      this.emit('error', { message: error?.message || String(error) });
      return false;
    }
  }

  endAudioStream() {
    if (!this.session || this.manualStop) return false;
    try {
      this.session.sendRealtimeInput({ audioStreamEnd: true });
      return true;
    } catch (error) {
      this.emit('error', { message: error?.message || String(error) });
      return false;
    }
  }

  sendText(text) {
    if (!this.session || !text?.trim()) return false;
    try {
      this.session.sendClientContent({
        turns: [{
          role: 'user',
          parts: [{ text: `Private question from the user during the meeting: ${text.trim()}\nAnswer the user concisely and directly.` }]
        }],
        turnComplete: true
      });
      return true;
    } catch (error) {
      this.emit('error', { message: error?.message || String(error) });
      return false;
    }
  }

  stop() {
    this.manualStop = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.session?.sendRealtimeInput({ audioStreamEnd: true });
    } catch {}
    try {
      this.session?.close();
    } catch {}
    this.session = null;
    this.resumeHandle = undefined;
    this.emit('status', { state: 'stopped' });
  }
}
