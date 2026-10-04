# Zoom Companion

Zoom Companion now has two operating modes:

1. **Recommended: local transcription mode**. Windows microphone + system audio are transcribed locally with faster-whisper. Only rolling transcript text is sent to Gemini periodically for coaching.
2. **Legacy: Gemini Live Electron mode**. The original Electron app streams audio to Gemini Live.

The local mode is the preferred path because it uses dramatically less Gemini quota and keeps raw meeting audio on the PC.

## Recommended local mode

### What it does

- Captures the default Windows microphone.
- Captures the default Windows speaker/headphone output through WASAPI loopback.
- Transcribes both locally with faster-whisper.
- Tags transcript as `[YOU]` and `[MEETING]`.
- Sends only a rolling text window to Gemini when new transcript exists.
- Checks for useful coaching roughly every 12 seconds by default.
- Uses normal Gemini text generation with Google Search grounding when the model needs current external information.
- Keeps transcribing locally even if a Gemini text request temporarily hits a quota/rate limit.
- Lets you type a private question into the console and sends it immediately with recent meeting context.
- Does not write meeting audio or transcripts to disk.

The default analysis model is `gemini-3.8-flash`. The default local transcription model is faster-whisper `small`.

## Local-mode requirements

- Windows 10/11.
- Python 3.11+.
- A Gemini API key.
- Internet access for Gemini requests and for the first faster-whisper model download.
- Permission/consent to process the meeting.

## First-time setup

From the repository:

```bat
setup-python.cmd
```

Or:

```bat
npm run setup:python
```

This creates a local `.venv` and installs:

- faster-whisper
- PyAudioWPatch for Windows WASAPI loopback
- google-genai
- numpy

The first run also downloads the selected Whisper model if it is not already cached.

## Add your private business context

Copy:

```
context.example.txt
```

to:

```
context.txt
```

Then paste your real business/interview context into `context.txt`.

`context.txt` is intentionally git-ignored so your private context is not committed to the public repository.

## Start local companion

Double-click:

```
run-local-companion.cmd
```

Or:

```bat
npm run local
```

If `GEMINI_API_KEY` is not already set in the environment, the script securely prompts for it in the console.

While it is running:

- Live transcript lines appear continuously.
- Useful advice appears as `COACH: ...`.
- Routine conversation produces no Gemini-visible advice.
- Type a private question and press Enter to ask Gemini using the recent meeting context.
- Press Ctrl+C to stop.

## Configuration

The local launcher defaults to:

```bat
python\companion.py --standalone --mode sales --interval 12
```

Available modes:

- `sales`
- `interview`
- `general`

Useful environment variables:

- `GEMINI_API_KEY`
- `ZOOM_COMPANION_MODEL`, default `gemini-3.8-flash`
- `ZOOM_COMPANION_WHISPER_MODEL`, default `small`
- `ZOOM_COMPANION_INTERVAL`, default `12`
- `ZOOM_COMPANION_CONTEXT_FILE`, default `context.txt`

Example:

```bat
set ZOOM_COMPANION_WHISPER_MODEL=base
set ZOOM_COMPANION_INTERVAL=10
run-local-companion.cmd
```

Use `base` if the CPU cannot keep up with `small`. Use `small` for better multilingual accuracy when performance is sufficient.

## How quota usage changes

The local mode does not send continuous audio to Gemini Live.

Instead:

```
microphone + system audio
        ↓
local faster-whisper
        ↓
text transcript
        ↓
rolling transcript window
        ↓
Gemini text request every ~12 seconds when new speech exists
        ↓
short coaching response or [SILENT]
```

The rolling transcript sent on each automatic analysis is capped to roughly 6,500 characters. Private typed questions can use up to roughly 9,000 characters of recent transcript.

## Local architecture

- `python/companion.py`: Windows audio capture, resampling, local Whisper transcription, rolling transcript, Gemini text analysis, private questions.
- `requirements-python.txt`: Python dependencies.
- `setup-python.cmd`: creates the local virtual environment and installs dependencies.
- `run-local-companion.cmd`: one-click local companion launcher.
- `context.txt`: your private context, not committed.
- `context.example.txt`: safe template.

### Audio capture

The script uses PyAudioWPatch/WASAPI:

- default input device for your microphone
- default WASAPI loopback device for what you hear through Windows

The two streams are transcribed separately so the transcript can distinguish `YOU` from `MEETING`.

## Legacy Electron / Gemini Live mode

The original Electron application is still available:

```bat
npm install
npm start
```

It includes:

- always-on-top UI
- microphone + system-loopback capture
- Gemini Live audio
- typed private questions
- live transcription
- optional Gemini spoken responses
- encrypted API-key storage through Electron `safeStorage`

This mode consumes Gemini Live quota and is no longer the recommended default for long meetings.

## Build the Electron installer

```bat
npm install
npm run dist
```

The NSIS installer is created under `dist/`.

## Privacy

In local mode, raw meeting audio is processed by faster-whisper on the computer and is not intentionally written to disk. Gemini receives transcript text, the recent rolling transcript window, your configured context, and any private question you type.

Review your organization's policies and applicable recording/AI-assistant rules before using the companion in a real meeting.
