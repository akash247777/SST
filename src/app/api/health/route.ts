import { connection } from 'next/server';
import {
  DatabaseNotConfiguredError,
  getCollectionName,
  getDatabaseName,
  getMongoDb,
} from '@/lib/mongodb';

export async function GET() {
  await connection();

  let dbStatus: 'connected' | 'unconfigured' | 'error' = 'unconfigured';
  let dbError: string | null = null;

  try {
    const db = await getMongoDb();
    await db.command({ ping: 1 });
    dbStatus = 'connected';
  } catch (err) {
    if (err instanceof DatabaseNotConfiguredError) {
      dbStatus = 'unconfigured';
      dbError = err.message;
    } else {
      dbStatus = 'error';
      dbError = err instanceof Error ? err.message : 'MongoDB connection failed.';
    }
  }

  const whisperServerUrl = (
    process.env.WHISPER_SERVER_URL ||
    process.env.NEXT_PUBLIC_WHISPER_SERVER_URL ||
    'http://localhost:7860'
  ).replace(/\/+$/, '');

  return Response.json({
    ok: dbStatus === 'connected',
    dbStatus,
    dbError,
    dbName: getDatabaseName(),
    collectionName: getCollectionName(),
    whisperServerUrl,
    hfConfigured: Boolean(process.env.HF_TOKEN?.trim()),
    hfModel: process.env.HF_WHISPER_MODEL?.trim() || 'openai/whisper-large-v3-turbo',
  });
}
