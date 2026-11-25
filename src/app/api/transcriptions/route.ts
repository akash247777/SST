import { metric } from '@vercel/functions';
import type { NextRequest } from 'next/server';
import { DatabaseNotConfiguredError } from '@/lib/mongodb';
import { createTranscription, listTranscriptions } from '@/lib/transcriptions-repo';
import type { CreateTranscriptionInput } from '@/types/transcription';

function errorResponse(err: unknown, fallbackMessage: string) {
  console.error(fallbackMessage, err);
  if (err instanceof DatabaseNotConfiguredError) {
    return Response.json(
      { error: err.message, code: 'DB_NOT_CONFIGURED' },
      { status: 503 },
    );
  }
  const message = err instanceof Error ? err.message : fallbackMessage;
  const status = message.includes('cannot be empty') ? 400 : 500;
  return Response.json({ error: message }, { status });
}

export async function GET(request: NextRequest) {
  const startedAt = performance.now();
  let outcome = 'success';

  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q') ?? undefined;
    const mode = searchParams.get('mode') ?? undefined;
    const pinnedParam = searchParams.get('pinned');
    const pinned = pinnedParam === 'true' ? true : pinnedParam === 'false' ? false : undefined;
    const limitParam = searchParams.get('limit');
    const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;

    const result = await listTranscriptions({
      q,
      mode,
      pinned,
      limit: Number.isFinite(limit) ? limit : undefined,
    });

    return Response.json(result);
  } catch (err) {
    outcome = 'error';
    return errorResponse(err, 'Failed to list transcriptions.');
  } finally {
    metric('transcriptions.list', 1, { outcome });
    metric('transcriptions.db_duration_ms', performance.now() - startedAt, {
      operation: 'list',
      outcome,
    });
  }
}

export async function POST(request: NextRequest) {
  const startedAt = performance.now();
  let outcome = 'success';

  try {
    const body = (await request.json()) as CreateTranscriptionInput;
    const created = await createTranscription(body);
    return Response.json({ item: created }, { status: 201 });
  } catch (err) {
    outcome = 'error';
    return errorResponse(err, 'Failed to save transcription.');
  } finally {
    metric('transcriptions.created', 1, { outcome });
    metric('transcriptions.db_duration_ms', performance.now() - startedAt, {
      operation: 'create',
      outcome,
    });
  }
}
