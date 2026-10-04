# Zoom Companion

Windows desktop meeting copilot with local transcription, Gemini text analysis, automatic Google Search grounding, and Ollama fallback.

## Recommended architecture

```
Windows mic + system audio
        ↓
local faster-whisper
        ↓
rolling transcript
        ↓
Gemini 3.8 Flash text analysis
        ↓
Google Search automatically when useful
        ↓
GUI coaching response
        ↓
Ollama fallback if Gemini fails
```

Raw meeting audio stays on the PC in the recommended mode. Gemini receives rolling transcript text and user/business context, not raw audio.

## GUI

Run the Electron application:

```bat
npm install
npm start
```

The GUI shows:

- Ready / setup / loading / listening / error state
- Live local transcript
- Current coaching response
- Which provider answered, Gemini or Ollama
- Sales, Interview, and General modes
- Gemini API key
- Hugging Face token
- Whisper model
- Analysis interval
- Ollama fallback toggle and preferred model
- Private typed questions
- Always-on-top and compact modes
- Optional Windows text-to-speech for coaching

## Credentials

Gemini and Hugging Face credentials are saved through Electron `safeStorage`, which uses the operating system's secure credential protection when available.

You normally enter each credential once and click **Save settings**.

Environment variables can still override saved values:

- `GEMINI_API_KEY`
- `HF_TOKEN`

The Hugging Face token is optional for public Whisper models, but the app can pass it to Hugging Face model downloads when supplied.

## First start

The GUI automatically:

1. Finds Python on Windows.
2. Creates a private Python environment under the app's user-data directory.
3. Installs the packages from `requirements-python.txt` if needed.
4. Loads/downloads the selected faster-whisper model.
5. Opens the default microphone and Windows WASAPI loopback output.
6. Starts local transcription.
7. Sends rolling text to Gemini only when there is new transcript.

The first Whisper model download may take longer than later starts.

## Broad meeting assistance

There are no fixed trigger phrases.

The model is instructed to help when useful, including:

- direct questions to the user
- interview questions
- technical questions
- unfamiliar systems or terminology
- feasibility and integration questions
- objections
- pricing and scope pressure
- architecture/security concerns
- potentially incorrect or current claims
- decisions and risks
- useful next questions

Google Search is made available to Gemini on every analysis request. Gemini decides dynamically whether outside/current information is needed.

## Gemini quota behavior

Automatic analysis defaults to every 12 seconds and only runs when new transcript exists. Gemini 3.8 Flash uses low thinking for lower latency/cost.

If Gemini returns a quota, rate, or service error, the companion backs Gemini off and continues using Ollama when enabled.

## Ollama fallback

Ollama defaults to:

```
http://127.0.0.1:11434
```

Leave **Preferred Ollama model** blank to auto-select the strongest suitable installed model.

The selector prefers current high-capability families such as newer Qwen 3.x models and gpt-oss, then falls back to the largest suitable installed model it can find.

The app does not automatically download a massive Ollama model. Install the model you want in Ollama first, or type an installed model name in the GUI.

## Local transcription

Python dependencies:

- faster-whisper
- PyAudioWPatch
- google-genai
- numpy

PyAudioWPatch captures the default Windows WASAPI loopback device so the companion can hear Zoom, Meet, Teams, browser calls, and other meeting audio.

The transcript is tagged:

- `[YOU]` for microphone speech
- `[MEETING]` for Windows system audio

## Private questions

Type a question into the GUI during the meeting and press **Ask**. The current rolling transcript is included automatically so the answer can use meeting context.

## Windows installer

```bat
npm run dist
```

The NSIS installer is generated under `dist/`.

The packaged app includes the Python companion source and requirements. Python itself is not bundled, so Python 3.11+ must be installed on the machine.

## Privacy

The recommended mode does not intentionally save meeting audio or transcripts to disk. Raw audio is processed locally by faster-whisper. Gemini receives transcript text, the configured context, and private questions.

Make sure meeting recording/AI-assistant use is permitted by the participants, organization, and applicable rules.
