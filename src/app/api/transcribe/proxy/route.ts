import { metric } from '@vercel/functions';
import type { NextRequest } from 'next/server';

export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const startedAt = performance.now();
  let outcome = 'success';
  const baseUrl = (
    process.env.WHISPER_SERVER_URL ||
    process.env.NEXT_PUBLIC_WHISPER_SERVER_URL ||
    'http://localhost:7860'
  ).replace(/\/+$/, '');

  try {
    const incoming = await request.formData();
    const file = incoming.get('file');
    const mode = String(incoming.get('mode') || 'multilingual');

    if (!(file instanceof Blob)) {
      return Response.json({ error: 'Missing audio file.' }, { status: 400 });
    }

    const outbound = new FormData();
    outbound.append('file', file, file instanceof File ? file.name : 'audio.wav');
    outbound.append('mode', mode);

    const res = await fetch(`${baseUrl}/api/transcribe`, {
      method: 'POST',
      body: outbound,
    });

    const data = await res.json().catch(() => ({ error: 'Invalid response from Faster-Whisper backend.' }));
    if (!res.ok) {
      outcome = 'error';
      return Response.json(data, { status: res.status });
    }

    return Response.json({ ...data, engine: 'faster-whisper' });
  } catch (err) {
    outcome = 'error';
    console.error('Faster-Whisper HTTP proxy error:', err);
    return Response.json(
      {
        error: `Could not reach Faster-Whisper backend at ${baseUrl}. Ensure the Hugging Face Space or local FastAPI server is running.`,
      },
      { status: 502 },
    );
  } finally {
    metric('stt.transcribe', 1, { engine: 'faster-whisper', outcome });
    metric('stt.duration_ms', performance.now() - startedAt, { engine: 'faster-whisper', outcome });
  }
}
