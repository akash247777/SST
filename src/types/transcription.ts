export type LanguageMode = 'multilingual' | 'hinglish' | 'hi' | 'en';

export type SttEngine = 'faster-whisper' | 'hf-inference';

export interface TranscriptSegment {
  id: string;
  text: string;
  language: string;
  languageProbability: number;
  start: number;
  end: number;
  duration?: number;
  latencyMs?: number;
  createdAt: string;
}

export interface TranscriptionRecord {
  id: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptionStats {
  totalCount: number;
  pinnedCount: number;
  totalWords: number;
  totalDurationSeconds: number;
  languages: string[];
}

export interface CreateTranscriptionInput {
  title?: string;
  transcript: string;
  segments?: TranscriptSegment[];
  languageMode?: LanguageMode;
  detectedLanguages?: string[];
  engine?: SttEngine;
  model?: string;
  durationSeconds?: number;
  isPinned?: boolean;
  tags?: string[];
  notes?: string;
}

export interface UpdateTranscriptionInput {
  title?: string;
  transcript?: string;
  segments?: TranscriptSegment[];
  languageMode?: LanguageMode;
  detectedLanguages?: string[];
  isPinned?: boolean;
  tags?: string[];
  notes?: string;
}
