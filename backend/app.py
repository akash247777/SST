from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import av
import ctranslate2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("sst-backend")

SAMPLE_RATE = 16000
MAX_UTTERANCE_SECONDS = 14.0
MIN_SPEECH_SECONDS = 0.35
PRE_ROLL_SECONDS = 0.32
DEFAULT_SILENCE_MS = 750
DEFAULT_INTERIM_MS = 700
DEFAULT_VAD_RMS = 0.011

HALLUCINATION_EXACT = {
    "thank you",
    "thank you.",
    "thanks for watching",
    "thanks for watching.",
    "you",
    "bye",
    "bye.",
    "subtitles by",
    "amara.org",
    "thank you for watching",
    "thank you for watching.",
    "धन्यवाद",
    "धन्यवाद।",
}


@dataclass(frozen=True)
class ModeProfile:
    language: str | None
    initial_prompt: str
    label: str


MODE_PROFILES: dict[str, ModeProfile] = {
    "multilingual": ModeProfile(
        language=None,
        initial_prompt=(
            "नमस्ते, आज की meeting में हम AI, technology, और daily work updates "
            "के बारे में Hindi और English दोनों में बात करेंगे। Let's begin."
        ),
        label="Auto Multilingual (Hindi + English)",
    ),
    "hinglish": ModeProfile(
        language="en",
        initial_prompt=(
            "Namaste, aaj hum Hindi aur English mix karke Hinglish mein baat kar rahe hain. "
            "Kal office mein meeting hai, so please update the report on time."
        ),
        label="Hinglish (Romanized)",
    ),
    "hi": ModeProfile(
        language="hi",
        initial_prompt="नमस्ते, कृपया बोले गए वाक्यों को स्पष्ट हिंदी देवनागरी में लिखें।",
        label="Hindi (Devanagari)",
    ),
    "en": ModeProfile(
        language="en",
        initial_prompt="Hello, please transcribe the spoken audio accurately in English.",
        label="English",
    ),
}


def decode_audio_bytes(raw_bytes: bytes) -> np.ndarray:
    """Decode any container/codec bytes into mono 16 kHz float32 PCM using PyAV."""
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    chunks: list[np.ndarray] = []

    with av.open(io.BytesIO(raw_bytes), mode="r") as container:
        audio_streams = [s for s in container.streams if s.type == "audio"]
        if not audio_streams:
            return np.zeros(0, dtype=np.float32)

        for frame in container.decode(audio=0):
            for resampled in resampler.resample(frame):
                arr = resampled.to_ndarray()
                chunks.append(arr.reshape(-1))

        # Flush remaining buffered frames from resampler
        for resampled in resampler.resample(None):
            arr = resampled.to_ndarray()
            chunks.append(arr.reshape(-1))

    if not chunks:
        return np.zeros(0, dtype=np.float32)

    pcm_int16 = np.concatenate(chunks).astype(np.float32) / 32768.0
    return pcm_int16


def resolve_device_and_compute() -> tuple[str, str]:
    requested_device = os.getenv("WHISPER_DEVICE", "auto").strip().lower()
    requested_compute = os.getenv("WHISPER_COMPUTE_TYPE", "auto").strip().lower()

    if requested_device == "auto":
        try:
            cuda_count = ctranslate2.get_cuda_device_count()
        except Exception:
            cuda_count = 0
        device = "cuda" if cuda_count > 0 else "cpu"
    else:
        device = requested_device

    if requested_compute == "auto":
        compute_type = "float16" if device == "cuda" else "int8"
    else:
        compute_type = requested_compute

    return device, compute_type


