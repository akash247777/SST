'use client';

import { useCallback, useEffect, useState } from 'react';
import { AudioWaveform, Database, History, Mic } from 'lucide-react';
import { HistoryDashboard } from './HistoryDashboard';
import { LiveStudio, type BackendHealthInfo } from './LiveStudio';
import type {
  CreateTranscriptionInput,
  TranscriptionRecord,
  TranscriptionStats,
  UpdateTranscriptionInput,
} from '@/types/transcription';

const STORAGE_WHISPER_KEY = 'sst_whisper_server_url';

const EMPTY_STATS: TranscriptionStats = {
  totalCount: 0,
  pinnedCount: 0,
  totalWords: 0,
  totalDurationSeconds: 0,
  languages: [],
};

export function SstWorkspace() {
  const [activeTab, setActiveTab] = useState<'studio' | 'history'>('studio');

  const [dbConnected, setDbConnected] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const [hfConfigured, setHfConfigured] = useState(false);

  const [whisperServerUrl, setWhisperServerUrl] = useState(
    process.env.NEXT_PUBLIC_WHISPER_SERVER_URL || 'http://localhost:7860',
  );
  const [backendHealth, setBackendHealth] = useState<BackendHealthInfo>({ status: 'checking' });

  const [items, setItems] = useState<TranscriptionRecord[]>([]);
  const [stats, setStats] = useState<TranscriptionStats>(EMPTY_STATS);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [modeFilter, setModeFilter] = useState('all');
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const showToast = useCallback((kind: 'ok' | 'err', text: string) => {
    setToast({ kind, text });
    setTimeout(() => {
      setToast((prev) => (prev?.text === text ? null : prev));
    }, 3500);
  }, []);

  const checkWhisperHealth = useCallback(async (urlToCheck: string, showChecking = true) => {
    if (showChecking) {
      setBackendHealth({ status: 'checking' });
    }
    const cleaned = urlToCheck.replace(/\/+$/, '');
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 7000);
      const res = await fetch(`${cleaned}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) {
        setBackendHealth({ status: 'offline', error: `HTTP ${res.status}` });
        return;
      }
      const data = await res.json();
      setBackendHealth({
        status: data.status === 'ok' ? 'online' : 'warming',
        model: data.model,
        device: data.device,
        computeType: data.computeType,
        error: data.error,
      });
    } catch {
      setBackendHealth({ status: 'offline' });
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (searchQuery.trim()) qs.set('q', searchQuery.trim());
      if (modeFilter !== 'all') qs.set('mode', modeFilter);
      if (pinnedOnly) qs.set('pinned', 'true');

      const res = await fetch(`/api/transcriptions?${qs.toString()}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === 'DB_NOT_CONFIGURED') {
          setDbConnected(false);
          setDbError(data.error);
        }
        setItems([]);
        setStats(EMPTY_STATS);
        return;
      }
      setDbConnected(true);
      setDbError(null);
      setItems(data.items || []);
      setStats(data.stats || EMPTY_STATS);
    } catch {
      // Keep UI responsive
    } finally {
      setLoadingHistory(false);
    }
  }, [modeFilter, pinnedOnly, searchQuery]);

  useEffect(() => {
    let active = true;
    async function initHealth() {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        const data = await res.json();
        if (!active) return;
        setDbConnected(data.dbStatus === 'connected');
        setDbError(data.dbError || null);
        setHfConfigured(Boolean(data.hfConfigured));

        const savedLocal =
          typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_WHISPER_KEY) : null;
        const effectiveUrl = savedLocal || data.whisperServerUrl || 'http://localhost:7860';
        setWhisperServerUrl(effectiveUrl);
        await checkWhisperHealth(effectiveUrl, false);
      } catch {
        if (!active) return;
        setDbConnected(false);
        setDbError('Could not reach /api/health');
      }
    }
    void initHealth();
    return () => {
      active = false;
    };
  }, [checkWhisperHealth]);

  useEffect(() => {
    const handle = setTimeout(() => {
      void loadHistory();
    }, 180);
    return () => clearTimeout(handle);
  }, [loadHistory]);

  const handleWhisperUrlChange = (nextUrl: string) => {
    setWhisperServerUrl(nextUrl);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_WHISPER_KEY, nextUrl);
    }
    void checkWhisperHealth(nextUrl);
  };

  const handleCreate = async (
    payload: CreateTranscriptionInput,
  ): Promise<TranscriptionRecord | null> => {
    try {
      const res = await fetch('/api/transcriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast('err', data.error || 'Failed to save transcription.');
        return null;
      }
      showToast('ok', `Saved "${data.item.title}" to MongoDB.`);
      await loadHistory();
      return data.item as TranscriptionRecord;
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Save failed.');
      return null;
    }
  };

  const handleUpdate = async (
    id: string,
    payload: UpdateTranscriptionInput,
  ): Promise<TranscriptionRecord | null> => {
    try {
      const res = await fetch(`/api/transcriptions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast('err', data.error || 'Update failed.');
        return null;
      }
      showToast('ok', 'Transcription updated.');
      await loadHistory();
      return data.item as TranscriptionRecord;
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Update failed.');
      return null;
    }
  };

  const handleDelete = async (id: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/transcriptions/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        showToast('err', data.error || 'Delete failed.');
        return false;
      }
      showToast('ok', 'Transcription deleted.');
      await loadHistory();
      return true;
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Delete failed.');
      return false;
    }
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,_rgba(79,70,229,0.14),_transparent_55%)]">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-slate-800/80 bg-[#07090e]/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-3.5 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-emerald-500 text-white shadow-lg shadow-indigo-500/20">
              <AudioWaveform className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-base font-bold tracking-tight text-white">
                VaaniFlow <span className="text-indigo-400">SST</span>
              </h1>
              <p className="text-[11px] text-slate-400">
                Real-Time Multilingual Hindi + English · Faster-Whisper &amp; MongoDB
              </p>
            </div>
          </div>

          {/* Status & Navigation */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="hidden items-center gap-2 md:flex">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                  backendHealth.status === 'online'
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                    : backendHealth.status === 'warming'
                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                      : 'border-slate-700 bg-slate-900 text-slate-400'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    backendHealth.status === 'online'
                      ? 'bg-emerald-400'
                      : backendHealth.status === 'warming'
                        ? 'bg-amber-400'
                        : 'bg-slate-500'
                  }`}
                />
                Whisper:{' '}
                {backendHealth.status === 'online'
                  ? `${backendHealth.model || 'small'} (${backendHealth.device || 'cpu'})`
                  : backendHealth.status}
              </span>

              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                  dbConnected
                    ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300'
                    : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                }`}
              >
                <Database className="h-3 w-3" />
                {dbConnected ? 'MongoDB Connected' : 'MongoDB Unconfigured'}
              </span>
            </div>

            <nav className="flex rounded-xl border border-slate-800 bg-slate-900/90 p-1">
              <button
                type="button"
                onClick={() => setActiveTab('studio')}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                  activeTab === 'studio'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Mic className="h-3.5 w-3.5" />
                Live Studio
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('history')}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                  activeTab === 'history'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <History className="h-3.5 w-3.5" />
                History Dashboard
                <span className="rounded-md bg-black/25 px-1.5 py-0.5 font-mono text-[10px]">
                  {stats.totalCount}
                </span>
              </button>
            </nav>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {toast && (
          <div
            className={`fixed right-5 bottom-5 z-50 rounded-xl border px-4 py-2.5 text-xs font-medium shadow-2xl ${
              toast.kind === 'ok'
                ? 'border-emerald-500/50 bg-emerald-950/95 text-emerald-200'
                : 'border-rose-500/50 bg-rose-950/95 text-rose-200'
            }`}
          >
            {toast.text}
          </div>
        )}

        {activeTab === 'studio' ? (
          <LiveStudio
            whisperServerUrl={whisperServerUrl}
            onWhisperServerUrlChange={handleWhisperUrlChange}
            backendHealth={backendHealth}
            onRecheckBackend={() => void checkWhisperHealth(whisperServerUrl)}
            hfConfigured={hfConfigured}
            dbConnected={dbConnected}
            onSaveTranscription={handleCreate}
          />
        ) : (
          <HistoryDashboard
            items={items}
            stats={stats}
            loading={loadingHistory}
            dbConnected={dbConnected}
            dbError={dbError}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            modeFilter={modeFilter}
            onModeFilterChange={setModeFilter}
            pinnedOnly={pinnedOnly}
            onPinnedOnlyChange={setPinnedOnly}
            onRefresh={() => {
              setLoadingHistory(true);
              void loadHistory();
            }}
            onCreate={handleCreate}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
          />
        )}
      </main>
    </div>
  );
}
