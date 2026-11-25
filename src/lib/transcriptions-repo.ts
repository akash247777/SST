import { ObjectId, type Filter, type WithId, type Document } from 'mongodb';
import { getCollectionName, getMongoDb } from './mongodb';
import type {
  CreateTranscriptionInput,
  LanguageMode,
  SttEngine,
  TranscriptSegment,
  TranscriptionRecord,
  TranscriptionStats,
  UpdateTranscriptionInput,
} from '@/types/transcription';

const SST_RECORD_TYPE = 'sst_transcription';
const SST_SCOPE_FILTER = { recordType: SST_RECORD_TYPE } as const;
const VALID_MODES = new Set<LanguageMode>(['multilingual', 'hinglish', 'hi', 'en']);
const VALID_ENGINES = new Set<SttEngine>(['faster-whisper', 'hf-inference']);

interface TranscriptionDocument extends Document {
  _id: ObjectId;
  recordType: string;
  title: string;
  transcript: string;
  segments: TranscriptSegment[];
  languageMode: LanguageMode;
  detectedLanguages: string[];
  engine: SttEngine;
  model: string;
  durationSeconds: number;
  wordCount: number;
  isPinned: boolean;
  tags: string[];
  notes: string;
  createdAt: Date;
  updatedAt: Date;
}

export function normalizeLanguageMode(mode?: string): LanguageMode {
  if (mode && VALID_MODES.has(mode as LanguageMode)) {
    return mode as LanguageMode;
  }
  return 'multilingual';
}

export function normalizeEngine(engine?: string): SttEngine {
  if (engine && VALID_ENGINES.has(engine as SttEngine)) {
    return engine as SttEngine;
  }
  return 'faster-whisper';
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function deriveTitle(transcript: string, explicitTitle?: string): string {
  const cleanExplicit = explicitTitle?.trim();
  if (cleanExplicit) return cleanExplicit.slice(0, 120);

  const normalized = transcript.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Untitled Transcription';
  if (normalized.length <= 58) return normalized;
  const sliced = normalized.slice(0, 58);
  const lastSpace = sliced.lastIndexOf(' ');
  return `${(lastSpace > 24 ? sliced.slice(0, lastSpace) : sliced).trim()}…`;
}

export function normalizeTags(tags?: string[]): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const clean = String(tag).trim().toLowerCase().slice(0, 32);
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out.slice(0, 12);
}

export function inferDetectedLanguages(
  transcript: string,
  segments: TranscriptSegment[],
  explicit?: string[],
): string[] {
  const langs = new Set<string>();
  if (Array.isArray(explicit)) {
    for (const l of explicit) {
      const clean = String(l).trim().toLowerCase();
      if (clean) langs.add(clean);
    }
  }
  for (const seg of segments) {
    if (seg.language) langs.add(seg.language.toLowerCase());
  }
  if (/[\u0900-\u097F]/.test(transcript)) {
    langs.add('hi');
  }
  if (/[A-Za-z]{2,}/.test(transcript)) {
    langs.add('en');
  }
  return Array.from(langs);
}

function serializeDoc(doc: WithId<TranscriptionDocument>): TranscriptionRecord {
  return {
    id: doc._id.toHexString(),
    title: doc.title,
    transcript: doc.transcript,
    segments: Array.isArray(doc.segments) ? doc.segments : [],
    languageMode: normalizeLanguageMode(doc.languageMode),
    detectedLanguages: Array.isArray(doc.detectedLanguages) ? doc.detectedLanguages : [],
    engine: normalizeEngine(doc.engine),
    model: doc.model || 'small',
    durationSeconds: Number(doc.durationSeconds || 0),
    wordCount: Number(doc.wordCount ?? countWords(doc.transcript || '')),
    isPinned: Boolean(doc.isPinned),
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    notes: doc.notes || '',
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : new Date(doc.createdAt).toISOString(),
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : new Date(doc.updatedAt).toISOString(),
  };
}

export async function listTranscriptions(params: {
  q?: string;
  mode?: string;
  pinned?: boolean;
  limit?: number;
}): Promise<{ items: TranscriptionRecord[]; stats: TranscriptionStats }> {
  const db = await getMongoDb();
  const col = db.collection<TranscriptionDocument>(getCollectionName());

  const filter: Filter<TranscriptionDocument> = { ...SST_SCOPE_FILTER };
  if (params.mode && VALID_MODES.has(params.mode as LanguageMode)) {
    filter.languageMode = params.mode as LanguageMode;
  }
  if (typeof params.pinned === 'boolean') {
    filter.isPinned = params.pinned;
  }
  if (params.q && params.q.trim()) {
    const escaped = params.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    filter.$or = [{ title: regex }, { transcript: regex }, { notes: regex }, { tags: regex }];
  }

  const limit = Math.min(Math.max(params.limit ?? 60, 1), 150);

  const [docs, aggRows] = await Promise.all([
    col.find(filter).sort({ isPinned: -1, createdAt: -1 }).limit(limit).toArray(),
    col
      .aggregate<{
        totalCount: number;
        pinnedCount: number;
        totalWords: number;
        totalDurationSeconds: number;
        languageLists: string[][];
      }>([
        { $match: SST_SCOPE_FILTER },
        {
          $group: {
            _id: null,
            totalCount: { $sum: 1 },
            pinnedCount: { $sum: { $cond: ['$isPinned', 1, 0] } },
            totalWords: { $sum: '$wordCount' },
            totalDurationSeconds: { $sum: '$durationSeconds' },
            languageLists: { $push: '$detectedLanguages' },
          },
        },
      ])
      .toArray(),
  ]);

  const agg = aggRows[0];
  const langSet = new Set<string>();
  if (agg?.languageLists) {
    for (const arr of agg.languageLists) {
      if (Array.isArray(arr)) {
        for (const l of arr) langSet.add(l);
      }
    }
  }

  return {
    items: docs.map(serializeDoc),
    stats: {
      totalCount: agg?.totalCount ?? 0,
      pinnedCount: agg?.pinnedCount ?? 0,
      totalWords: agg?.totalWords ?? 0,
      totalDurationSeconds: Math.round((agg?.totalDurationSeconds ?? 0) * 10) / 10,
      languages: Array.from(langSet),
    },
  };
}

