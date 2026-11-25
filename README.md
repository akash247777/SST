# VaaniFlow SST — Real-Time Multilingual Speech-to-Text

Real-time multilingual Speech-to-Text web application supporting live code-switched **Hindi + English / Hinglish** transcription powered by **`faster-whisper`**, **Hugging Face Spaces**, **Next.js 16 (Vercel)**, and **MongoDB**.

## Architecture

- **Frontend & CRUD API (`/`)**: Next.js 16 App Router + TypeScript + Tailwind CSS deployed on **Vercel**.
  - **Live Studio**: Captures 16 kHz mono PCM via Web Audio `AudioWorklet`, streams audio frames over WebSocket to `faster-whisper`, shows real-time interim updates + VAD-committed final sentences, and supports audio file upload + optional Hugging Face Inference API mode (`HF_TOKEN`).
  - **History Dashboard**: Full **MongoDB CRUD** (`GET`, `POST`, `PATCH`, `DELETE`) with search, mode filters, pinned sessions, segment breakdowns, inline editing, and `.txt` / `.srt` / `.json` export.
- **Inference Backend (`backend/`)**: FastAPI + `faster-whisper` + CTranslate2 + Silero VAD packaged both as a Docker service ([backend/Dockerfile](backend/Dockerfile)) and as a Hugging Face Gradio + ZeroGPU Space ([backend/hf_space/app.py](backend/hf_space/app.py), port `7860`).

## Environment Variables (Vercel / `.env.local`)

```env
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=sst_transcriptions
NEXT_PUBLIC_WHISPER_SERVER_URL=https://<your-hf-space>.hf.space
HF_TOKEN=
```

## Local Development

### 1. Start the `faster-whisper` Python backend

```bash
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 7860
```

### 2. Start the Next.js web app

```bash
npm install
cp .env.example .env.local
# Fill MONGODB_URI in .env.local
npm run dev
```

Open `http://localhost:3000`.
