import { useState, useRef, useEffect } from "react";
import { uploadFile, strapiMediaUrl } from "@/lib/api";

export interface UploadedFile {
  id: number;
  url: string;
  name: string;
}

interface Props {
  value: UploadedFile[];
  onChange: (files: UploadedFile[]) => void;
  accept?: string;
}

export function FileUpload({ value, onChange, accept = "image/*,video/*,.pdf,.txt,.md,.log,.zip" }: Props) {
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
          const res = await uploadFile(file);
          if (res) results.push(res);
        } catch {
          setError(`Failed to upload ${file.name}`);
        }
      }
      if (results.length > 0) onChange([...value, ...results]);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function handleRemove(id: number) {
    onChange(value.filter((f) => f.id !== id));
  }

  // Listen for paste events on the parent container
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = containerRef.current?.closest("[data-paste-zone]") ?? containerRef.current?.parentElement;
    if (!el) return;
    function onPaste(e: Event) {
      const ce = e as ClipboardEvent;
      const items = ce.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === "file") {
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
    el.addEventListener("paste", onPaste);
    return () => el.removeEventListener("paste", onPaste);
  });

  return (
    <div ref={containerRef} className="space-y-2">
      <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-3 text-sm text-gray-500 transition hover:border-gray-400 hover:bg-gray-100">
        <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0l-4 4m4-4l4 4M4 20h16" />
        </svg>
        {uploading ? "Uploading..." : error ? <span className="text-red-500">{error}</span> : "Click or paste to attach files"}
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
        <ul className="space-y-1">
          {value.map((f) => (
            <li key={f.id} className="flex items-center gap-2 rounded border border-gray-200 bg-white px-3 py-1.5 text-sm">
              {f.url && /\.(png|jpe?g|gif|webp|svg)$/i.test(f.name) ? (
                <img src={strapiMediaUrl(f.url)} alt={f.name} className="h-8 w-8 rounded object-cover" />
              ) : f.url && /\.(mp4|webm|mov|avi|mkv|ogg)$/i.test(f.name) ? (
                <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.91 11.672a.375.375 0 010 .656l-5.603 3.113a.375.375 0 01-.557-.328V8.887c0-.286.307-.466.557-.327l5.603 3.112z" />
                </svg>
              ) : (
                <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
              )}
              <span className="flex-1 truncate text-gray-700">{f.name}</span>
              <button
                type="button"
                onClick={() => handleRemove(f.id)}
                className="text-gray-400 hover:text-red-500"
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
