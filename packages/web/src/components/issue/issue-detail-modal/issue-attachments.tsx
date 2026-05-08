'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { ImagePreview } from '@/components/ui/image-preview';
import { useToast } from '@/hooks/use-toast';
import { coreFileUrl } from '@/lib/api/client';
import {
  useDeleteIssueAttachment,
  useIssueAttachments,
  useUploadIssueAttachment,
} from '@/features/issue/hooks/use-issue-attachments';
import type { IssueAttachment } from '@/features/issue/types';

const MAX_BYTES = 10 * 1024 * 1024;

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

interface IssueAttachmentsProps {
  issueId: string;
  currentUserId: string | null;
  isProjectOwner: boolean;
}

export function IssueAttachments({
  issueId,
  currentUserId,
  isProjectOwner,
}: IssueAttachmentsProps) {
  const { data: attachments = [], isLoading } = useIssueAttachments(issueId);
  const upload = useUploadIssueAttachment(issueId);
  const remove = useDeleteIssueAttachment(issueId);
  const { addToast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  const imageAttachments = useMemo(
    () => attachments.filter((a) => a.mime.startsWith('image/')),
    [attachments],
  );

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      const accepted: File[] = [];
      for (const file of list) {
        if (file.size <= 0) {
          addToast(`Empty file skipped: ${file.name}`);
          continue;
        }
        if (file.size > MAX_BYTES) {
          addToast(`Too large (max 10 MB): ${file.name}`);
          continue;
        }
        const mime = file.type || 'application/octet-stream';
        if (!ALLOWED_MIMES.has(mime)) {
          addToast(`File type not allowed: ${file.name}`);
          continue;
        }
        accepted.push(file);
      }
      await Promise.all(
        accepted.map(async (file) => {
          try {
            await upload.mutateAsync(file);
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Upload failed';
            addToast(`Upload failed: ${file.name} — ${message}`);
          }
        }),
      );
    },
    [addToast, upload],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        void handleFiles(e.dataTransfer.files);
      }
    },
    [handleFiles],
  );

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        void handleFiles(e.target.files);
        e.target.value = '';
      }
    },
    [handleFiles],
  );

  const onDelete = useCallback(
    async (a: IssueAttachment) => {
      if (!confirm(`Delete attachment "${a.name}"?`)) return;
      try {
        await remove.mutateAsync(a.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Delete failed';
        addToast(`Delete failed: ${message}`);
      }
    },
    [addToast, remove],
  );

  const canDelete = (a: IssueAttachment) => a.uploaderId === currentUserId || isProjectOwner;

  const openPreview = (att: IssueAttachment) => {
    const idx = imageAttachments.findIndex((i) => i.id === att.id);
    if (idx >= 0) setPreviewIndex(idx);
  };

  return (
    <section className="rounded-sm border border-outline-variant/20 bg-surface">
      <div className="border-b border-outline-variant/20 bg-surface-container-low px-4 py-2">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          Attachments
        </h3>
      </div>
      <div className="space-y-3 p-5">
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
            Max 10 MB per file. Images, video, PDF, text, markdown.
          </p>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={upload.isPending}
            className="mt-2 inline-flex items-center rounded-sm border border-outline-variant/30 bg-surface px-3 py-1 text-xs font-medium uppercase tracking-widest text-on-surface hover:bg-surface-container disabled:opacity-50"
          >
            {upload.isPending ? 'Uploading…' : 'Choose files'}
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={onPick}
          />
        </div>

        {isLoading ? (
          <p className="text-xs text-on-surface-variant">Loading attachments…</p>
        ) : attachments.length === 0 ? (
          <p className="text-xs text-on-surface-variant">
            No attachments yet. Drag files here or click to upload.
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {attachments.map((a) => {
              const isImage = a.mime.startsWith('image/');
              const isVideo = a.mime.startsWith('video/');
              const fullUrl = coreFileUrl(a.url);
              return (
                <li
                  key={a.id}
                  className="group relative flex flex-col gap-1 rounded-sm border border-outline-variant/20 bg-surface-container-low p-2"
                >
                  {isImage ? (
                    <button
                      type="button"
                      onClick={() => openPreview(a)}
                      className="block aspect-square w-full overflow-hidden rounded-sm bg-on-primary/10"
                      aria-label={`Preview ${a.name}`}
                    >
                      <img
                        src={fullUrl}
                        alt={a.name}
                        className="h-full w-full object-cover"
                      />
                    </button>
                  ) : isVideo ? (
                    <video
                      src={fullUrl}
                      controls
                      preload="metadata"
                      className="aspect-square w-full rounded-sm bg-on-primary/10 object-contain"
                    />
                  ) : (
                    <a
                      href={fullUrl}
                      download={a.name}
                      className="flex aspect-square w-full items-center justify-center rounded-sm bg-on-primary/10 text-xs text-on-surface-variant hover:bg-on-primary/20"
                    >
                      {a.mime === 'application/pdf' ? 'PDF' : 'FILE'}
                    </a>
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-on-surface" title={a.name}>
                      {a.name}
                    </p>
                    <p className="text-[10px] uppercase tracking-widest text-on-surface-variant">
                      {formatSize(a.size)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <a
                      href={fullUrl}
                      download={a.name}
                      className="text-[10px] font-medium uppercase tracking-widest text-primary hover:underline"
                    >
                      Download
                    </a>
                    {canDelete(a) && (
                      <button
                        type="button"
                        onClick={() => onDelete(a)}
                        disabled={remove.isPending}
                        className="ml-auto text-[10px] font-medium uppercase tracking-widest text-error opacity-0 transition-opacity hover:underline group-hover:opacity-100 disabled:opacity-50"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {previewIndex !== null && imageAttachments.length > 0 && (
        <ImagePreview
          images={imageAttachments.map((a) => ({ url: coreFileUrl(a.url), name: a.name }))}
          initialIndex={previewIndex}
          onClose={() => setPreviewIndex(null)}
        />
      )}
    </section>
  );
}

export default IssueAttachments;
