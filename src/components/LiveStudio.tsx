'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Database,
  Download,
  FileAudio,
  Globe,
  Loader2,
  Mic,
  RefreshCw,
  Save,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  encodeWavBlob,
  float32ToInt16,
  httpToWsUrl,
  startMicrophonePcmStream,
  TARGET_SAMPLE_RATE,
  type MicStreamHandle,
} from '@/lib/audio-stream';
import {
  buildSrtContent,
  downloadTextFile,
  formatDuration,
  LANGUAGE_MODES,
} from '@/lib/export-utils';
import type {
  CreateTranscriptionInput,
  LanguageMode,
  SttEngine,
  TranscriptSegment,
  TranscriptionRecord,
} from '@/types/transcription';

export interface BackendHealthInfo {
  status: 'online' | 'warming' | 'offline' | 'checking';
  model?: string;
  device?: string;
  computeType?: string;
  error?: string | null;
}

interface LiveStudioProps {
  whisperServerUrl: string;
  onWhisperServerUrlChange: (nextUrl: string) => void;
  backendHealth: BackendHealthInfo;
  onRecheckBackend: () => void;
  hfConfigured: boolean;
  dbConnected: boolean;
  onSaveTranscription: (payload: CreateTranscriptionInput) => Promise<TranscriptionRecord | null>;
}

const DEFAULT_BARS = Array.from({ length: 28 }, () => 8);

