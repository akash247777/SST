import { MongoClient, type Db } from 'mongodb';

export class DatabaseNotConfiguredError extends Error {
  constructor(message = 'MONGODB_URI environment variable is not configured.') {
    super(message);
    this.name = 'DatabaseNotConfiguredError';
  }
}

declare global {
  var __mongoClientPromise: Promise<MongoClient> | undefined;
  var __mongoIndexesReady: Promise<void> | undefined;
}

function getMongoUri(): string {
  const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
  if (!uri || !uri.trim()) {
    throw new DatabaseNotConfiguredError();
  }
  return uri.trim();
}

function getDatabaseName(): string {
  return process.env.MONGODB_DB?.trim() || 'sst_transcriptions';
}

export async function getMongoClient(): Promise<MongoClient> {
  const uri = getMongoUri();

  if (!globalThis.__mongoClientPromise) {
    const client = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
    globalThis.__mongoClientPromise = client.connect().catch((err) => {
      globalThis.__mongoClientPromise = undefined;
      throw err;
    });
  }

  return globalThis.__mongoClientPromise;
}

export async function getMongoDb(): Promise<Db> {
  const client = await getMongoClient();
  const db = client.db(getDatabaseName());

  if (!globalThis.__mongoIndexesReady) {
    globalThis.__mongoIndexesReady = db
      .collection('transcriptions')
      .createIndexes([
        { key: { isPinned: -1, createdAt: -1 } },
        { key: { languageMode: 1 } },
      ])
      .then(() => undefined)
      .catch((err) => {
        globalThis.__mongoIndexesReady = undefined;
        console.error('Failed ensuring MongoDB indexes:', err);
      });
  }

  await globalThis.__mongoIndexesReady;
  return db;
}
