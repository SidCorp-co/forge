import { useState } from "react";
import type { Issue } from "@/lib/types";
import { strapiMediaUrl } from "@/lib/api";
import { FileUpload } from "../ui/file-upload";
import { ImagePreview } from "../ui/image-preview";

interface Props {
  issue: Issue;
  onUpdate: (id: string, data: Partial<Issue>) => void;
}

export function IssueAttachments({ issue, onUpdate }: Props) {
  const [previewImage, setPreviewImage] = useState<{ url: string; name: string } | null>(null);

  return (
    <div className="px-6 py-3">
      <h3 className="mb-2 text-sm font-semibold text-gray-900">Attachments</h3>
      {issue.attachments && issue.attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {issue.attachments.map((a) => {
            const isImage = /^image\//.test(a.mime);
            const isVideo = /^video\//.test(a.mime);
            const fullUrl = strapiMediaUrl(a.url);
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
      <FileUpload
        value={[]}
        onChange={(newFiles) => {
          const existingIds = issue.attachments?.map((a) => a.id) ?? [];
          const allIds = [...existingIds, ...newFiles.map((f) => f.id)];
          onUpdate(issue.documentId, { attachments: allIds } as any);
        }}
      />
    </div>
  );
}