class WhisperEngine:
    def __init__(self) -> None:
        self.model_name = os.getenv("WHISPER_MODEL", "small")
        self.device, self.compute_type = resolve_device_and_compute()
        self.model: WhisperModel | None = None
        self.load_error: str | None = None
        self.infer_lock = asyncio.Lock()

    def load(self) -> WhisperModel:
        if self.model is not None:
            return self.model

        cpu_threads = int(os.getenv("WHISPER_CPU_THREADS", str(min(os.cpu_count() or 4, 8))))
        try:
            logger.info(
                "Loading faster-whisper model=%s device=%s compute_type=%s",
                self.model_name,
                self.device,
                self.compute_type,
            )
            model = WhisperModel(
                self.model_name,
                device=self.device,
                compute_type=self.compute_type,
                cpu_threads=cpu_threads,
            )
            if self.device != "cpu":
                # Verify CUDA runtime libraries (e.g. cublas/cudnn) actually execute inference
                probe_segs, _ = model.transcribe(
                    np.zeros(int(0.5 * SAMPLE_RATE), dtype=np.float32),
                    vad_filter=False,
                    beam_size=1,
                )
                list(probe_segs)
            self.model = model
            self.load_error = None
            return self.model
        except Exception as exc:
            if self.device != "cpu":
                logger.warning(
                    "Failed loading/running CUDA faster-whisper (%s); falling back to CPU int8",
                    exc,
                )
                self.device = "cpu"
                self.compute_type = "int8"
                self.model = WhisperModel(
                    self.model_name,
                    device="cpu",
                    compute_type="int8",
                    cpu_threads=cpu_threads,
                )
                self.load_error = None
                return self.model
            self.load_error = str(exc)
            raise

    def transcribe_array(
        self,
        audio: np.ndarray,
        mode: str = "multilingual",
        beam_size: int = 2,
    ) -> dict[str, Any]:
        model = self.load()
        profile = MODE_PROFILES.get(mode, MODE_PROFILES["multilingual"])

        started = time.perf_counter()
        segments_iter, info = model.transcribe(
            audio,
            language=profile.language,
            task="transcribe",
            beam_size=beam_size,
            best_of=1 if beam_size == 1 else 2,
            temperature=0.0,
            vad_filter=True,
            vad_parameters={
                "min_silence_duration_ms": 400,
                "speech_pad_ms": 180,
                "threshold": 0.42,
            },
            initial_prompt=profile.initial_prompt,
            condition_on_previous_text=False,
            no_speech_threshold=0.62,
            compression_ratio_threshold=2.2,
            log_prob_threshold=-1.0,
        )

        clean_segments: list[dict[str, Any]] = []
        text_parts: list[str] = []

        for seg in segments_iter:
            seg_text = re.sub(r"\s+", " ", seg.text).strip()
            if not seg_text:
                continue
            normalized = seg_text.lower().strip()
            if normalized in HALLUCINATION_EXACT and (seg.no_speech_prob > 0.35 or len(audio) < SAMPLE_RATE):
                continue
            if seg.no_speech_prob > 0.72 and seg.avg_logprob < -1.05:
                continue

            text_parts.append(seg_text)
            clean_segments.append(
                {
                    "start": round(float(seg.start), 2),
                    "end": round(float(seg.end), 2),
                    "text": seg_text,
                    "avgLogprob": round(float(seg.avg_logprob), 3),
                    "noSpeechProb": round(float(seg.no_speech_prob), 3),
                }
            )

        latency_ms = round((time.perf_counter() - started) * 1000)
        full_text = " ".join(text_parts).strip()
        detected_lang = profile.language or getattr(info, "language", "en") or "en"
        lang_prob = round(float(getattr(info, "language_probability", 1.0) or 1.0), 3)

        return {
            "text": full_text,
            "language": detected_lang,
            "languageProbability": lang_prob,
            "duration": round(len(audio) / SAMPLE_RATE, 2),
            "latencyMs": latency_ms,
            "segments": clean_segments,
            "model": self.model_name,
        }


engine = WhisperEngine()


@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        await asyncio.to_thread(engine.load)
        logger.info("faster-whisper engine ready (%s on %s)", engine.model_name, engine.device)
    except Exception as exc:
        logger.error("Startup model preload failed: %s", exc)
    yield


app = FastAPI(
    title="SST Faster-Whisper Multilingual Backend",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok" if engine.model is not None else "warming",
        "engine": "faster-whisper",
        "model": engine.model_name,
        "device": engine.device,
        "computeType": engine.compute_type,
        "error": engine.load_error,
        "modes": {key: val.label for key, val in MODE_PROFILES.items()},
    }


@app.post("/api/transcribe")
async def transcribe_file(
    file: UploadFile = File(...),
    mode: str = Form("multilingual"),
) -> dict[str, Any]:
    raw_bytes = await file.read()
    if not raw_bytes:
        raise HTTPException(status_code=400, detail="Uploaded audio file is empty.")

    try:
        audio = await asyncio.to_thread(decode_audio_bytes, raw_bytes)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not decode audio: {exc}") from exc

    if len(audio) == 0:
        return {
            "text": "",
            "language": mode if mode in {"hi", "en"} else "en",
            "languageProbability": 1.0,
            "duration": 0.0,
            "latencyMs": 0,
            "segments": [],
            "model": engine.model_name,
        }

    async with engine.infer_lock:
        result = await asyncio.to_thread(engine.transcribe_array, audio, mode, 2)
    return result


