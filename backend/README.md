---
title: SST Faster-Whisper Multilingual
emoji: 🎙️
colorFrom: indigo
colorTo: emerald
sdk: docker
app_port: 7860
pinned: false
---

# SST — Real-Time Multilingual `faster-whisper` Backend

FastAPI + `faster-whisper` WebSocket and HTTP speech-to-text service tuned for real-time multilingual code-switching (Hindi + English / Hinglish).

## Endpoints

- `GET /health` — Engine status, loaded model, compute device, and supported language modes
- `WS /ws/transcribe` — Real-time 16 kHz mono Int16 PCM audio streaming with interim & VAD-committed final transcripts
- `POST /api/transcribe` — Multipart audio file transcription