export async function getTranscriptionById(id: string): Promise<TranscriptionRecord | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getMongoDb();
  const doc = await db
    .collection<TranscriptionDocument>(getCollectionName())
    .findOne({ _id: new ObjectId(id), ...SST_SCOPE_FILTER });
  return doc ? serializeDoc(doc) : null;
}

export async function createTranscription(input: CreateTranscriptionInput): Promise<TranscriptionRecord> {
  const db = await getMongoDb();
  const col = db.collection<TranscriptionDocument>(getCollectionName());

  const segments = Array.isArray(input.segments) ? input.segments : [];
  const transcript = (
    input.transcript?.trim() ||
    segments
      .map((s) => s.text?.trim())
      .filter(Boolean)
      .join(' ')
  ).trim();

  if (!transcript) {
    throw new Error('Transcript text cannot be empty.');
  }

  const now = new Date();
  const doc: Omit<TranscriptionDocument, '_id'> = {
    recordType: SST_RECORD_TYPE,
    title: deriveTitle(transcript, input.title),
    transcript,
    segments,
    languageMode: normalizeLanguageMode(input.languageMode),
    detectedLanguages: inferDetectedLanguages(transcript, segments, input.detectedLanguages),
    engine: normalizeEngine(input.engine),
    model: input.model?.trim() || 'small',
    durationSeconds: Math.max(0, Number(input.durationSeconds || 0)),
    wordCount: countWords(transcript),
    isPinned: Boolean(input.isPinned),
    tags: normalizeTags(input.tags),
    notes: input.notes?.trim() || '',
    createdAt: now,
    updatedAt: now,
  };

  const result = await col.insertOne(doc as TranscriptionDocument);
  const created = await col.findOne({ _id: result.insertedId });
  if (!created) {
    throw new Error('Failed retrieving inserted transcription.');
  }
  return serializeDoc(created);
}

export async function updateTranscription(
  id: string,
  input: UpdateTranscriptionInput,
): Promise<TranscriptionRecord | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getMongoDb();
  const col = db.collection<TranscriptionDocument>(getCollectionName());

  const existing = await col.findOne({ _id: new ObjectId(id), ...SST_SCOPE_FILTER });
  if (!existing) return null;

  const updateFields: Partial<TranscriptionDocument> = {
    updatedAt: new Date(),
  };

  if (typeof input.title === 'string') {
    updateFields.title = deriveTitle(input.transcript ?? existing.transcript, input.title);
  }
  if (typeof input.transcript === 'string') {
    const cleanText = input.transcript.trim();
    if (!cleanText) {
      throw new Error('Transcript text cannot be empty.');
    }
    updateFields.transcript = cleanText;
    updateFields.wordCount = countWords(cleanText);
    updateFields.detectedLanguages = inferDetectedLanguages(
      cleanText,
      input.segments ?? existing.segments,
      input.detectedLanguages,
    );
  } else if (Array.isArray(input.detectedLanguages)) {
    updateFields.detectedLanguages = inferDetectedLanguages(
      existing.transcript,
      input.segments ?? existing.segments,
      input.detectedLanguages,
    );
  }
  if (Array.isArray(input.segments)) {
    updateFields.segments = input.segments;
  }
  if (typeof input.languageMode === 'string') {
    updateFields.languageMode = normalizeLanguageMode(input.languageMode);
  }
  if (typeof input.isPinned === 'boolean') {
    updateFields.isPinned = input.isPinned;
  }
  if (Array.isArray(input.tags)) {
    updateFields.tags = normalizeTags(input.tags);
  }
  if (typeof input.notes === 'string') {
    updateFields.notes = input.notes.trim();
  }

  const updated = await col.findOneAndUpdate(
    { _id: new ObjectId(id), ...SST_SCOPE_FILTER },
    { $set: updateFields },
    { returnDocument: 'after' },
  );

  return updated ? serializeDoc(updated) : null;
}

export async function deleteTranscription(id: string): Promise<boolean> {
  if (!ObjectId.isValid(id)) return false;
  const db = await getMongoDb();
  const res = await db
    .collection<TranscriptionDocument>(getCollectionName())
    .deleteOne({ _id: new ObjectId(id), ...SST_SCOPE_FILTER });
  return res.deletedCount === 1;
}
