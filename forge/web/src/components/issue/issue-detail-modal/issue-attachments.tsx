'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { strapiMediaUrl } from '@/lib/api/client';
import { FileUpload } from '@/components/ui/file-upload';
import { ImagePreview } from '@/components/ui/image-preview';
import { issueApi } from '@/features/issue/api/issue-api';

interface Attachment {
  id: number;
  url: string;
  name: string;
  mime: string;
}

interface IssueAttachmentsProps {
  attachments: Attachment[];
  issueDocumentId: string;
  onUpdate: (id: string, data: Record<string, any>) => void;
}

export function IssueAttachments({ attachments, issueDocumentId, onUpdate }: IssueAttachmentsProps) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const imageAttachments = attachments?.filter((a) => /^image\//.test(a.mime)).map((a) => ({ url: strapiMediaUrl(a.url), name: a.name })) ?? [];

  return (
    <div className="w-full">
      {attachments && attachments.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-3">
          {attachments.map((a) => {
            const isImage = /^image\//.test(a.mime);
            const fullUrl = strapiMediaUrl(a.url);
            const handleDelete = (e: React.MouseEvent) => {
              e.preventDefault();
              e.stopPropagation();
              const remainingIds = attachments
                .filter((att) => att.id !== a.id)
                .map((att) => att.id);
              onUpdate(issueDocumentId, { attachments: remainingIds } as any);
            };
            const isVideo = /^video\//.test(a.mime);
            return (
              <div key={a.id} className="group relative">
                {isImage ? (
                  <button
                    type="button"
                    onClick={() => setPreviewIndex(imageAttachments.findIndex((img) => img.url === fullUrl))}
                    className="flex items-center gap-2 rounded-sm border border-outline-variant/50 bg-surface-container-low px-2.5 py-2 pr-7 text-[10px] font-mono tracking-widest text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface cursor-zoom-in transition-colors uppercase"
                  >
                    <img src={fullUrl} alt={a.name} className="h-10 w-10 rounded-sm object-cover" />
                    <span className="max-w-[80px] truncate sm:max-w-[120px]">{a.name}</span>
                  </button>
                ) : isVideo ? (
                  <div className="overflow-hidden rounded-sm border border-outline-variant/50 bg-surface-container-low pr-7">
                    <video src={fullUrl} controls preload="metadata" className="max-h-48 max-w-xs rounded-sm" />
                    <p className="truncate px-2.5 py-1 text-[10px] font-mono text-on-surface-variant">{a.name}</p>
                  </div>
                ) : (
                  <a
                    href={fullUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 rounded-sm border border-outline-variant/50 bg-surface-container-low px-2.5 py-2 pr-7 text-[10px] font-mono tracking-widest text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors uppercase"
                  >
                    <svg className="h-4 w-4 text-outline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                    </svg>
                    <span className="max-w-[80px] truncate sm:max-w-[120px]">{a.name}</span>
                  </a>
                )}
                <button
                  type="button"
                  onClick={handleDelete}
                  className="absolute -right-1.5 -top-1.5 rounded-sm bg-surface border border-outline-variant/50 p-0.5 text-outline opacity-0 shadow hover:border-danger hover:text-danger group-hover:opacity-100 transition-all"
                  title="Remove attachment"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {previewIndex !== null && (
        <ImagePreview images={imageAttachments} initialIndex={previewIndex} onClose={() => setPreviewIndex(null)} />
      )}
      <FileUpload
        value={[]}
        onChange={(newFiles) => {
          const existingIds = attachments?.map((a) => a.id) ?? [];
          const allIds = [...existingIds, ...newFiles.map((f) => f.id)];
          onUpdate(issueDocumentId, { attachments: allIds } as any);
        }}
        uploadFn={issueApi.uploadFile}
      />
    </div>
  );
}