@app.websocket("/ws/transcribe")
async def websocket_transcribe(websocket: WebSocket) -> None:
    await websocket.accept()

    mode = websocket.query_params.get("mode", "multilingual")
    if mode not in MODE_PROFILES:
        mode = "multilingual"

    silence_ms = DEFAULT_SILENCE_MS
    interim_ms = DEFAULT_INTERIM_MS
    vad_rms = DEFAULT_VAD_RMS

    pre_roll = np.zeros(0, dtype=np.float32)
    pre_roll_max = int(PRE_ROLL_SECONDS * SAMPLE_RATE)
    active_audio = np.zeros(0, dtype=np.float32)

    speech_active = False
    silence_samples = 0
    samples_since_interim = 0
    last_interim_at = 0.0
    last_interim_text = ""

    await websocket.send_json(
        {
            "type": "ready",
            "engine": "faster-whisper",
            "model": engine.model_name,
            "device": engine.device,
            "mode": mode,
        }
    )

    async def run_transcription(audio_buf: np.ndarray, is_final: bool) -> None:
        nonlocal last_interim_text
        if len(audio_buf) < int(MIN_SPEECH_SECONDS * SAMPLE_RATE):
            return
        beam = 2 if is_final else 1
        async with engine.infer_lock:
            result = await asyncio.to_thread(engine.transcribe_array, audio_buf, mode, beam)

        text = result["text"]
        if not text:
            return

        if not is_final:
            if text == last_interim_text:
                return
            last_interim_text = text
            await websocket.send_json({"type": "interim", **result})
        else:
            last_interim_text = ""
            await websocket.send_json(
                {
                    "type": "final",
                    "id": str(uuid.uuid4()),
                    "mode": mode,
                    **result,
                }
            )

    async def finalize_active() -> None:
        nonlocal active_audio, speech_active, silence_samples, samples_since_interim, last_interim_text
        if len(active_audio) >= int(MIN_SPEECH_SECONDS * SAMPLE_RATE):
            buf_copy = active_audio.copy()
            active_audio = np.zeros(0, dtype=np.float32)
            speech_active = False
            silence_samples = 0
            samples_since_interim = 0
            await run_transcription(buf_copy, is_final=True)
        else:
            active_audio = np.zeros(0, dtype=np.float32)
            speech_active = False
            silence_samples = 0
            samples_since_interim = 0
            last_interim_text = ""

    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break

            if "text" in message and message["text"] is not None:
                try:
                    payload = json.loads(message["text"])
                except json.JSONDecodeError:
                    continue

                msg_type = payload.get("type")
                if msg_type == "config":
                    next_mode = payload.get("mode")
                    if next_mode in MODE_PROFILES:
                        mode = next_mode
                    if isinstance(payload.get("silenceMs"), (int, float)):
                        silence_ms = max(350, min(2500, int(payload["silenceMs"])))
                    if isinstance(payload.get("interimMs"), (int, float)):
                        interim_ms = max(350, min(2000, int(payload["interimMs"])))
                    if isinstance(payload.get("vadRms"), (int, float)):
                        vad_rms = max(0.002, min(0.08, float(payload["vadRms"])))
                    await websocket.send_json({"type": "config_ack", "mode": mode})
                elif msg_type == "flush":
                    await finalize_active()
                    await websocket.send_json({"type": "flushed"})
                elif msg_type == "ping":
                    await websocket.send_json({"type": "pong", "ts": time.time()})
                continue

            raw_bytes = message.get("bytes")
            if not raw_bytes:
                continue

            pcm_int16 = np.frombuffer(raw_bytes, dtype=np.int16)
            if pcm_int16.size == 0:
                continue
            chunk = pcm_int16.astype(np.float32) / 32768.0
            rms = float(np.sqrt(np.mean(np.square(chunk))))

            if not speech_active:
                pre_roll = np.concatenate([pre_roll, chunk])
                if len(pre_roll) > pre_roll_max:
                    pre_roll = pre_roll[-pre_roll_max:]

                if rms >= vad_rms:
                    speech_active = True
                    silence_samples = 0
                    active_audio = np.concatenate([pre_roll, chunk])
                    pre_roll = np.zeros(0, dtype=np.float32)
                    samples_since_interim = len(active_audio)
                    last_interim_at = time.monotonic()
            else:
                active_audio = np.concatenate([active_audio, chunk])
                samples_since_interim += len(chunk)

                if rms >= vad_rms:
                    silence_samples = 0
                else:
                    silence_samples += len(chunk)

                silence_limit = int((silence_ms / 1000.0) * SAMPLE_RATE)
                max_samples = int(MAX_UTTERANCE_SECONDS * SAMPLE_RATE)

                if silence_samples >= silence_limit or len(active_audio) >= max_samples:
                    await finalize_active()
                else:
                    now = time.monotonic()
                    if (
                        (now - last_interim_at) * 1000.0 >= interim_ms
                        and samples_since_interim >= int(0.35 * SAMPLE_RATE)
                    ):
                        last_interim_at = now
                        samples_since_interim = 0
                        await run_transcription(active_audio.copy(), is_final=False)
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.exception("WebSocket error: %s", exc)
        try:
            await websocket.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass
