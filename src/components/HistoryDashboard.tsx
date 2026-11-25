'use client';

import { useMemo, useState } from 'react';
import {
  Check,
  Clock,
  Copy,
  Database,
  Download,
  Edit3,
  FileText,
  Languages,
  Loader2,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  buildSrtContent,
  downloadTextFile,
  formatDuration,
  LANGUAGE_MODES,
} from '@/lib/export-utils';
import type {
  CreateTranscriptionInput,
  LanguageMode,
  TranscriptionRecord,
  TranscriptionStats,
  UpdateTranscriptionInput,
} from '@/types/transcription';

interface HistoryDashboardProps {
  items: TranscriptionRecord[];
  stats: TranscriptionStats;
  loading: boolean;
  dbConnected: boolean;
  dbError: string | null;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  modeFilter: string;
  onModeFilterChange: (mode: string) => void;
  pinnedOnly: boolean;
  onPinnedOnlyChange: (pinned: boolean) => void;
  onRefresh: () => void;
  onCreate: (payload: CreateTranscriptionInput) => Promise<TranscriptionRecord | null>;
  onUpdate: (id: string, payload: UpdateTranscriptionInput) => Promise<TranscriptionRecord | null>;
  onDelete: (id: string) => Promise<boolean>;
}

export function HistoryDashboard({
  items,
  stats,
  loading,
  dbConnected,
  dbError,
  searchQuery,
  onSearchQueryChange,
  modeFilter,
  onModeFilterChange,
  pinnedOnly,
  onPinnedOnlyChange,
  onRefresh,
  onCreate,
  onUpdate,
  onDelete,
}: HistoryDashboardProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Edit form state
  const [editTitle, setEditTitle] = useState('');
  const [editTranscript, setEditTranscript] = useState('');
  const [editMode, setEditMode] = useState<LanguageMode>('multilingual');
  const [editTags, setEditTags] = useState('');
  const [editNotes, setEditNotes] = useState('');

  // Create manual form state
  const [newTitle, setNewTitle] = useState('');
  const [newTranscript, setNewTranscript] = useState('');
  const [newMode, setNewMode] = useState<LanguageMode>('multilingual');
  const [newTags, setNewTags] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [createBusy, setCreateBusy] = useState(false);

  const selected = useMemo(() => {
    if (items.length === 0) return null;
    return items.find((item) => item.id === selectedId) ?? items[0];
  }, [items, selectedId]);

  const beginEdit = (item: TranscriptionRecord) => {
    setSelectedId(item.id);
    setEditTitle(item.title);
    setEditTranscript(item.transcript);
    setEditMode(item.languageMode);
    setEditTags(item.tags.join(', '));
    setEditNotes(item.notes);
    setIsEditing(true);
    setConfirmDeleteId(null);
  };

  const handleSaveEdit = async () => {
    if (!selected || !editTranscript.trim()) return;
    setBusyId(selected.id);
    try {
      const updated = await onUpdate(selected.id, {
        title: editTitle,
        transcript: editTranscript,
        languageMode: editMode,
        tags: editTags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        notes: editNotes,
      });
      if (updated) {
        setIsEditing(false);
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleTogglePin = async (item: TranscriptionRecord) => {
    setBusyId(item.id);
    try {
      await onUpdate(item.id, { isPinned: !item.isPinned });
    } finally {
      setBusyId(null);
    }
  };

  const handleConfirmDelete = async (id: string) => {
    setBusyId(id);
    try {
      const ok = await onDelete(id);
      if (ok) {
        setConfirmDeleteId(null);
        setIsEditing(false);
        if (selectedId === id) {
          setSelectedId(null);
        }
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTranscript.trim()) return;
    setCreateBusy(true);
    try {
      const created = await onCreate({
        title: newTitle.trim() || undefined,
        transcript: newTranscript.trim(),
        languageMode: newMode,
        tags: newTags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        notes: newNotes.trim(),
        engine: 'faster-whisper',
        model: 'manual-entry',
      });
      if (created) {
        setIsCreating(false);
        setNewTitle('');
        setNewTranscript('');
        setNewTags('');
        setNewNotes('');
        setSelectedId(created.id);
      }
    } finally {
      setCreateBusy(false);
    }
  };

  const handleCopy = async (item: TranscriptionRecord) => {
    await navigator.clipboard.writeText(item.transcript);
    setCopiedId(item.id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  return (
    <div className="space-y-6">
      {/* Stats Bar */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-2xl border border-slate-800/90 bg-slate-900/70 p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Saved Sessions</span>
            <Database className="h-4 w-4 text-indigo-400" />
          </div>
          <div className="mt-2 font-mono text-2xl font-bold text-white">{stats.totalCount}</div>
        </div>
        <div className="rounded-2xl border border-slate-800/90 bg-slate-900/70 p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Total Words</span>
            <FileText className="h-4 w-4 text-emerald-400" />
          </div>
          <div className="mt-2 font-mono text-2xl font-bold text-white">{stats.totalWords}</div>
        </div>
        <div className="rounded-2xl border border-slate-800/90 bg-slate-900/70 p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Audio Captured</span>
            <Clock className="h-4 w-4 text-sky-400" />
          </div>
          <div className="mt-2 font-mono text-2xl font-bold text-white">
            {formatDuration(stats.totalDurationSeconds)}
          </div>
        </div>
        <div className="rounded-2xl border border-slate-800/90 bg-slate-900/70 p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Languages</span>
            <Languages className="h-4 w-4 text-amber-400" />
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {stats.languages.length > 0 ? (
              stats.languages.map((l) => (
                <span
                  key={l}
                  className="rounded-md border border-slate-700 bg-slate-800 px-2 py-0.5 font-mono text-xs font-semibold uppercase text-slate-200"
                >
                  {l}
                </span>
              ))
            ) : (
              <span className="font-mono text-lg font-semibold text-slate-500">—</span>
            )}
          </div>
        </div>
      </div>

      {!dbConnected && (
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-xs text-amber-100">
          <div className="font-semibold">MongoDB Connection Required</div>
          <p className="mt-1 text-amber-200/85">
            {dbError || 'MONGODB_URI is not configured.'} Add{' '}
            <code className="rounded bg-black/30 px-1.5 py-0.5 font-mono">MONGODB_URI</code> to your
            environment variables to enable persistent history CRUD.
          </p>
        </div>
      )}

      {/* Search & Filter Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800/90 bg-slate-900/70 p-4">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
            placeholder="Search Hindi / English transcripts, titles, tags..."
            className="w-full rounded-xl border border-slate-800 bg-slate-950 py-2 pr-3 pl-9 text-xs text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={modeFilter}
            onChange={(e) => onModeFilterChange(e.target.value)}
            className="rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none"
          >
            <option value="all">All Modes</option>
            {LANGUAGE_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => onPinnedOnlyChange(!pinnedOnly)}
            className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium transition ${
              pinnedOnly
                ? 'border-amber-500/60 bg-amber-500/15 text-amber-200'
                : 'border-slate-800 bg-slate-950 text-slate-300 hover:border-slate-700'
            }`}
          >
            <Pin className="h-3.5 w-3.5" />
            Pinned ({stats.pinnedCount})
          </button>

          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-slate-700 hover:text-white"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>

          <button
            type="button"
            disabled={!dbConnected}
            onClick={() => setIsCreating(true)}
            className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            New Note
          </button>
        </div>
      </div>

      {/* Create Modal */}
      {isCreating && (
        <form
          onSubmit={handleCreateSubmit}
          className="space-y-3 rounded-2xl border border-indigo-500/40 bg-slate-900/95 p-5 shadow-2xl"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Create Transcription Entry</h3>
            <button
              type="button"
              onClick={() => setIsCreating(false)}
              className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Title (optional — auto-derived from text)"
              className="rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
            />
            <select
              value={newMode}
              onChange={(e) => setNewMode(e.target.value as LanguageMode)}
              className="rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
            >
              {LANGUAGE_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <textarea
            required
            rows={4}
            value={newTranscript}
            onChange={(e) => setNewTranscript(e.target.value)}
            placeholder="Enter multilingual transcription text (Hindi / English / Hinglish)..."
            className="w-full rounded-xl border border-slate-800 bg-slate-950 p-3 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input
              type="text"
              value={newTags}
              onChange={(e) => setNewTags(e.target.value)}
              placeholder="Tags (comma separated)"
              className="rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
            />
            <input
              type="text"
              value={newNotes}
              onChange={(e) => setNewNotes(e.target.value)}
              placeholder="Notes (optional)"
              className="rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-slate-700 focus:outline-none"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setIsCreating(false)}
              className="rounded-xl border border-slate-700 px-3.5 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createBusy || !newTranscript.trim()}
              className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {createBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Create Record
            </button>
          </div>
        </form>
      )}

      {/* Master-Detail Split Grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* History List */}
        <div className="space-y-2.5 lg:col-span-5">
          {loading && items.length === 0 ? (
            <div className="flex h-64 items-center justify-center rounded-2xl border border-slate-800 bg-slate-900/50 text-xs text-slate-400">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading MongoDB history...
            </div>
          ) : items.length === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center rounded-2xl border border-slate-800 bg-slate-900/50 p-6 text-center">
              <FileText className="mb-2 h-7 w-7 text-slate-600" />
              <p className="text-sm font-medium text-slate-300">No saved transcriptions yet</p>
              <p className="mt-1 text-xs text-slate-500">
                Record speech in Live Studio or click New Note to add one.
              </p>
            </div>
          ) : (
            <div className="max-h-[600px] space-y-2.5 overflow-y-auto pr-1">
              {items.map((item) => {
                const isSelected = selected?.id === item.id;
                return (
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setSelectedId(item.id);
                      setIsEditing(false);
                      setConfirmDeleteId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedId(item.id);
                        setIsEditing(false);
                      }
                    }}
                    className={`cursor-pointer rounded-2xl border p-4 transition ${
                      isSelected
                        ? 'border-indigo-500/70 bg-indigo-500/10 shadow-lg shadow-indigo-950/30'
                        : 'border-slate-800/90 bg-slate-900/65 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="line-clamp-1 text-sm font-semibold text-slate-100">
                        {item.title}
                      </h3>
                      <button
                        type="button"
                        disabled={busyId === item.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleTogglePin(item);
                        }}
                        className={`rounded-lg p-1 transition ${
                          item.isPinned
                            ? 'text-amber-400 hover:bg-amber-500/15'
                            : 'text-slate-500 hover:bg-slate-800 hover:text-slate-300'
                        }`}
                        title={item.isPinned ? 'Unpin' : 'Pin'}
                      >
                        {item.isPinned ? <Pin className="h-3.5 w-3.5 fill-current" /> : <PinOff className="h-3.5 w-3.5" />}
                      </button>
                    </div>

                    <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-slate-400">
                      {item.transcript}
                    </p>

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-slate-300">
                          {item.languageMode}
                        </span>
                        {item.detectedLanguages.map((l) => (
                          <span
                            key={l}
                            className="rounded bg-indigo-500/15 px-1.5 py-0.5 font-mono uppercase text-indigo-300"
                          >
                            {l}
                          </span>
                        ))}
                        <span>{item.wordCount}w</span>
                      </div>
                      <span>{new Date(item.createdAt).toLocaleString()}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Detail / Edit Inspector */}
        <div className="lg:col-span-7">
          {selected ? (
            <div className="rounded-2xl border border-slate-800/90 bg-slate-900/70 p-5 shadow-2xl">
              {isEditing ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                    <h3 className="text-sm font-semibold text-white">Edit Transcription</h3>
                    <button
                      type="button"
                      onClick={() => setIsEditing(false)}
                      className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-slate-400">
                        Title
                      </label>
                      <input
                        type="text"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-slate-400">
                        Language Mode
                      </label>
                      <select
                        value={editMode}
                        onChange={(e) => setEditMode(e.target.value as LanguageMode)}
                        className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
                      >
                        {LANGUAGE_MODES.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-slate-400">
                      Transcript Text
                    </label>
                    <textarea
                      rows={8}
                      value={editTranscript}
                      onChange={(e) => setEditTranscript(e.target.value)}
                      className="w-full rounded-xl border border-slate-800 bg-slate-950 p-3 text-sm leading-relaxed text-slate-100 focus:border-indigo-500 focus:outline-none"
                    />
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-slate-400">
                        Tags (comma separated)
                      </label>
                      <input
                        type="text"
                        value={editTags}
                        onChange={(e) => setEditTags(e.target.value)}
                        className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-slate-400">
                        Notes
                      </label>
                      <input
                        type="text"
                        value={editNotes}
                        onChange={(e) => setEditNotes(e.target.value)}
                        className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
                      />
                    </div>
                  </div>

                  <div className="flex justify-end gap-2 border-t border-slate-800 pt-3">
                    <button
                      type="button"
                      onClick={() => setIsEditing(false)}
                      className="rounded-xl border border-slate-700 px-3.5 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={busyId === selected.id || !editTranscript.trim()}
                      onClick={() => void handleSaveEdit()}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                    >
                      {busyId === selected.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Save className="h-3.5 w-3.5" />
                      )}
                      Save Changes
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 pb-4">
                    <div>
                      <h3 className="text-lg font-semibold text-white">{selected.title}</h3>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                        <span className="rounded-md bg-slate-800 px-2 py-0.5 font-mono text-slate-200">
                          {selected.engine} · {selected.model}
                        </span>
                        <span>{selected.wordCount} words</span>
                        <span>·</span>
                        <span>{formatDuration(selected.durationSeconds)}</span>
                        <span>·</span>
                        <span>Updated {new Date(selected.updatedAt).toLocaleString()}</span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleCopy(selected)}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
                      >
                        {copiedId === selected.id ? (
                          <Check className="h-3.5 w-3.5 text-emerald-400" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                        Copy
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          downloadTextFile(
                            `${selected.title.replace(/[^\w-]+/g, '_')}.srt`,
                            buildSrtContent(selected),
                          )
                        }
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
                      >
                        <Download className="h-3.5 w-3.5" />
                        SRT
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          downloadTextFile(
                            `${selected.title.replace(/[^\w-]+/g, '_')}.json`,
                            JSON.stringify(selected, null, 2),
                            'application/json',
                          )
                        }
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
                      >
                        <Download className="h-3.5 w-3.5" />
                        JSON
                      </button>
                      <button
                        type="button"
                        onClick={() => beginEdit(selected)}
                        className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                        Edit
                      </button>
                      {confirmDeleteId === selected.id ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            disabled={busyId === selected.id}
                            onClick={() => void handleConfirmDelete(selected.id)}
                            className="rounded-lg bg-rose-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-rose-500"
                          >
                            {busyId === selected.id ? 'Deleting...' : 'Confirm'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="rounded-lg border border-slate-700 px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(selected.id)}
                          className="inline-flex items-center gap-1 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-500/20"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Full Transcript Body */}
                  <div className="rounded-xl border border-slate-800 bg-slate-950/75 p-4">
                    <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-slate-100">
                      {selected.transcript}
                    </p>
                  </div>

                  {/* Tags & Notes */}
                  {(selected.tags.length > 0 || selected.notes) && (
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800/80 bg-slate-950/50 px-3.5 py-2.5 text-xs">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {selected.tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full border border-slate-700 bg-slate-800 px-2.5 py-0.5 text-slate-300"
                          >
                            #{tag}
                          </span>
                        ))}
                      </div>
                      {selected.notes && (
                        <span className="text-slate-400">Note: {selected.notes}</span>
                      )}
                    </div>
                  )}

                  {/* Segment Timeline */}
                  {selected.segments.length > 0 && (
                    <div className="space-y-2">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                        Segment Breakdown ({selected.segments.length})
                      </h4>
                      <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
                        {selected.segments.map((seg, idx) => (
                          <div
                            key={seg.id || idx}
                            className="rounded-xl border border-slate-800/80 bg-slate-950/60 px-3 py-2 text-xs"
                          >
                            <div className="mb-1 flex items-center justify-between text-[11px] text-slate-500">
                              <span className="font-mono text-indigo-300 uppercase">
                                {seg.language} · {seg.start.toFixed(1)}s–{seg.end.toFixed(1)}s
                              </span>
                              {typeof seg.latencyMs === 'number' && (
                                <span className="font-mono text-emerald-400">{seg.latencyMs}ms</span>
                              )}
                            </div>
                            <p className="text-slate-200">{seg.text}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-64 items-center justify-center rounded-2xl border border-slate-800 bg-slate-900/50 text-xs text-slate-500">
              Select a transcription from the list to inspect, edit, export, or delete.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