export function LiveStudio({
  whisperServerUrl,
  onWhisperServerUrlChange,
  backendHealth,
  onRecheckBackend,
  hfConfigured,
  dbConnected,
  onSaveTranscription,
}: LiveStudioProps) {
  const [mode, setMode] = useState<LanguageMode>('multilingual');
  const [engine, setEngine] = useState<SttEngine>('faster-whisper');
  const [isRecording, setIsRecording] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isFlushing, setIsFlushing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [autoSave, setAutoSave] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [silenceMs, setSilenceMs] = useState(750);
  const [urlDraft, setUrlDraft] = useState(whisperServerUrl);

  const [title, setTitle] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [interimText, setInterimText] = useState('');
  const [interimLang, setInterimLang] = useState<string>('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [bars, setBars] = useState<number[]>(DEFAULT_BARS);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [activeModel, setActiveModel] = useState('small');

  const wsRef = useRef<WebSocket | null>(null);
  const micRef = useRef<MicStreamHandle | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const elapsedRef = useRef(0);
  const modeRef = useRef(mode);
  const engineRef = useRef(engine);
  const silenceMsRef = useRef(silenceMs);
  const autoSaveRef = useRef(autoSave);
  const titleRef = useRef(title);
  const tagsInputRef = useRef(tagsInput);

  // HF client-side VAD accumulator refs
  const hfPreRollRef = useRef<Float32Array>(new Float32Array(0));
  const hfActiveRef = useRef<Float32Array>(new Float32Array(0));
  const hfSpeakingRef = useRef(false);
  const hfSilenceSamplesRef = useRef(0);
  const hfInFlightRef = useRef(false);

  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);

  useEffect(() => {
    elapsedRef.current = elapsedSeconds;
  }, [elapsedSeconds]);

  useEffect(() => {
    modeRef.current = mode;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'config', mode, silenceMs: silenceMsRef.current }));
    }
  }, [mode]);

  useEffect(() => {
    engineRef.current = engine;
  }, [engine]);

  useEffect(() => {
    silenceMsRef.current = silenceMs;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'config', mode: modeRef.current, silenceMs }));
    }
  }, [silenceMs]);

  useEffect(() => {
    autoSaveRef.current = autoSave;
  }, [autoSave]);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    tagsInputRef.current = tagsInput;
  }, [tagsInput]);

  const fullTranscript = useMemo(() => {
    return segments
      .map((s) => s.text.trim())
      .filter(Boolean)
      .join(' ')
      .trim();
  }, [segments]);

  const detectedLanguages = useMemo(() => {
    const langs = new Set<string>();
    for (const seg of segments) {
      if (seg.language) langs.add(seg.language.toLowerCase());
    }
    if (/[\u0900-\u097F]/.test(fullTranscript)) langs.add('hi');
    if (/[A-Za-z]{2,}/.test(fullTranscript)) langs.add('en');
    return Array.from(langs);
  }, [segments, fullTranscript]);

  const wordCount = useMemo(() => {
    const combined = `${fullTranscript} ${interimText}`.trim();
    return combined ? combined.split(/\s+/).length : 0;
  }, [fullTranscript, interimText]);

  const appendFinalSegment = useCallback(
    (payload: {
      id?: string;
      text: string;
      language?: string;
      languageProbability?: number;
      duration?: number;
      latencyMs?: number;
      model?: string;
      segments?: Array<{ start?: number; end?: number }>;
    }) => {
      const cleanText = (payload.text || '').trim();
      if (!cleanText) return;

      const lastEnd =
        segmentsRef.current.length > 0
          ? segmentsRef.current[segmentsRef.current.length - 1].end
          : 0;
      const dur = Number(payload.duration ?? 0);
      const segStart = payload.segments?.[0]?.start ?? lastEnd;
      const segEnd = payload.segments?.[payload.segments.length - 1]?.end ?? segStart + dur;

      const nextSeg: TranscriptSegment = {
        id: payload.id || crypto.randomUUID(),
        text: cleanText,
        language: payload.language || 'en',
        languageProbability: Number(payload.languageProbability ?? 1),
        start: Number(segStart.toFixed(2)),
        end: Number(Math.max(segStart, segEnd).toFixed(2)),
        duration: dur,
        latencyMs: payload.latencyMs,
        createdAt: new Date().toISOString(),
      };

      if (payload.model) {
        setActiveModel(payload.model);
      }

      setInterimText('');
      setInterimLang('');
      setSegments((prev) => {
        const updated = [...prev, nextSeg];
        segmentsRef.current = updated;
        return updated;
      });
    },
    [],
  );

  const flushHfBuffer = useCallback(
    async (samples: Float32Array) => {
      if (samples.length < TARGET_SAMPLE_RATE * 0.4 || hfInFlightRef.current) {
        return;
      }
      hfInFlightRef.current = true;
      setInterimText('Processing speech chunk via Hugging Face...');
      try {
        const wavBlob = encodeWavBlob(samples, TARGET_SAMPLE_RATE);
        const form = new FormData();
        form.append('file', wavBlob, 'chunk.wav');
        form.append('mode', modeRef.current);

        const res = await fetch('/api/transcribe/hf', {
          method: 'POST',
          body: form,
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Hugging Face inference request failed.');
        }
        if (data.text) {
          appendFinalSegment({
            text: data.text,
            language: data.language,
            languageProbability: data.languageProbability,
            duration: samples.length / TARGET_SAMPLE_RATE,
            latencyMs: data.latencyMs,
            model: data.model,
            segments: data.segments,
          });
        } else {
          setInterimText('');
        }
      } catch (err) {
        setInterimText('');
        setStatusError(err instanceof Error ? err.message : 'Hugging Face transcription failed.');
      } finally {
        hfInFlightRef.current = false;
      }
    },
    [appendFinalSegment],
  );

  const saveCurrentSession = useCallback(
    async (silent = false) => {
      const text = segmentsRef.current
        .map((s) => s.text.trim())
        .filter(Boolean)
        .join(' ')
        .trim();
      if (!text) {
        if (!silent) setStatusError('Nothing to save yet — speak or upload an audio clip first.');
        return null;
      }
      setIsSaving(true);
      setStatusError(null);
      try {
        const parsedTags = tagsInputRef.current
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);

        const saved = await onSaveTranscription({
          title: titleRef.current.trim() || undefined,
          transcript: text,
          segments: segmentsRef.current,
          languageMode: modeRef.current,
          detectedLanguages: Array.from(
            new Set(segmentsRef.current.map((s) => s.language).filter(Boolean)),
          ),
          engine: engineRef.current,
          model: activeModel,
          durationSeconds: elapsedRef.current,
          tags: parsedTags,
        });

        if (saved) {
          setStatusNotice(`Saved "${saved.title}" to MongoDB.`);
        }
        return saved;
      } finally {
        setIsSaving(false);
      }
    },
    [activeModel, onSaveTranscription],
  );

  const stopRecording = useCallback(async () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (micRef.current) {
      await micRef.current.stop();
      micRef.current = null;
    }

    setBars(DEFAULT_BARS);
    setIsRecording(false);
    setIsConnecting(false);

    if (engineRef.current === 'faster-whisper' && wsRef.current) {
      const ws = wsRef.current;
      if (ws.readyState === WebSocket.OPEN) {
        setIsFlushing(true);
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            resolve();
          }, 2500);

          const onMessage = (event: MessageEvent) => {
            try {
              const msg = JSON.parse(String(event.data));
              if (msg.type === 'flushed') {
                clearTimeout(timeout);
                ws.removeEventListener('message', onMessage);
                resolve();
              }
            } catch {
              // ignore non-JSON
            }
          };

          ws.addEventListener('message', onMessage);
          ws.send(JSON.stringify({ type: 'flush' }));
        });
        setIsFlushing(false);
      }
      ws.close();
      wsRef.current = null;
    } else if (engineRef.current === 'hf-inference' && hfActiveRef.current.length > 0) {
      const pending = hfActiveRef.current;
      hfActiveRef.current = new Float32Array(0);
      hfSpeakingRef.current = false;
      hfSilenceSamplesRef.current = 0;
      await flushHfBuffer(pending);
    }

    setInterimText('');
    setInterimLang('');

    if (autoSaveRef.current && dbConnected && segmentsRef.current.length > 0) {
      await saveCurrentSession(true);
    }
  }, [dbConnected, flushHfBuffer, saveCurrentSession]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (micRef.current) {
        void micRef.current.stop();
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  const startRecording = async () => {
    setStatusError(null);
    setStatusNotice(null);

    if (engine === 'hf-inference' && !hfConfigured) {
      setStatusError('HF_TOKEN is not configured on the server. Switch to Faster-Whisper or add HF_TOKEN.');
      return;
    }

    setIsConnecting(true);

    try {
      if (engine === 'faster-whisper') {
        const wsUrl = `${httpToWsUrl(whisperServerUrl, '/ws/transcribe')}?mode=${encodeURIComponent(mode)}`;
        const ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';

        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(
              new Error(
                `Timed out connecting to Faster-Whisper WebSocket at ${wsUrl}. Check that the Hugging Face Space or local FastAPI server is awake.`,
              ),
            );
          }, 12000);

          ws.onopen = () => {
            clearTimeout(timer);
            ws.send(JSON.stringify({ type: 'config', mode, silenceMs }));
            resolve();
          };

          ws.onerror = () => {
            clearTimeout(timer);
            reject(new Error(`Could not connect to Faster-Whisper WebSocket at ${wsUrl}.`));
          };
        });

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(String(event.data));
            if (msg.type === 'ready') {
              if (msg.model) setActiveModel(msg.model);
            } else if (msg.type === 'interim') {
              setInterimText(msg.text || '');
              setInterimLang(msg.language || '');
            } else if (msg.type === 'final') {
              appendFinalSegment(msg);
            } else if (msg.type === 'error') {
              setStatusError(msg.message || 'Transcription stream error.');
            }
          } catch {
            // ignore
          }
        };

        ws.onclose = () => {
          if (wsRef.current === ws) {
            wsRef.current = null;
          }
        };

        wsRef.current = ws;
      }

      const handle = await startMicrophonePcmStream({
        onFrequencyData: (bins) => {
          const nextBars: number[] = [];
          const count = 28;
          for (let i = 0; i < count; i++) {
            const binVal = bins[i % bins.length] || 0;
            nextBars.push(Math.max(8, Math.round((binVal / 255) * 100)));
          }
          setBars(nextBars);
        },
        onPcmChunk: (samples16k, rms) => {
          if (engineRef.current === 'faster-whisper') {
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN) {
              const int16 = float32ToInt16(samples16k);
              ws.send(int16.buffer);
            }
          } else {
            // Client-side VAD chunking for Hugging Face Inference API
            const threshold = 0.014;
            const maxPreRoll = Math.round(0.25 * TARGET_SAMPLE_RATE);

            if (!hfSpeakingRef.current) {
              const mergedPre = new Float32Array(hfPreRollRef.current.length + samples16k.length);
              mergedPre.set(hfPreRollRef.current);
              mergedPre.set(samples16k, hfPreRollRef.current.length);
              hfPreRollRef.current =
                mergedPre.length > maxPreRoll ? mergedPre.slice(mergedPre.length - maxPreRoll) : mergedPre;

              if (rms >= threshold) {
                hfSpeakingRef.current = true;
                hfSilenceSamplesRef.current = 0;
                const combined = new Float32Array(hfPreRollRef.current.length + samples16k.length);
                combined.set(hfPreRollRef.current);
                combined.set(samples16k, hfPreRollRef.current.length);
                hfActiveRef.current = combined;
                hfPreRollRef.current = new Float32Array(0);
              }
            } else {
              const combined = new Float32Array(hfActiveRef.current.length + samples16k.length);
              combined.set(hfActiveRef.current);
              combined.set(samples16k, hfActiveRef.current.length);
              hfActiveRef.current = combined;

              if (rms >= threshold) {
                hfSilenceSamplesRef.current = 0;
              } else {
                hfSilenceSamplesRef.current += samples16k.length;
              }

              const silenceLimit = (silenceMsRef.current / 1000) * TARGET_SAMPLE_RATE;
              if (hfSilenceSamplesRef.current >= silenceLimit || hfActiveRef.current.length >= TARGET_SAMPLE_RATE * 10) {
                const payload = hfActiveRef.current;
                hfActiveRef.current = new Float32Array(0);
                hfSpeakingRef.current = false;
                hfSilenceSamplesRef.current = 0;
                void flushHfBuffer(payload);
              }
            }
          }
        },
      });

      micRef.current = handle;
      setIsRecording(true);
      setIsConnecting(false);

      timerRef.current = setInterval(() => {
        setElapsedSeconds((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      setIsConnecting(false);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setStatusError(
        err instanceof Error
          ? err.message
          : 'Microphone permission denied or Faster-Whisper server unreachable.',
      );
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setIsUploading(true);
    setStatusError(null);
    setStatusNotice(`Transcribing "${file.name}"...`);

    try {
      const form = new FormData();
      form.append('file', file);
      form.append('mode', mode);

      const endpoint =
        engine === 'hf-inference'
          ? '/api/transcribe/hf'
          : `${whisperServerUrl.replace(/\/+$/, '')}/api/transcribe`;

      const res = await fetch(endpoint, { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || data.detail || 'Audio file transcription failed.');
      }

      if (!data.text) {
        setStatusNotice('No speech detected in uploaded audio.');
        return;
      }

      appendFinalSegment(data);
      if (typeof data.duration === 'number') {
        setElapsedSeconds((prev) => prev + Math.round(data.duration));
      }
      if (!title.trim()) {
        setTitle(file.name.replace(/\.[^.]+$/, ''));
      }
      setStatusNotice(`Transcribed "${file.name}" (${data.latencyMs ?? 0}ms).`);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Upload transcription failed.');
      setStatusNotice(null);
    } finally {
      setIsUploading(false);
    }
  };

  const handleCopy = async () => {
    if (!fullTranscript) return;
    await navigator.clipboard.writeText(fullTranscript);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleClear = () => {
    setSegments([]);
    segmentsRef.current = [];
    setInterimText('');
    setInterimLang('');
    setTitle('');
    setTagsInput('');
    setElapsedSeconds(0);
    elapsedRef.current = 0;
    setStatusError(null);
    setStatusNotice(null);
  };

  const applyServerUrl = () => {
    const trimmed = urlDraft.trim().replace(/\/+$/, '');
    if (!trimmed) return;
    onWhisperServerUrlChange(trimmed);
    setShowSettings(false);
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* Left column: Mic Deck + Engine Controls */}
      <div className="space-y-5 lg:col-span-5">
        <section className="rounded-2xl border border-slate-800/90 bg-slate-900/70 p-5 shadow-2xl shadow-black/40 backdrop-blur">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-100">Live Audio Capture</h2>
              <p className="text-xs text-slate-400">
                Speak naturally in Hindi, English, or mixed Hinglish
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setUrlDraft(whisperServerUrl);
                setShowSettings((prev) => !prev);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700/80 bg-slate-800/80 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:border-indigo-500/50 hover:text-white"
            >
              <Settings2 className="h-3.5 w-3.5" />
              Backend
            </button>
          </div>

          {showSettings && (
            <div className="mb-5 space-y-3 rounded-xl border border-indigo-500/30 bg-slate-950/80 p-3.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-medium text-slate-200">Faster-Whisper Server URL</span>
                <button
                  type="button"
                  onClick={onRecheckBackend}
                  className="inline-flex items-center gap-1 text-indigo-400 hover:text-indigo-300"
                >
                  <RefreshCw className="h-3 w-3" />
                  Ping
                </button>
              </div>
              <div className="flex gap-2">
                <input
                  type="url"
                  value={urlDraft}
                  onChange={(e) => setUrlDraft(e.target.value)}
                  placeholder="https://your-space.hf.space or http://localhost:7860"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={applyServerUrl}
                  className="rounded-lg bg-indigo-600 px-3 py-1.5 font-medium text-white transition hover:bg-indigo-500"
                >
                  Apply
                </button>
              </div>
              <div>
                <div className="mb-1 flex justify-between text-slate-400">
                  <span>Pause commit delay (VAD)</span>
                  <span className="font-mono text-slate-200">{silenceMs} ms</span>
                </div>
                <input
                  type="range"
                  min={450}
                  max={1600}
                  step={50}
                  value={silenceMs}
                  onChange={(e) => setSilenceMs(Number(e.target.value))}
                  className="w-full accent-indigo-500"
                />
              </div>
              <label className="flex cursor-pointer items-center justify-between pt-1 text-slate-300">
                <span>Auto-save to MongoDB when stopped</span>
                <input
                  type="checkbox"
                  checked={autoSave}
                  onChange={(e) => setAutoSave(e.target.checked)}
                  className="h-4 w-4 accent-indigo-500"
                />
              </label>
            </div>
          )}

          {/* Waveform + Big Mic CTA */}
          <div className="flex flex-col items-center rounded-xl border border-slate-800/80 bg-slate-950/70 px-4 py-6">
            <div className="mb-5 flex h-16 w-full items-end justify-center gap-1 px-2">
              {bars.map((height, idx) => (
                <span
                  key={idx}
                  className={`w-1.5 rounded-full transition-all duration-75 ${
                    isRecording
                      ? 'bg-gradient-to-t from-indigo-500 via-violet-400 to-emerald-400'
                      : 'bg-slate-800'
                  }`}
                  style={{ height: `${Math.min(100, height)}%` }}
                />
              ))}
            </div>

            <div className="relative">
              {isRecording && (
                <span className="absolute -inset-2 animate-ping rounded-full bg-rose-500/25" />
              )}
              <button
                type="button"
                disabled={isConnecting || isFlushing}
                onClick={isRecording ? () => void stopRecording() : () => void startRecording()}
                className={`relative flex h-20 w-20 items-center justify-center rounded-full border-2 shadow-xl transition-all ${
                  isRecording
                    ? 'border-rose-400 bg-rose-600 text-white hover:bg-rose-500'
                    : 'border-indigo-400/60 bg-indigo-600 text-white hover:scale-105 hover:bg-indigo-500'
                } disabled:cursor-not-allowed disabled:opacity-60`}
                aria-label={isRecording ? 'Stop recording' : 'Start real-time transcription'}
              >
                {isConnecting || isFlushing ? (
                  <Loader2 className="h-8 w-8 animate-spin" />
                ) : isRecording ? (
                  <Square className="h-7 w-7 fill-current" />
                ) : (
                  <Mic className="h-8 w-8" />
                )}
              </button>
            </div>

            <div className="mt-4 flex items-center gap-3 text-xs">
              <span
                className={`inline-flex items-center gap-1.5 font-medium ${
                  isRecording ? 'text-rose-400' : 'text-slate-300'
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    isRecording ? 'animate-pulse bg-rose-500' : 'bg-slate-600'
                  }`}
                />
                {isConnecting
                  ? 'Connecting stream...'
                  : isFlushing
                    ? 'Finalizing last words...'
                    : isRecording
                      ? 'Listening live'
                      : 'Ready to listen'}
              </span>
              <span className="font-mono text-slate-400">{formatDuration(elapsedSeconds)}</span>
            </div>

            <div className="mt-5 flex w-full items-center justify-center gap-2 border-t border-slate-800/80 pt-4">
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*,.wav,.mp3,.m4a,.webm,.ogg,.flac"
                onChange={handleFileUpload}
                className="hidden"
              />
              <button
                type="button"
                disabled={isRecording || isUploading}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700/80 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-indigo-500/50 hover:bg-slate-800 disabled:opacity-50"
              >
                {isUploading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FileAudio className="h-3.5 w-3.5 text-indigo-400" />
                )}
                {isUploading ? 'Transcribing...' : 'Upload Audio Clip'}
              </button>
            </div>
          </div>

          {/* Language Mode Selector */}
          <div className="mt-5 space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 font-medium text-slate-300">
                <Globe className="h-3.5 w-3.5 text-indigo-400" />
                Multilingual Script Mode
              </span>
              <span className="text-[11px] text-slate-500">Live switchable</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {LANGUAGE_MODES.map((item) => {
                const active = mode === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setMode(item.id)}
                    className={`rounded-xl border px-3 py-2 text-left transition ${
                      active
                        ? 'border-indigo-500 bg-indigo-500/15 text-white'
                        : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                    }`}
                  >
                    <div className="text-xs font-semibold">{item.shortLabel}</div>
                    <div className="mt-0.5 line-clamp-1 text-[11px] text-slate-400">
                      {item.description}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Engine Switcher */}
          <div className="mt-5 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 font-medium text-slate-300">
                <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
                Speech Engine
              </span>
              <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
                {backendHealth.status === 'online' ? (
                  <>
                    <Wifi className="h-3 w-3 text-emerald-400" />
                    {backendHealth.model || 'small'} · {backendHealth.device || 'cpu'}
                  </>
                ) : (
                  <>
                    <WifiOff className="h-3 w-3 text-amber-400" />
                    {backendHealth.status === 'checking' ? 'Checking...' : 'Space offline'}
                  </>
                )}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                type="button"
                disabled={isRecording}
                onClick={() => setEngine('faster-whisper')}
                className={`rounded-xl border px-3 py-2 text-left text-xs transition ${
                  engine === 'faster-whisper'
                    ? 'border-emerald-500/70 bg-emerald-500/10 text-emerald-100'
                    : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700'
                } disabled:opacity-60`}
              >
                <div className="font-semibold">Faster-Whisper (WS)</div>
                <div className="text-[11px] text-slate-400">HF Space / FastAPI live stream</div>
              </button>
              <button
                type="button"
                disabled={isRecording}
                onClick={() => setEngine('hf-inference')}
                className={`rounded-xl border px-3 py-2 text-left text-xs transition ${
                  engine === 'hf-inference'
                    ? 'border-emerald-500/70 bg-emerald-500/10 text-emerald-100'
                    : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700'
                } disabled:opacity-60`}
              >
                <div className="font-semibold">HF Inference API</div>
                <div className="text-[11px] text-slate-400">
                  {hfConfigured ? 'Serverless Whisper v3 Turbo' : 'Requires HF_TOKEN env'}
                </div>
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* Right column: Live Transcript Canvas & Save Controls */}
      <div className="lg:col-span-7">
        <section className="flex h-full min-h-[540px] flex-col rounded-2xl border border-slate-800/90 bg-slate-900/70 p-5 shadow-2xl shadow-black/40 backdrop-blur">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-slate-100">Live Transcript Stream</h2>
              <span className="rounded-full border border-slate-700 bg-slate-800 px-2.5 py-0.5 font-mono text-[11px] text-slate-300">
                {wordCount} words
              </span>
              {detectedLanguages.map((lang) => (
                <span
                  key={lang}
                  className="rounded-full border border-indigo-500/40 bg-indigo-500/15 px-2 py-0.5 text-[11px] font-semibold uppercase text-indigo-300"
                >
                  {lang}
                </span>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={!fullTranscript}
                onClick={() => void handleCopy()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700/80 bg-slate-800/80 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700 disabled:opacity-40"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                disabled={!fullTranscript}
                onClick={() =>
                  downloadTextFile(`${(title || 'transcript').trim()}.txt`, `${fullTranscript}\n`)
                }
                className="inline-flex items-center gap-1 rounded-lg border border-slate-700/80 bg-slate-800/80 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700 disabled:opacity-40"
              >
                <Download className="h-3.5 w-3.5" />
                TXT
              </button>
              <button
                type="button"
                disabled={!fullTranscript}
                onClick={() =>
                  downloadTextFile(
                    `${(title || 'transcript').trim()}.srt`,
                    buildSrtContent({
                      segments,
                      transcript: fullTranscript,
                      durationSeconds: elapsedSeconds,
                    }),
                  )
                }
                className="inline-flex items-center gap-1 rounded-lg border border-slate-700/80 bg-slate-800/80 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700 disabled:opacity-40"
              >
                <Download className="h-3.5 w-3.5" />
                SRT
              </button>
              <button
                type="button"
                disabled={!fullTranscript && !interimText}
                onClick={handleClear}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-700/80 bg-slate-800/80 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:border-rose-500/50 hover:text-rose-300 disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Clear
              </button>
            </div>
          </div>

          {(statusError || statusNotice) && (
            <div
              className={`mb-4 rounded-xl border px-3.5 py-2.5 text-xs ${
                statusError
                  ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                  : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
              }`}
            >
              {statusError || statusNotice}
            </div>
          )}

          {/* Transcript Flow */}
          <div className="flex-1 space-y-3 overflow-y-auto rounded-xl border border-slate-800/80 bg-slate-950/75 p-4">
            {segments.length === 0 && !interimText ? (
              <div className="flex h-full min-h-[260px] flex-col items-center justify-center text-center">
                <div className="mb-3 rounded-2xl border border-slate-800 bg-slate-900/90 p-3.5 text-indigo-400">
                  <Mic className="h-6 w-6" />
                </div>
                <p className="text-sm font-medium text-slate-200">
                  Start speaking to see real-time Hindi &amp; English transcription
                </p>
                <p className="mt-1.5 max-w-md text-xs text-slate-400">
                  Try mixing languages naturally, e.g.{' '}
                  <span className="text-slate-200">
                    &ldquo;आज की meeting में हम next release plan discuss करेंगे, okay?&rdquo;
                  </span>
                </p>
              </div>
            ) : (
              <>
                {segments.map((seg) => (
                  <div
                    key={seg.id}
                    className="group rounded-xl border border-slate-800/90 bg-slate-900/65 p-3 transition hover:border-slate-700"
                  >
                    <div className="mb-1.5 flex items-center justify-between text-[11px] text-slate-400">
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 font-mono font-semibold uppercase text-indigo-300">
                          {seg.language}
                        </span>
                        <span className="font-mono">
                          {seg.start.toFixed(1)}s – {seg.end.toFixed(1)}s
                        </span>
                      </div>
                      {typeof seg.latencyMs === 'number' && (
                        <span className="font-mono text-emerald-400/90">{seg.latencyMs}ms</span>
                      )}
                    </div>
                    <p className="text-[15px] leading-relaxed text-slate-100">{seg.text}</p>
                  </div>
                ))}

                {interimText && (
                  <div className="rounded-xl border border-indigo-500/40 bg-indigo-500/10 p-3">
                    <div className="mb-1 flex items-center gap-2 text-[11px] text-indigo-300">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
                      <span className="font-semibold uppercase tracking-wide">Live Interim</span>
                      {interimLang && (
                        <span className="rounded bg-indigo-500/25 px-1.5 py-0.5 font-mono uppercase">
                          {interimLang}
                        </span>
                      )}
                    </div>
                    <p className="text-[15px] leading-relaxed text-indigo-100">{interimText}</p>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Save to MongoDB Footer */}
          <div className="mt-4 grid grid-cols-1 gap-2.5 border-t border-slate-800 pt-4 sm:grid-cols-12">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Session title (auto-generated if blank)"
              className="rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none sm:col-span-5"
            />
            <input
              type="text"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="Tags (comma separated: meeting, hinglish)"
              className="rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none sm:col-span-4"
            />
            <button
              type="button"
              disabled={!fullTranscript || isSaving || !dbConnected}
              onClick={() => void saveCurrentSession(false)}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50 sm:col-span-3"
            >
              {isSaving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Database className="h-3.5 w-3.5" />
              )}
              {isSaving ? 'Saving...' : 'Save to DB'}
            </button>
          </div>
          {!dbConnected && (
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-300/90">
              <Save className="h-3 w-3" />
              Configure <code className="font-mono">MONGODB_URI</code> to persist transcriptions to MongoDB.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
