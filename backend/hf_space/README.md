---
title: Speech To Text
emoji: 🎙️
colorFrom: blue
colorTo: gray
sdk: gradio
sdk_version: 5.9.1
python_version: "3.10"
app_file: app.py
pinned: false
short_description: Real-time multilingual Speech-to-Text using Faster Whisper.
---

# Voice Agent & VaaniFlow SST — Multilingual Speech to Text

Real-time multilingual Speech-to-Text service (Hindi, English, and mixed Hinglish) powered by **Faster Whisper**, **FastAPI WebSockets**, and **Gradio**.

## Endpoints

- `GET /health` — Engine status, loaded model, compute device, and supported modes
- `WS /ws/transcribe` — Real-time 16 kHz mono Int16 PCM audio streaming with interim & VAD-committed final transcripts
- `POST /api/transcribe` — Multipart audio file transcription with segment metadata
- `POST /transcribe` — Legacy single-file endpoint (`text`, `transcript`, `language`)
- `/` — Interactive Gradio interface (`api_name="predict"`)
