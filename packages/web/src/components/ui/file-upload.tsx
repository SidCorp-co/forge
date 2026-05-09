'use client';

import { useState, useRef, useEffect } from 'react';
import { coreFileUrl } from '@/lib/api/client';

export interface UploadedFile {
  id: number;
  url: string;
  name: string;
}

interface Props {
  value: UploadedFile[];
  onChange: (files: UploadedFile[]) => void;
  accept?: string;
  uploadFn: (file: File) => Promise<UploadedFile | null>;
}

export function FileUpload({ value, onChange, accept = 'image/*,video/*,.pdf,.txt,.md,.log,.zip', uploadFn }: Props) {
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [error, setError] = useState<string | null>(null);

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      const results: UploadedFile[] = [];
      for (const file of Array.from(fileList)) {
        try {
          const res = await uploadFn(file);
          if (res) results.push(res);
        } catch {
          setError(`Failed to upload ${file.name}`);
        }
      }
      if (results.length > 0) onChange([...value, ...results]);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  function handleRemove(id: number) {
    onChange(value.filter((f) => f.id !== id));
  }

  // Listen for paste events on the parent container
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = containerRef.current?.closest('[data-paste-zone]') ?? containerRef.current?.parentElement;
    if (!el) return;
    function onPaste(e: Event) {
      // Skip if paste originated from a text input — its own handler manages file uploads
      const target = e.target as HTMLElement;
      if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement || target.isContentEditable) return;
      const ce = e as ClipboardEvent;
      const items = ce.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        const dt = new DataTransfer();
        files.forEach((f) => dt.items.add(f));
        handleFiles(dt.files);
      }
    }
    el.addEventListener('paste', onPaste);
    return () => el.removeEventListener('paste', onPaste);
  });

  return (
    <div ref={containerRef} className="space-y-3">
      <label className="flex cursor-pointer items-center gap-2 rounded-sm border border-dashed border-outline-variant/50 bg-surface px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-outline transition hover:border-primary hover:text-on-surface">
        <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0l-4 4m4-4l4 4M4 20h16" />
        </svg>
        {uploading ? 'UPLOADING...' : error ? <span className="text-danger">{error}</span> : 'CLICK OR PASTE TO ATTACH FILES'}
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple
          onChange={(e) => handleFiles(e.target.files)}
          disabled={uploading}
          className="sr-only"
        />
      </label>
      {value.length > 0 && (
        <ul className="space-y-2">
          {value.map((f) => (
            <li key={f.id} className="flex items-center gap-3 rounded-sm border border-outline-variant/30 bg-surface-container-low px-3 py-2 text-xs font-mono">
              {f.url && /\.(png|jpe?g|gif|webp|svg)$/i.test(f.name) ? (
                <img src={coreFileUrl(f.url)} alt={f.name} className="h-8 w-8 rounded-sm object-cover" />
              ) : f.url && /\.(mp4|webm|mov|avi|mkv|ogg)$/i.test(f.name) ? (
                <svg className="h-4 w-4 text-outline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.91 11.672a.375.375 0 010 .656l-5.603 3.113a.375.375 0 01-.557-.328V8.887c0-.286.307-.466.557-.327l5.603 3.112z" />
                </svg>
              ) : (
                <svg className="h-4 w-4 text-outline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
              )}
              <span className="flex-1 truncate text-tertiary">{f.name}</span>
              <button
                type="button"
                onClick={() => handleRemove(f.id)}
                className="text-outline hover:text-danger transition-colors"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
