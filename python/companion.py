from __future__ import annotations

import argparse
import getpass
import json
import os
import queue
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from dataclasses import dataclass
from typing import Any

import numpy as np
import pyaudiowpatch as pyaudio
from faster_whisper import WhisperModel
from google import genai
from google.genai import types


TARGET_RATE = 16000
READ_FRAMES = 1024
TRANSCRIBE_CHUNK_SECONDS = 4.0
TRANSCRIPT_WINDOW_CHARS = 6500
ASK_WINDOW_CHARS = 9000
SILENT_MARKER = "[SILENT]"
HUMAN_OUTPUT = False


def emit(event_type: str, payload: dict[str, Any] | None = None) -> None:
    payload = payload or {}
    if HUMAN_OUTPUT:
        if event_type == "input-transcript":
            print(payload.get("text", ""), flush=True)
        elif event_type == "output-transcript":
            print("\nCOACH: " + str(payload.get("text", "")) + "\n", flush=True)
        elif event_type == "capture-info":
            print("AUDIO: " + str(payload.get("text", "")), flush=True)
        elif event_type == "status":
            state = str(payload.get("state", "")).upper()
            reason = str(payload.get("reason", "")).strip()
            print(f"{state}: {reason}".rstrip(), flush=True)
        elif event_type == "error":
            print("ERROR: " + str(payload.get("message", "")), file=sys.stderr, flush=True)
        return

    print(
        json.dumps({"type": event_type, "payload": payload}, ensure_ascii=False),
        flush=True,
    )


def clean_text(value: str) -> str:
    return " ".join((value or "").split()).strip()


def pcm16_to_float_mono(raw: bytes, channels: int, source_rate: int) -> np.ndarray:
    pcm = np.frombuffer(raw, dtype=np.int16)
    if pcm.size == 0:
        return np.empty(0, dtype=np.float32)

    if channels > 1:
        usable = pcm.size - (pcm.size % channels)
        if usable <= 0:
            return np.empty(0, dtype=np.float32)
        pcm = pcm[:usable].reshape(-1, channels).mean(axis=1)

    audio = pcm.astype(np.float32) / 32768.0
    if source_rate == TARGET_RATE or audio.size < 2:
        return audio

    target_size = max(1, int(round(audio.size * TARGET_RATE / source_rate)))
    source_x = np.arange(audio.size, dtype=np.float64)
    target_x = np.linspace(0, audio.size - 1, target_size, dtype=np.float64)
    return np.interp(target_x, source_x, audio).astype(np.float32)


@dataclass
class AudioChunk:
    source: str
    audio: np.ndarray
    captured_at: float


