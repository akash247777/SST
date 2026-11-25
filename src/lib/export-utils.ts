import type { LanguageMode, TranscriptionRecord } from '@/types/transcription';

export const LANGUAGE_MODES: Array<{
  id: LanguageMode;
  label: string;
  shortLabel: string;
  description: string;
}> = [
  {
    id: 'multilingual',
    label: 'Auto Multilingual (HI + EN)',
    shortLabel: 'HI + EN',
    description: 'Code-switched Hindi (Devanagari) & English in the same sentence',
  },
  {
    id: 'hinglish',
    label: 'Hinglish (Romanized)',
    shortLabel: 'Hinglish',
    description: 'Mixed Hindi & English written in Romanized Latin script',
  },
  {
    id: 'hi',
    label: 'Hindi (हिंदी)',
    shortLabel: 'HI',
    description: 'Dedicated Hindi transcription in Devanagari',
  },
  {
    id: 'en',
    label: 'English',
    shortLabel: 'EN',
    description: 'Dedicated English transcription',
  },
];

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function formatTimestampSrt(seconds: number): string {
  const msTotal = Math.max(0, Math.round(seconds * 1000));
  const hrs = Math.floor(msTotal / 3600000);
  const mins = Math.floor((msTotal % 3600000) / 60000);
  const secs = Math.floor((msTotal % 60000) / 1000);
  const ms = msTotal % 1000;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export function buildSrtContent(record: Pick<TranscriptionRecord, 'segments' | 'transcript' | 'durationSeconds'>): string {
  if (record.segments.length === 0) {
    return `1\n00:00:00,000 --> ${formatTimestampSrt(Math.max(record.durationSeconds, 2))}\n${record.transcript}\n`;
  }

  let cursor = 0;
  return record.segments
    .map((seg, index) => {
      const segLen = Math.max(seg.duration ?? seg.end - seg.start, 1.2);
      const start = seg.start > 0 || index === 0 ? seg.start : cursor;
      const end = Math.max(start + 0.5, seg.end > start ? seg.end : start + segLen);
      cursor = end;
      return `${index + 1}\n${formatTimestampSrt(start)} --> ${formatTimestampSrt(end)}\n${seg.text}`;
    })
    .join('\n\n')
    .concat('\n');
}

export function downloadTextFile(filename: string, content: string, mimeType = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
