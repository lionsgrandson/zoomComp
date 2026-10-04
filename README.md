# Zoom Companion

Windows-first desktop meeting copilot powered by Gemini Live. It listens to your microphone and Windows system audio, keeps a low-latency Gemini session open, and gives private spoken + on-screen coaching for sales calls, interviews, or general meetings.

## What it does

- Captures microphone + Windows system audio, so it can work with Zoom, Google Meet, Microsoft Teams, browser calls, and most other meeting software.
- Streams 16 kHz PCM audio to `gemini-3.8-live`.
- Uses a strict coaching prompt so the model stays quiet unless an intervention is useful.
- Uses Gemini Google Search grounding when current/external information is needed, such as a product or competitor mentioned in the call.
- Shows input transcription and Gemini's spoken response transcript.
- Includes a local quota saver that buffers the start of speech, skips silence, and signals speech-end boundaries so silent meeting time is not continuously streamed to Gemini Live.
- Plays Gemini's native audio response through your selected Windows output device/headphones.
- Temporarily removes captured system audio from the Gemini input while Gemini is speaking to reduce self-feedback.
- Supports Sales, Interview, and General modes plus editable factual context about you/business/pricing.
- Supports private typed questions during the meeting.
- Uses context-window compression and Gemini session resumption for long-running meetings.
- Stores the Gemini API key locally using Electron `safeStorage`. The renderer never receives the key.
- Does not save meeting audio or transcripts to disk.

## Requirements

- Windows 10/11 x64 is the primary target.
- Node.js 22+ for development.
- A Gemini API key with access to the Gemini Live API.
- Headphones are strongly recommended. System-loopback capture is automatically suppressed while the companion is speaking, but headphones provide the cleanest separation.
- Permission/consent to process the meeting audio. Recording/AI-assistant rules vary by jurisdiction and organization.

## Run locally

```bash
npm install
npm start
```

On first launch:

1. Paste your Gemini API key.
2. Choose Sales, Interview, or General mode.
3. Add factual context you want Gemini to know, such as your actual rates, stack, products, or interview background.
4. Save settings.
5. Confirm that you have permission to process the meeting audio.
6. Click **Start companion**.

You can also set `GEMINI_API_KEY` in the environment instead of storing a key in the app.

## Build a Windows installer

```bash
npm install
npm run dist
```

The NSIS installer is created under `dist/` by electron-builder.

## Controls

- **Ctrl + Shift + Space**: start/stop from the keyboard.
- **Compact**: turns the window into a small always-on-top coaching panel.
- **Play coaching in my headphones**: disable this for text-only coaching.
- **Ask privately**: sends a direct text question to the active Gemini session without saying it into the meeting.

## Architecture

- `src/main/main.js`: Electron lifecycle, secure IPC, media permissions, Windows loopback capture grant.
- `src/main/gemini.js`: Gemini Live connection, proactive audio, Search grounding, transcription, compression, resumption/reconnect.
- `src/main/settings.js`: local settings and OS-encrypted API key storage.
- `src/main/prompts.js`: mode-specific coaching behavior.
- `src/preload.cjs`: narrow context-bridge API; no Node access in the renderer.
- `src/renderer/audio-worklet.js`: converts/resamples the mixed meeting audio to 16 kHz PCM in 40 ms chunks.
- `src/renderer/app.js`: capture graph, playback queue, feedback suppression, UI state.

## Security/privacy notes

The Electron renderer runs with `contextIsolation`, `sandbox`, and `nodeIntegration: false`. The Gemini key stays in the main process and is encrypted at rest through the operating system when supported. Meeting audio is streamed to Gemini because that is necessary for live processing; review Google's Gemini API data terms for your account and intended use before using this with confidential meetings.

## Known platform boundary

The capture path is deliberately Windows-first because Electron supports `audio: 'loopback'` system-audio capture on Windows. The application can be extended for modern macOS system audio, but this initial version is not packaged or validated for macOS/Linux.