class CompanionService:
    def __init__(self, config: dict[str, Any]) -> None:
        self.api_key = str(config.get("apiKey") or "").strip()
        self.model_name = str(config.get("model") or "gemini-3.8-flash").strip()
        self.whisper_model_name = str(config.get("whisperModel") or "small").strip()
        self.system_prompt = str(config.get("systemPrompt") or "").strip()
        self.analysis_interval = max(6.0, float(config.get("intervalSeconds") or 12))
        self.ollama_enabled = bool(config.get("ollamaEnabled", True))
        self.ollama_model = str(config.get("ollamaModel") or "").strip()
        self.ollama_url = str(config.get("ollamaUrl") or "http://127.0.0.1:11434").rstrip("/")

        self.stop_event = threading.Event()
        self.audio_queue: queue.Queue[AudioChunk] = queue.Queue(maxsize=12)
        self.transcript_lock = threading.Lock()
        self.transcript: deque[tuple[int, float, str, str]] = deque(maxlen=180)
        self.next_sequence = 1
        self.last_analyzed_sequence = 0
        self.last_analysis_at = 0.0
        self.api_blocked_until = 0.0
        self.api_backoff_seconds = 0.0

        self.api_lock = threading.Lock()
        self.pa: pyaudio.PyAudio | None = None
        self.streams: list[Any] = []
        self.capture_threads: list[threading.Thread] = []
        self.worker_threads: list[threading.Thread] = []

        self.whisper: WhisperModel | None = None
        self.client: genai.Client | None = None

    def start(self) -> None:
        if not self.api_key:
            raise RuntimeError("Gemini API key is missing.")

        emit("status", {"state": "connecting", "reason": "Loading local Whisper model…"})
        self.client = genai.Client(api_key=self.api_key)

        self.whisper = WhisperModel(
            self.whisper_model_name,
            device="cpu",
            compute_type="int8",
        )

        emit("status", {"state": "connecting", "reason": "Opening microphone and Windows system audio…"})
        self.pa = pyaudio.PyAudio()
        opened = self._open_audio_sources()
        if not opened:
            raise RuntimeError(
                "No usable audio source was found. Check the Windows microphone and speaker devices."
            )

        transcriber = threading.Thread(
            target=self._transcription_loop,
            name="local-transcriber",
            daemon=True,
        )
        analyzer = threading.Thread(
            target=self._analysis_loop,
            name="gemini-analyzer",
            daemon=True,
        )
        self.worker_threads.extend([transcriber, analyzer])
        transcriber.start()
        analyzer.start()

        emit(
            "status",
            {
                "state": "connected",
                "reason": "Local Whisper is listening. Only transcript text is sent to Gemini.",
            },
        )

    def _open_audio_sources(self) -> list[str]:
        assert self.pa is not None
        opened: list[str] = []

        try:
            mic = self.pa.get_default_input_device_info()
            channels = max(1, min(2, int(mic.get("maxInputChannels") or 1)))
            rate = int(mic.get("defaultSampleRate") or 48000)
            stream = self.pa.open(
                format=pyaudio.paInt16,
                channels=channels,
                rate=rate,
                input=True,
                input_device_index=int(mic["index"]),
                frames_per_buffer=READ_FRAMES,
            )
            self.streams.append(stream)
            self._start_capture_thread("YOU", stream, channels, rate)
            opened.append(f"mic: {mic.get('name', 'default microphone')}")
        except Exception as exc:
            emit("status", {"state": "connecting", "reason": f"Microphone unavailable: {exc}"})

        try:
            loopback = self.pa.get_default_wasapi_loopback()
            channels = max(1, min(2, int(loopback.get("maxInputChannels") or 2)))
            rate = int(loopback.get("defaultSampleRate") or 48000)
            stream = self.pa.open(
                format=pyaudio.paInt16,
                channels=channels,
                rate=rate,
                input=True,
                input_device_index=int(loopback["index"]),
                frames_per_buffer=READ_FRAMES,
            )
            self.streams.append(stream)
            self._start_capture_thread("MEETING", stream, channels, rate)
            opened.append(f"system: {loopback.get('name', 'default speakers')}")
        except Exception as exc:
            emit("status", {"state": "connecting", "reason": f"System audio unavailable: {exc}"})

        if opened:
            emit("capture-info", {"text": "Listening locally to " + " + ".join(opened)})
        return opened

    def _start_capture_thread(self, source: str, stream: Any, channels: int, rate: int) -> None:
        thread = threading.Thread(
            target=self._capture_loop,
            args=(source, stream, channels, rate),
            name=f"capture-{source.lower()}",
            daemon=True,
        )
        self.capture_threads.append(thread)
        thread.start()

    def _capture_loop(self, source: str, stream: Any, channels: int, rate: int) -> None:
        target_frames = max(READ_FRAMES, int(rate * TRANSCRIBE_CHUNK_SECONDS))
        parts: list[bytes] = []
        frames = 0

        while not self.stop_event.is_set():
            try:
                data = stream.read(READ_FRAMES, exception_on_overflow=False)
            except Exception as exc:
                if not self.stop_event.is_set():
                    emit("error", {"message": f"{source} audio capture error: {exc}"})
                return

            parts.append(data)
            frames += len(data) // (2 * channels)
            if frames < target_frames:
                continue

            raw = b"".join(parts)
            parts = []
            frames = 0
            audio = pcm16_to_float_mono(raw, channels, rate)
            if audio.size == 0:
                continue

            rms = float(np.sqrt(np.mean(np.square(audio), dtype=np.float64)))
            if rms < 0.0015:
                continue

            chunk = AudioChunk(source=source, audio=audio, captured_at=time.time())
            try:
                self.audio_queue.put_nowait(chunk)
            except queue.Full:
                try:
                    self.audio_queue.get_nowait()
                except queue.Empty:
                    pass
                try:
                    self.audio_queue.put_nowait(chunk)
                except queue.Full:
                    pass

    def _transcription_loop(self) -> None:
        assert self.whisper is not None

        while not self.stop_event.is_set():
            try:
                chunk = self.audio_queue.get(timeout=0.5)
            except queue.Empty:
                continue

            try:
                segments, _info = self.whisper.transcribe(
                    chunk.audio,
                    beam_size=1,
                    best_of=1,
                    vad_filter=True,
                    vad_parameters={"min_silence_duration_ms": 250},
                    condition_on_previous_text=False,
                    temperature=0.0,
                )
                pieces: list[str] = []
                for segment in segments:
                    text = clean_text(segment.text)
                    if not text:
                        continue
                    if getattr(segment, "no_speech_prob", 0.0) > 0.85:
                        continue
                    pieces.append(text)

                text = clean_text(" ".join(pieces))
                if text:
                    self._append_transcript(chunk.source, text, chunk.captured_at)
            except Exception as exc:
                emit("error", {"message": f"Local transcription error: {exc}"})

    def _append_transcript(self, source: str, text: str, captured_at: float) -> None:
        with self.transcript_lock:
            sequence = self.next_sequence
            self.next_sequence += 1
            self.transcript.append((sequence, captured_at, source, text))

        emit("input-transcript", {"text": f"[{source}] {text}", "source": source})

    def _snapshot(self, max_chars: int) -> tuple[int, str]:
        with self.transcript_lock:
            rows = list(self.transcript)

        if not rows:
            return 0, ""

        latest_sequence = rows[-1][0]
        lines = [f"[{source}] {text}" for _seq, _ts, source, text in rows]
        selected: list[str] = []
        total = 0
        for line in reversed(lines):
            cost = len(line) + 1
            if selected and total + cost > max_chars:
                break
            selected.append(line)
            total += cost
        selected.reverse()
        return latest_sequence, "\n".join(selected)

    def _analysis_loop(self) -> None:
        while not self.stop_event.wait(1.0):
            now = time.monotonic()
            if now - self.last_analysis_at < self.analysis_interval:
                continue

            latest_sequence, transcript = self._snapshot(TRANSCRIPT_WINDOW_CHARS)
            if not transcript or latest_sequence <= self.last_analyzed_sequence:
                continue

            self.last_analysis_at = now
            self.last_analyzed_sequence = latest_sequence
            self._request_advice(transcript, direct_question=None)

    def _ollama_tags(self) -> list[dict[str, Any]]:
        request = urllib.request.Request(
            self.ollama_url + "/api/tags",
            headers={"Accept": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=2.5) as response:
            payload = json.loads(response.read().decode("utf-8"))
        models = payload.get("models") if isinstance(payload, dict) else []
        return models if isinstance(models, list) else []

    def _select_ollama_model(self) -> str:
        if self.ollama_model:
            return self.ollama_model

        models = self._ollama_tags()
        if not models:
            raise RuntimeError("Ollama is running but no local models are installed.")

        preferred_prefixes = [
            "qwen3.8",
            "qwen3.6",
            "qwen3.5",
            "gpt-oss:120b",
            "gpt-oss",
            "qwen3:235b",
            "qwen3:32b",
            "qwen3:30b",
            "qwen3",
            "deepseek-r1",
            "llama4",
            "llama3.3",
            "gemma3",
        ]

        normalized = []
        for item in models:
            name = str(item.get("name") or item.get("model") or "").strip()
            if not name:
                continue
            normalized.append(
                {
                    "name": name,
                    "lower": name.lower(),
                    "size": int(item.get("size") or 0),
                }
            )

        for prefix in preferred_prefixes:
            matches = [m for m in normalized if m["lower"].startswith(prefix)]
            if matches:
                matches.sort(key=lambda m: m["size"], reverse=True)
                return matches[0]["name"]

        normalized.sort(key=lambda m: m["size"], reverse=True)
        return normalized[0]["name"]

    def _request_ollama(self, prompt: str) -> tuple[str, str]:
        if not self.ollama_enabled:
            raise RuntimeError("Ollama fallback is disabled.")

        model = self._select_ollama_model()
        body = json.dumps(
            {
                "model": model,
                "stream": False,
                "messages": [
                    {"role": "system", "content": self.system_prompt},
                    {"role": "user", "content": prompt},
                ],
                "options": {"temperature": 0.2},
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            self.ollama_url + "/api/chat",
            data=body,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=90) as response:
            payload = json.loads(response.read().decode("utf-8"))

        text = clean_text(
            str(((payload.get("message") or {}).get("content")) or "")
        )
        if not text:
            raise RuntimeError(f"Ollama model {model} returned no text.")
        return text, model

    def _request_advice(
        self,
        transcript: str,
        direct_question: str | None,
    ) -> None:
        assert self.client is not None

        if direct_question:
            prompt = (
                "The user privately asked the following during an ongoing meeting:\n"
                f"{direct_question}\n\n"
                "Recent meeting transcript:\n"
                f"{transcript}\n\n"
                "Answer the user's private question directly. Keep the answer concise and immediately usable."
            )
        else:
            prompt = (
                "Review this recent rolling meeting transcript. Decide whether the user needs useful coaching RIGHT NOW. "
                f"If no intervention is materially useful, output exactly {SILENT_MARKER}. "
                "Do not summarize the meeting. If intervention is useful, give only the short advice the user needs next.\n\n"
                "Recent transcript:\n"
                f"{transcript}"
            )

        if time.monotonic() < self.api_blocked_until:
            try:
                text, ollama_model = self._request_ollama(prompt)
                if not text or text.upper() == SILENT_MARKER:
                    return
                provider = f"Ollama · {ollama_model}"
                emit(
                    "provider",
                    {"provider": "ollama", "model": ollama_model, "reason": "Gemini backoff active"},
                )
                emit("output-transcript", {"text": text, "provider": provider})
                emit("generation-complete", {"provider": provider})
            except Exception as ollama_exc:
                emit(
                    "error",
                    {"message": f"Gemini is backing off and Ollama fallback failed: {ollama_exc}"},
                )
            return

        try:
            config_args: dict[str, Any] = {
                "system_instruction": self.system_prompt,
                "thinking_config": types.ThinkingConfig(thinking_level="low"),
                "max_output_tokens": 220,
                "tools": [types.Tool(google_search=types.GoogleSearch())],
            }

            with self.api_lock:
                response = self.client.models.generate_content(
                    model=self.model_name,
                    contents=prompt,
                    config=types.GenerateContentConfig(**config_args),
                )

            self.api_backoff_seconds = 0.0
            self.api_blocked_until = 0.0
            text = clean_text(response.text or "")
            provider = "Gemini"
        except Exception as exc:
            gemini_message = str(exc)
            gemini_lower = gemini_message.lower()
            if "429" in gemini_lower or "quota" in gemini_lower or "resource_exhausted" in gemini_lower:
                self.api_backoff_seconds = min(
                    300.0,
                    max(30.0, self.api_backoff_seconds * 2.0),
                )
                self.api_blocked_until = time.monotonic() + self.api_backoff_seconds

            try:
                text, ollama_model = self._request_ollama(prompt)
                provider = f"Ollama · {ollama_model}"
                emit(
                    "provider",
                    {
                        "provider": "ollama",
                        "model": ollama_model,
                        "reason": gemini_message,
                    },
                )
            except Exception as ollama_exc:
                emit(
                    "error",
                    {
                        "message": (
                            f"Gemini failed: {gemini_message} "
                            f"Ollama fallback also failed: {ollama_exc}"
                        )
                    },
                )
                return

        if not text or text.upper() == SILENT_MARKER:
            return
        emit("output-transcript", {"text": text, "provider": provider})
        emit("generation-complete", {"provider": provider})

    def ask(self, text: str) -> None:
        question = clean_text(text)
        if not question:
            return
        _sequence, transcript = self._snapshot(ASK_WINDOW_CHARS)
        threading.Thread(
            target=self._request_advice,
            args=(transcript, question),
            name="private-question",
            daemon=True,
        ).start()

    def stop(self) -> None:
        self.stop_event.set()

        for stream in self.streams:
            try:
                stream.stop_stream()
            except Exception:
                pass
            try:
                stream.close()
            except Exception:
                pass
        self.streams.clear()

        if self.pa is not None:
            try:
                self.pa.terminate()
            except Exception:
                pass
            self.pa = None

        emit("status", {"state": "stopped"})


def build_standalone_system_prompt(mode: str, context: str) -> str:
    base = """You are Zoom Companion, a private meeting coach for the user. You receive a rolling transcript tagged [YOU] and [MEETING].

Only intervene when the user would materially benefit from help. Do not narrate or summarize routine conversation. When useful, give a concise answer or next move that can be used immediately, usually under 55 words.

Be factual. Never invent the user's experience, capabilities, pricing, customers, credentials, or project history. If a named product, company, framework, standard, competitor, current fact, or unfamiliar system matters, use Google Search when verification would improve accuracy. Clearly distinguish verified facts from estimates or assumptions. Match Hebrew or English to the conversation when practical."""

    modes = {
        "sales": """Act as a senior technical-sales copilot. Help with discovery, objections, feasibility, architecture, integrations, scope, pricing conversations, next-step questions, and closing. Prefer one strong next question over a long explanation.""",
        "interview": """Act as a private interview copilot. Give concise, truthful answer structures the user can adapt immediately. Never fabricate experience. Bridge honestly from adjacent experience when needed.""",
        "general": """Act as a high-signal meeting copilot. Surface facts, risks, action items, definitions, and useful follow-up questions only when they materially improve the user's next move.""",
    }

    prompt = base + "\n\n" + modes.get(mode, modes["general"])
    context = context.strip()
    if context:
        prompt += "\n\nUSER CONTEXT, TREAT AS AUTHORITATIVE UNLESS THE LIVE CONVERSATION CONTRADICTS IT:\n" + context
    return prompt


def standalone_main() -> int:
    global HUMAN_OUTPUT
    HUMAN_OUTPUT = True

    parser = argparse.ArgumentParser(description="Local Whisper + Gemini text meeting companion")
    parser.add_argument("--mode", choices=["sales", "interview", "general"], default="sales")
    parser.add_argument("--model", default=os.environ.get("ZOOM_COMPANION_MODEL", "gemini-3.8-flash"))
    parser.add_argument("--whisper-model", default=os.environ.get("ZOOM_COMPANION_WHISPER_MODEL", "small"))
    parser.add_argument("--interval", type=float, default=float(os.environ.get("ZOOM_COMPANION_INTERVAL", "12")))
    parser.add_argument("--context-file", default=os.environ.get("ZOOM_COMPANION_CONTEXT_FILE", "context.txt"))
    args = parser.parse_args()

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        api_key = getpass.getpass("Gemini API key: ").strip()
    if not api_key:
        print("Gemini API key is required.", file=sys.stderr)
        return 2

    context = ""
    if args.context_file and os.path.exists(args.context_file):
        with open(args.context_file, "r", encoding="utf-8") as handle:
            context = handle.read()

    service = CompanionService(
        {
            "apiKey": api_key,
            "model": args.model,
            "whisperModel": args.whisper_model,
            "intervalSeconds": args.interval,
            "systemPrompt": build_standalone_system_prompt(args.mode, context),
        }
    )

    try:
        service.start()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        try:
            service.stop()
        except Exception:
            pass
        return 1

    print(
        "\nLocal mode is running. Audio is transcribed on this PC. "
        "Only transcript text is sent to Gemini.\n"
        "Type a private question and press Enter at any time. Press Ctrl+C to stop.\n",
        flush=True,
    )

    def question_loop() -> None:
        try:
            for line in sys.stdin:
                question = line.strip()
                if question:
                    service.ask(question)
        except Exception:
            pass

    threading.Thread(target=question_loop, name="console-questions", daemon=True).start()

    try:
        while not service.stop_event.wait(0.5):
            pass
    except KeyboardInterrupt:
        pass
    finally:
        service.stop()
    return 0


def read_json_line(line: str) -> dict[str, Any] | None:
    try:
        value = json.loads(line)
        return value if isinstance(value, dict) else None
    except json.JSONDecodeError:
        return None


def main() -> int:
    if "--standalone" in sys.argv:
        sys.argv.remove("--standalone")
        return standalone_main()

    first_line = sys.stdin.readline()
    if not first_line:
        emit("error", {"message": "No startup configuration was received."})
        return 2

    command = read_json_line(first_line)
    if not command or command.get("type") != "start":
        emit("error", {"message": "Expected a start command on stdin."})
        return 2

    service = CompanionService(command)
    try:
        service.start()
    except Exception as exc:
        emit("error", {"message": str(exc)})
        service.stop()
        return 1

    try:
        for line in sys.stdin:
            command = read_json_line(line)
            if not command:
                continue
            command_type = command.get("type")
            if command_type == "ask":
                service.ask(str(command.get("text") or ""))
            elif command_type == "stop":
                break
    except KeyboardInterrupt:
        pass
    finally:
        service.stop()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
