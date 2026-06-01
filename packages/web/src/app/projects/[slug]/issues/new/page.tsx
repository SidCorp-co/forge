'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { useCreateIssue } from '@/features/issue/hooks/use-issues';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import { formatApiError } from '@/lib/api/error';
import { Save, Trash2, X } from 'lucide-react';

type IssuePriority = 'none' | 'low' | 'medium' | 'high' | 'critical';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 10;

const ALLOWED_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'text/plain',
  'text/markdown',
]);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export default function NewIssuePage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const project = useProjectBySlug(slug);
  const createIssue = useCreateIssue(project?.id);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<IssuePriority>('medium');
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const acceptFiles = useCallback(
    (picked: FileList | File[]) => {
      setWarnings([]);
      const accepted: File[] = [];
      const errs: string[] = [];
      for (const f of Array.from(picked)) {
        if (f.size <= 0) {
          errs.push(`Empty file skipped: ${f.name}`);
          continue;
        }
        if (f.size > MAX_BYTES) {
          errs.push(`Too large (max 10 MB): ${f.name}`);
          continue;
        }
        const mime = f.type || 'application/octet-stream';
        if (!ALLOWED_MIMES.has(mime)) {
          errs.push(`File type not allowed: ${f.name}`);
          continue;
        }
        accepted.push(f);
      }
      setFiles((prev) => {
        const room = MAX_FILES - prev.length;
        if (accepted.length > room) {
          errs.push(`Max ${MAX_FILES} attachments per issue. Extras skipped.`);
        }
        return [...prev, ...accepted.slice(0, Math.max(0, room))];
      });
      if (errs.length > 0) setWarnings(errs);
    },
    [],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        acceptFiles(e.dataTransfer.files);
      }
    },
    [acceptFiles],
  );

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        acceptFiles(e.target.files);
        e.target.value = '';
      }
    },
    [acceptFiles],
  );

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project) return;
    if (!title.trim()) {
      setError('Title is required.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const attachments = await Promise.all(
        files.map(async (f) => ({
          name: f.name,
          mime: f.type || 'application/octet-stream',
          dataBase64: await fileToBase64(f),
        })),
      );
      const created = await createIssue.mutateAsync({
        title,
        ...(description.trim() ? { description } : {}),
        priority,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      // Land on the created issue's detail page (AC3), not the issues list.
      // The [id] route resolves both the friendly ISS-N displayId and the UUID;
      // prefer displayId to match the rest of the app's issue links.
      router.push(`/projects/${slug}/issues/${created.displayId ?? created.id}`);
    } catch (err) {
      setError(formatApiError(err));
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-8 antialiased">
      <div className="mb-8 border-b border-outline-variant/30 pb-4">
        <h2 className="text-[14px] font-bold uppercase tracking-[0.2em] text-primary">
          Create new issue
        </h2>
      </div>

      {error && (
        <div className="mb-8">
          <AlertBanner variant="error">{error}</AlertBanner>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-8">
        <div className="space-y-6 rounded-sm border border-outline-variant/30 bg-surface p-6 shadow-xl">
          <div>
            <label
              htmlFor="title"
              className="mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant"
            >
              Title <span className="text-danger">*</span>
            </label>
            <input
              id="title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              className="w-full rounded-sm border border-outline-variant/50 bg-surface-container-low px-4 py-3 text-sm text-on-surface shadow-sm transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          <div>
            <label
              htmlFor="description"
              className="mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant"
            >
              Description
            </label>
            <textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={6}
              className="w-full rounded-sm border border-outline-variant/50 bg-surface-container-low px-4 py-3 text-sm text-on-surface shadow-sm transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          <div className="w-full sm:w-1/2">
            <label
              htmlFor="priority"
              className="mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant"
            >
              Priority
            </label>
            <select
              id="priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as IssuePriority)}
              className="w-full rounded-sm border border-outline-variant/50 bg-surface-container-low px-4 py-3 text-sm font-medium text-on-surface shadow-sm transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="none">UNASSIGNED</option>
              <option value="low">LOW</option>
              <option value="medium">MEDIUM</option>
              <option value="high">HIGH</option>
              <option value="critical">CRITICAL</option>
            </select>
          </div>

          <div>
            <label className="mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
              Attachments
            </label>
            <div
              onDrop={onDrop}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              className={`flex flex-col items-center justify-center gap-1 rounded-sm border border-dashed px-4 py-6 text-center transition-colors ${
                dragOver
                  ? 'border-primary bg-primary/5'
                  : 'border-outline-variant/40 bg-surface-container-low'
              }`}
            >
              <p className="text-sm text-on-surface">Drop files to attach</p>
              <p className="text-xs text-on-surface-variant">
                Max 10 MB per file. Up to {MAX_FILES} per issue. Images, video, PDF, text, markdown.
              </p>
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="mt-2 inline-flex items-center rounded-sm border border-outline-variant/30 bg-surface px-3 py-1 text-xs font-medium uppercase tracking-widest text-on-surface hover:bg-surface-container"
              >
                Choose files
              </button>
              <input
                ref={inputRef}
                type="file"
                multiple
                className="hidden"
                onChange={onPick}
              />
            </div>

            {warnings.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs text-warning">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}

            {files.length > 0 && (
              <ul className="mt-3 space-y-1">
                {files.map((f, i) => (
                  <li
                    key={`${f.name}-${i}`}
                    className="flex items-center gap-3 rounded-sm border border-outline-variant/20 bg-surface-container-low px-3 py-2 text-xs"
                  >
                    <span className="flex-1 truncate text-on-surface" title={f.name}>
                      {f.name}
                    </span>
                    <span className="text-[10px] uppercase tracking-widest text-on-surface-variant">
                      {formatSize(f.size)}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeFile(i)}
                      aria-label={`Remove ${f.name}`}
                      className="text-on-surface-variant hover:text-danger"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-outline-variant/30 pt-4 sm:flex-row">
          <button
            type="submit"
            disabled={submitting || !project}
            className="flex items-center justify-center gap-2 rounded-sm bg-primary px-8 py-3 text-[10px] font-bold uppercase tracking-[0.2em] text-on-primary shadow-lg transition-all hover:bg-on-surface-variant active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100"
          >
            {submitting ? 'SAVING…' : (
              <>
                <Save className="h-4 w-4" /> CREATE
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => router.back()}
            className="flex items-center justify-center gap-2 rounded-sm border border-outline-variant/30 bg-surface-container-low px-8 py-3 text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant transition-all hover:bg-surface-container-high hover:text-on-surface"
          >
            <X className="h-4 w-4" /> CANCEL
          </button>
        </div>
      </form>
    </div>
  );
}
