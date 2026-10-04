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
TRANSCRIBE_CHUNK_SECONDS = 2.0
TRANSCRIPT_WINDOW_CHARS = 1800
TRANSCRIPT_WINDOW_SECONDS = 30
ASK_WINDOW_CHARS = 9000
AUTO_MAX_WORDS = 18
DIRECT_MAX_WORDS = 42
SPEECH_START_RMS = 0.008
SPEECH_END_RMS = 0.0045
SPEECH_END_SILENCE_SECONDS = 0.35
SPEECH_MAX_SEGMENT_SECONDS = 2.4
SPEECH_PRE_ROLL_SECONDS = 0.18
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


def limit_words(value: str, max_words: int) -> str:
    words = clean_text(value).split()
    if len(words) <= max_words:
        return " ".join(words)
    return " ".join(words[:max_words]).rstrip(" ,;:-") + "…"


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
        self.auto_model_name = str(
            config.get("autoModel") or "gemini-3.5-flash-lite"
        ).strip()
        self.whisper_model_name = str(config.get("whisperModel") or "small").strip()
        self.system_prompt = str(config.get("systemPrompt") or "").strip()
        self.analysis_interval = max(3.0, float(config.get("intervalSeconds") or 4))
        self.ollama_enabled = bool(config.get("ollamaEnabled", True))
        self.ollama_model = str(config.get("ollamaModel") or "").strip()
        self.ollama_url = str(config.get("ollamaUrl") or "http://127.0.0.1:11434").rstrip("/")

        self.stop_event = threading.Event()
        self.paused_event = threading.Event()
        self.analysis_event = threading.Event()
        self.output_speaking_event = threading.Event()
        self.suppress_system_until = 0.0
        self.last_user_activity_emit = 0.0
        self.audio_queue: queue.Queue[AudioChunk] = queue.Queue(maxsize=20)
        self.transcript_lock = threading.Lock()
        self.transcript: deque[tuple[int, float, str, str]] = deque(maxlen=180)
        self.next_sequence = 1
        self.last_analyzed_sequence = 0
        self.last_analysis_at = 0.0
        self.last_advice_fingerprint = ""
        self.last_advice_at = 0.0
        self.api_blocked_until = 0.0
        self.api_backoff_seconds = 0.0

        self.api_lock = threading.Lock()
        self.analysis_slots = threading.BoundedSemaphore(2)
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
        bytes_per_frame = 2 * channels
        pre_roll_blocks = max(
            1,
            int((rate * SPEECH_PRE_ROLL_SECONDS) / READ_FRAMES),
        )
        pre_roll: deque[bytes] = deque(maxlen=pre_roll_blocks)
        speech_parts: list[bytes] = []
        speech_frames = 0
        silence_frames = 0
        speech_active = False

        def flush_segment() -> None:
            nonlocal speech_parts, speech_frames, silence_frames, speech_active
            if not speech_parts or speech_frames < int(rate * 0.25):
                speech_parts = []
                speech_frames = 0
                silence_frames = 0
                speech_active = False
                return

            raw = b"".join(speech_parts)
            speech_parts = []
            speech_frames = 0
            silence_frames = 0
            speech_active = False
            pre_roll.clear()

            audio = pcm16_to_float_mono(raw, channels, rate)
            if audio.size == 0:
                return
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

        while not self.stop_event.is_set():
            try:
                data = stream.read(READ_FRAMES, exception_on_overflow=False)
            except Exception as exc:
                if not self.stop_event.is_set():
                    emit("error", {"message": f"{source} audio capture error: {exc}"})
                return

            if self.paused_event.is_set():
                pre_roll.clear()
                speech_parts = []
                speech_frames = 0
                silence_frames = 0
                speech_active = False
                continue

            if source == "MEETING" and (
                self.output_speaking_event.is_set()
                or time.monotonic() < self.suppress_system_until
            ):
                pre_roll.clear()
                speech_parts = []
                speech_frames = 0
                silence_frames = 0
                speech_active = False
                continue

            pcm = np.frombuffer(data, dtype=np.int16)
            if pcm.size == 0:
                continue
            level = float(
                np.sqrt(
                    np.mean(
                        np.square(pcm.astype(np.float32) / 32768.0),
                        dtype=np.float64,
                    )
                )
            )

            if source == "YOU":
                now = time.monotonic()
                if level >= SPEECH_START_RMS and now - self.last_user_activity_emit >= 0.5:
                    self.last_user_activity_emit = now
                    emit("user-speaking", {})

            if not speech_active:
                pre_roll.append(data)
                if level < SPEECH_START_RMS:
                    continue
                speech_active = True
                speech_parts.extend(pre_roll)
                speech_frames = sum(len(block) // bytes_per_frame for block in pre_roll)
                pre_roll.clear()
                silence_frames = 0
                emit("trace", {"message": f"{source.lower()} speech detected"})
                continue

            speech_parts.append(data)
            block_frames = len(data) // bytes_per_frame
            speech_frames += block_frames

            if level <= SPEECH_END_RMS:
                silence_frames += block_frames
            else:
                silence_frames = 0

            if (
                silence_frames >= int(rate * SPEECH_END_SILENCE_SECONDS)
                or speech_frames >= int(rate * SPEECH_MAX_SEGMENT_SECONDS)
            ):
                flush_segment()

        flush_segment()

    def _transcription_loop(self) -> None:
        assert self.whisper is not None

        while not self.stop_event.is_set():
            if self.paused_event.is_set():
                time.sleep(0.1)
                continue
            try:
                chunk = self.audio_queue.get(timeout=0.5)
            except queue.Empty:
                continue

            try:
                transcribe_started = time.monotonic()
                segments, _info = self.whisper.transcribe(
                    chunk.audio,
                    beam_size=1,
                    best_of=1,
                    vad_filter=False,
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
                    elapsed = time.monotonic() - transcribe_started
                    emit(
                        "trace",
                        {
                            "message": (
                                f"transcribed {chunk.source.lower()} in {elapsed:.2f}s"
                            )
                        },
                    )
                    self._append_transcript(chunk.source, text, chunk.captured_at)
            except Exception as exc:
                emit("error", {"message": f"Local transcription error: {exc}"})

    def _append_transcript(self, source: str, text: str, captured_at: float) -> None:
        with self.transcript_lock:
            sequence = self.next_sequence
            self.next_sequence += 1
            self.transcript.append((sequence, captured_at, source, text))

        emit("input-transcript", {"text": f"[{source}] {text}", "source": source})
        self.analysis_event.set()

    def _snapshot(
        self,
        max_chars: int,
        max_age_seconds: float | None = None,
    ) -> tuple[int, str]:
        with self.transcript_lock:
            rows = list(self.transcript)

        if not rows:
            return 0, ""

        latest_sequence = rows[-1][0]
        if max_age_seconds is not None:
            cutoff = time.time() - max_age_seconds
            rows = [row for row in rows if row[1] >= cutoff]
            if not rows:
                return latest_sequence, ""

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
        while not self.stop_event.is_set():
            self.analysis_event.wait(timeout=0.5)
            if self.stop_event.is_set():
                return
            if self.paused_event.is_set():
                self.analysis_event.clear()
                continue

            if not self.analysis_event.is_set():
                continue

            now = time.monotonic()
            since_last = now - self.last_analysis_at
            if since_last < self.analysis_interval:
                self.stop_event.wait(self.analysis_interval - since_last)
                if self.stop_event.is_set() or self.paused_event.is_set():
                    continue

            previous_sequence = self.last_analyzed_sequence
            latest_sequence, transcript = self._snapshot(
                TRANSCRIPT_WINDOW_CHARS,
                TRANSCRIPT_WINDOW_SECONDS,
            )
            if not transcript or latest_sequence <= previous_sequence:
                self.analysis_event.clear()
                continue

            if not self.analysis_slots.acquire(blocking=False):
                continue

            with self.transcript_lock:
                new_rows = [
                    f"[{source}] {text}"
                    for seq, _ts, source, text in self.transcript
                    if seq > previous_sequence
                ]
            new_transcript = "\n".join(new_rows)

            self.last_analysis_at = time.monotonic()
            self.last_analyzed_sequence = latest_sequence

            with self.transcript_lock:
                newest_sequence = self.next_sequence - 1
            if newest_sequence <= latest_sequence:
                self.analysis_event.clear()

            emit(
                "trace",
                {
                    "message": (
                        f"fast coach evaluating {len(new_rows)} new transcript segment"
                        f"{'s' if len(new_rows) != 1 else ''}"
                    )
                },
            )

            threading.Thread(
                target=self._run_auto_request,
                args=(
                    transcript,
                    new_transcript,
                    latest_sequence,
                    time.monotonic(),
                ),
                name=f"fast-coach-{latest_sequence}",
                daemon=True,
            ).start()

    def _run_auto_request(
        self,
        transcript: str,
        new_transcript: str,
        request_sequence: int,
        request_started_at: float,
    ) -> None:
        try:
            self._request_advice(
                transcript,
                direct_question=None,
                new_transcript=new_transcript,
                request_sequence=request_sequence,
                request_started_at=request_started_at,
            )
        finally:
            self.analysis_slots.release()

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
                "think": False,
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
            generate_body = json.dumps(
                {
                    "model": model,
                    "stream": False,
                    "think": False,
                    "prompt": self.system_prompt + "\n\n" + prompt,
                    "options": {"temperature": 0.2},
                }
            ).encode("utf-8")
            generate_request = urllib.request.Request(
                self.ollama_url + "/api/generate",
                data=generate_body,
                method="POST",
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(generate_request, timeout=90) as response:
                generated = json.loads(response.read().decode("utf-8"))
            text = clean_text(str(generated.get("response") or ""))

        if not text:
            raise RuntimeError(f"Ollama model {model} returned no direct answer.")
        return text, model

    def _is_fresh(
        self,
        request_sequence: int | None,
        request_started_at: float | None,
        max_elapsed: float,
        max_advance: int,
    ) -> bool:
        elapsed = (
            time.monotonic() - request_started_at
            if request_started_at is not None
            else 0.0
        )
        with self.transcript_lock:
            current_sequence = self.next_sequence - 1

        advanced_by = (
            current_sequence - request_sequence
            if request_sequence is not None
            else 0
        )
        return elapsed <= max_elapsed and advanced_by <= max_advance

    def _emit_advice(
        self,
        text: str,
        provider: str,
        kind: str,
        request_sequence: int | None = None,
        request_started_at: float | None = None,
    ) -> None:
        text = clean_text(text)
        if not text or text.upper() == SILENT_MARKER:
            return

        if kind == "automatic":
            text = limit_words(text, AUTO_MAX_WORDS)
            if not self._is_fresh(
                request_sequence,
                request_started_at,
                max_elapsed=8.0,
                max_advance=3,
            ):
                emit(
                    "stale-advice",
                    {"reason": "Fast coaching answer arrived after the conversation moved on."},
                )
                return
        elif kind == "research":
            text = limit_words(text, 24)
            if not self._is_fresh(
                request_sequence,
                request_started_at,
                max_elapsed=14.0,
                max_advance=4,
            ):
                emit(
                    "stale-advice",
                    {"reason": "Research answer arrived after the conversation moved on."},
                )
                return

        fingerprint = " ".join(
            "".join(ch.lower() if ch.isalnum() else " " for ch in text).split()
        )
        now = time.monotonic()
        if (
            fingerprint
            and fingerprint == self.last_advice_fingerprint
            and now - self.last_advice_at < 60.0
        ):
            return

        self.last_advice_fingerprint = fingerprint
        self.last_advice_at = now
        emit(
            "output-transcript",
            {"text": text, "provider": provider, "kind": kind},
        )
        emit("generation-complete", {"provider": provider, "kind": kind})

    def _request_deep_search(
        self,
        search_query: str,
        transcript: str,
        request_sequence: int | None,
        request_started_at: float | None,
    ) -> None:
        assert self.client is not None

        prompt = (
            "A meeting copilot needs a very short, verified answer right now. "
            "Use Google Search to verify the external/current fact. "
            "Return only the practical answer the user needs, maximum 24 words.\n\n"
            f"SEARCH / VERIFY:\n{search_query}\n\n"
            f"RECENT MEETING CONTEXT:\n{transcript}"
        )

        try:
            response = self.client.models.generate_content(
                model=self.model_name,
                contents=prompt,
                config=types.GenerateContentConfig(
                    system_instruction=self.system_prompt,
                    thinking_config=types.ThinkingConfig(thinking_level="low"),
                    max_output_tokens=120,
                    tools=[types.Tool(google_search=types.GoogleSearch())],
                ),
            )
            self._emit_advice(
                response.text or "",
                "Gemini · verified",
                "research",
                request_sequence,
                request_started_at,
            )
        except Exception as exc:
            try:
                text, ollama_model = self._request_ollama(
                    prompt
                    + "\n\nWeb verification is unavailable. If you cannot answer safely "
                    "from local knowledge, output exactly [SILENT]."
                )
                self._emit_advice(
                    text,
                    f"Ollama · {ollama_model} · unverified",
                    "research",
                    request_sequence,
                    request_started_at,
                )
            except Exception:
                emit("log", {"message": f"Background verification failed: {exc}"})

    def _request_advice(
        self,
        transcript: str,
        direct_question: str | None,
        new_transcript: str | None = None,
        request_sequence: int | None = None,
        request_started_at: float | None = None,
    ) -> None:
        assert self.client is not None

        if direct_question:
            prompt = (
                "The user privately asked this during an ongoing meeting:\n"
                f"{direct_question}\n\n"
                "Use the recent meeting context below. Give only the answer the user needs right now. "
                "Maximum 42 words unless the user explicitly asks for detail. "
                "No headings, no bullets, no recap, no rationale section, no 'why this works'. "
                "If external/current verification matters, use Google Search.\n\n"
                f"RECENT CONTEXT:\n{transcript}"
            )
            try:
                response = self.client.models.generate_content(
                    model=self.model_name,
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        system_instruction=self.system_prompt,
                        thinking_config=types.ThinkingConfig(thinking_level="low"),
                        max_output_tokens=140,
                        tools=[types.Tool(google_search=types.GoogleSearch())],
                    ),
                )
                self._emit_advice(
                    limit_words(response.text or "", DIRECT_MAX_WORDS),
                    "Gemini",
                    "direct",
                )
                return
            except Exception as exc:
                try:
                    text, ollama_model = self._request_ollama(prompt)
                    self._emit_advice(
                        limit_words(text, DIRECT_MAX_WORDS),
                        f"Ollama · {ollama_model}",
                        "direct",
                    )
                except Exception as ollama_exc:
                    emit(
                        "error",
                        {
                            "message": (
                                f"Gemini failed: {exc} "
                                f"Ollama fallback also failed: {ollama_exc}"
                            )
                        },
                    )
                return

        prompt = (
            "You are the FAST reaction layer of a private meeting copilot. "
            "Base your decision on the last few utterances, with the newest speech weighted most heavily. "
            "Do not explain. Do not summarize. Do not answer an old topic just because it appears in context.\n\n"
            "Return exactly one of these forms:\n"
            f"1. {SILENT_MARKER}\n"
            "2. [SEARCH] followed by a short search query, only when an external/current fact must be verified.\n"
            "3. One immediately useful coaching sentence, maximum 18 words.\n\n"
            "Use [SILENT] when the conversation is routine, incomplete, or the user does not need help. "
            "If someone asks the user a substantive question, usually provide a concise suggested answer.\n\n"
            f"NEWEST SPEECH:\n{new_transcript or ''}\n\n"
            f"LAST FEW UTTERANCES:\n{transcript}"
        )

        if time.monotonic() < self.api_blocked_until:
            try:
                text, ollama_model = self._request_ollama(prompt)
                provider = f"Ollama · {ollama_model}"
            except Exception:
                return
        else:
            try:
                response = self.client.models.generate_content(
                    model=self.auto_model_name,
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        system_instruction=self.system_prompt,
                        thinking_config=types.ThinkingConfig(thinking_level="minimal"),
                        max_output_tokens=72,
                    ),
                )
                text = clean_text(response.text or "")
                provider = "Gemini Fast"
                self.api_backoff_seconds = 0.0
                self.api_blocked_until = 0.0
            except Exception as exc:
                message = str(exc).lower()
                if "429" in message or "quota" in message or "resource_exhausted" in message:
                    self.api_backoff_seconds = min(
                        300.0,
                        max(30.0, self.api_backoff_seconds * 2.0),
                    )
                    self.api_blocked_until = time.monotonic() + self.api_backoff_seconds
                try:
                    text, ollama_model = self._request_ollama(prompt)
                    provider = f"Ollama · {ollama_model}"
                except Exception:
                    return

        if not text or text.upper() == SILENT_MARKER:
            return

        if text.upper().startswith("[SEARCH]"):
            query = clean_text(text[len("[SEARCH]"):])
            emit("trace", {"message": f"external verification requested: {query}"})
            if not query:
                return
            threading.Thread(
                target=self._request_deep_search,
                args=(
                    query,
                    transcript,
                    request_sequence,
                    request_started_at,
                ),
                name="meeting-research",
                daemon=True,
            ).start()
            return

        emit("trace", {"message": f"fast coach answered via {provider}"})
        self._emit_advice(
            text,
            provider,
            "automatic",
            request_sequence,
            request_started_at,
        )

    def set_paused(self, paused: bool) -> None:
        if paused:
            self.paused_event.set()
            while True:
                try:
                    self.audio_queue.get_nowait()
                except queue.Empty:
                    break
            emit("status", {"state": "paused", "reason": "Listening and analysis paused."})
        else:
            self.paused_event.clear()
            emit("status", {"state": "connected", "reason": "Local Whisper is listening."})

    def set_output_speaking(self, speaking: bool) -> None:
        if speaking:
            self.output_speaking_event.set()
        else:
            self.output_speaking_event.clear()
            self.suppress_system_until = time.monotonic() + 0.45

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
    parser.add_argument("--interval", type=float, default=float(os.environ.get("ZOOM_COMPANION_INTERVAL", "4")))
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
            elif command_type == "pause":
                service.set_paused(True)
            elif command_type == "resume":
                service.set_paused(False)
            elif command_type == "output-speaking":
                service.set_output_speaking(bool(command.get("speaking")))
            elif command_type == "stop":
                break
    except KeyboardInterrupt:
        pass
    finally:
        service.stop()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
