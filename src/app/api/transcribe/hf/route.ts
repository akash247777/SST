import { metric } from '@vercel/functions';
import type { NextRequest } from 'next/server';

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const hfToken = process.env.HF_TOKEN?.trim();
  if (!hfToken) {
    return Response.json(
      {
        error:
          'HF_TOKEN is not configured. Use the Faster-Whisper Hugging Face Space backend or add HF_TOKEN in Vercel environment variables.',
        code: 'HF_NOT_CONFIGURED',
      },
      { status: 503 },
    );
  }

  const startedAt = performance.now();
  let outcome = 'success';
  const model = process.env.HF_WHISPER_MODEL?.trim() || 'openai/whisper-large-v3-turbo';

  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const mode = String(formData.get('mode') || 'multilingual');

    if (!(file instanceof Blob)) {
      return Response.json({ error: 'Missing audio file.' }, { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    if (bytes.byteLength === 0) {
      return Response.json({ error: 'Audio payload is empty.' }, { status: 400 });
    }

    const contentType = file.type || 'audio/wav';
    const response = await fetch(`https://router.huggingface.co/hf-inference/models/${model}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${hfToken}`,
        'Content-Type': contentType,
      },
      body: bytes,
    });

    if (!response.ok) {
      const errText = await response.text();
      outcome = response.status === 503 ? 'warming' : 'error';
      return Response.json(
        {
          error:
            response.status === 503
              ? 'Hugging Face Whisper model is warming up; please retry in a few seconds.'
              : `Hugging Face Inference API error (${response.status}): ${errText}`,
        },
        { status: response.status },
      );
    }

    const data = (await response.json()) as {
      text?: string;
      chunks?: Array<{ text?: string; timestamp?: [number, number | null] }>;
    };

    const text = (data.text || '').trim();
    const latencyMs = Math.round(performance.now() - startedAt);
    const hasDevanagari = /[\u0900-\u097F]/.test(text);
    const detectedLanguage = mode === 'hi' || hasDevanagari ? 'hi' : 'en';

    const segments = Array.isArray(data.chunks)
      ? data.chunks
          .filter((c) => c.text?.trim())
          .map((c) => ({
            start: c.timestamp?.[0] ?? 0,
            end: c.timestamp?.[1] ?? c.timestamp?.[0] ?? 0,
            text: (c.text || '').trim(),
          }))
      : text
        ? [{ start: 0, end: 0, text }]
        : [];

    return Response.json({
      text,
      language: detectedLanguage,
      languageProbability: 1,
      duration: 0,
      latencyMs,
      segments,
      model,
      engine: 'hf-inference',
    });
  } catch (err) {
    outcome = 'error';
    console.error('Hugging Face inference error:', err);
    return Response.json(
      { error: err instanceof Error ? err.message : 'Hugging Face transcription failed.' },
      { status: 500 },
    );
  } finally {
    metric('stt.transcribe', 1, { engine: 'hf-inference', outcome });
    metric('stt.duration_ms', performance.now() - startedAt, { engine: 'hf-inference', outcome });
  }
}
