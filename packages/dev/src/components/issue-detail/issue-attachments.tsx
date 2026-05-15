import { useRef, useState } from "react";
import type { Issue } from "@/lib/types";
import { coreMediaUrl, uploadIssueAttachment } from "@/lib/api";
import { ImagePreview } from "../ui/image-preview";

interface Props {
  issue: Issue;
  onUpdated: () => void;
}

export function IssueAttachments({ issue, onUpdated }: Props) {
  const [previewImage, setPreviewImage] = useState<{ url: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFiles(picked: FileList | File[]) {
    setError(null);
    setUploading(true);
    const failures: string[] = [];
    try {
      for (const file of Array.from(picked)) {
        try {
          await uploadIssueAttachment(issue.documentId, file);
        } catch (err) {
          failures.push(`${file.name}: ${err instanceof Error ? err.message : "upload failed"}`);
        }
      }
      if (failures.length > 0) setError(failures.join(" • "));
      onUpdated();
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="px-6 py-3">
      <h3 className="mb-2 text-sm font-semibold text-gray-900">Attachments</h3>
      {issue.attachments && issue.attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {issue.attachments.map((a) => {
            const isImage = /^image\//.test(a.mime);
            const isVideo = /^video\//.test(a.mime);
            const fullUrl = coreMediaUrl(a.url);
            return isImage ? (
              <button
                key={a.id}
                type="button"
                onClick={() => setPreviewImage({ url: fullUrl, name: a.name })}
                className="flex items-center gap-1.5 rounded border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-700 hover:bg-gray-100 cursor-zoom-in"
              >
                <img src={fullUrl} alt={a.name} className="h-8 w-8 rounded object-cover" />
                <span className="max-w-[120px] truncate">{a.name}</span>
              </button>
            ) : isVideo ? (
              <div
                key={a.id}
                className="overflow-hidden rounded border border-gray-200 bg-gray-50"
              >
                <video src={fullUrl} controls preload="metadata" className="max-h-48 max-w-xs rounded" />
                <p className="truncate px-2.5 py-1 text-xs text-gray-700">{a.name}</p>
              </div>
            ) : (
              <a
                key={a.id}
                href={fullUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 rounded border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-700 hover:bg-gray-100"
              >
                <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
                <span className="max-w-[120px] truncate">{a.name}</span>
              </a>
            );
          })}
        </div>
      )}
      {previewImage && (
        <ImagePreview src={previewImage.url} alt={previewImage.name} onClose={() => setPreviewImage(null)} />
      )}
      <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-3 text-sm text-gray-500 transition hover:border-gray-400 hover:bg-gray-100">
        <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0l-4 4m4-4l4 4M4 20h16" />
        </svg>
        {uploading ? "Uploading..." : error ? <span className="text-red-500">{error}</span> : "Click to attach files"}
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/*,video/*,.pdf,.txt,.md"
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
          disabled={uploading}
          className="sr-only"
        />
      </label>
    </div>
  );
}
