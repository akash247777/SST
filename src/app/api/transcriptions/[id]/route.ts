import { metric } from '@vercel/functions';
import type { NextRequest } from 'next/server';
import { ObjectId } from 'mongodb';
import { DatabaseNotConfiguredError } from '@/lib/mongodb';
import {
  deleteTranscription,
  getTranscriptionById,
  updateTranscription,
} from '@/lib/transcriptions-repo';
import type { UpdateTranscriptionInput } from '@/types/transcription';

function handleRouteError(err: unknown, fallback: string) {
  console.error(fallback, err);
  if (err instanceof DatabaseNotConfiguredError) {
    return Response.json(
      { error: err.message, code: 'DB_NOT_CONFIGURED' },
      { status: 503 },
    );
  }
  const message = err instanceof Error ? err.message : fallback;
  const status = message.includes('cannot be empty') ? 400 : 500;
  return Response.json({ error: message }, { status });
}

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: RouteCtx) {
  const { id } = await ctx.params;
  if (!ObjectId.isValid(id)) {
    return Response.json({ error: 'Invalid transcription ID.' }, { status: 400 });
  }

  try {
    const item = await getTranscriptionById(id);
    if (!item) {
      return Response.json({ error: 'Transcription not found.' }, { status: 404 });
    }
    return Response.json({ item });
  } catch (err) {
    return handleRouteError(err, 'Failed to load transcription.');
  }
}

export async function PATCH(request: NextRequest, ctx: RouteCtx) {
  const { id } = await ctx.params;
  if (!ObjectId.isValid(id)) {
    return Response.json({ error: 'Invalid transcription ID.' }, { status: 400 });
  }

  const startedAt = performance.now();
  let outcome = 'success';

  try {
    const body = (await request.json()) as UpdateTranscriptionInput;
    const updated = await updateTranscription(id, body);
    if (!updated) {
      outcome = 'not_found';
      return Response.json({ error: 'Transcription not found.' }, { status: 404 });
    }
    return Response.json({ item: updated });
  } catch (err) {
    outcome = 'error';
    return handleRouteError(err, 'Failed to update transcription.');
  } finally {
    metric('transcriptions.updated', 1, { outcome });
    metric('transcriptions.db_duration_ms', performance.now() - startedAt, {
      operation: 'update',
      outcome,
    });
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  const { id } = await ctx.params;
  if (!ObjectId.isValid(id)) {
    return Response.json({ error: 'Invalid transcription ID.' }, { status: 400 });
  }

  const startedAt = performance.now();
  let outcome = 'success';

  try {
    const deleted = await deleteTranscription(id);
    if (!deleted) {
      outcome = 'not_found';
      return Response.json({ error: 'Transcription not found.' }, { status: 404 });
    }
    return Response.json({ deleted: true, id });
  } catch (err) {
    outcome = 'error';
    return handleRouteError(err, 'Failed to delete transcription.');
  } finally {
    metric('transcriptions.deleted', 1, { outcome });
    metric('transcriptions.db_duration_ms', performance.now() - startedAt, {
      operation: 'delete',
      outcome,
    });
  }
}
