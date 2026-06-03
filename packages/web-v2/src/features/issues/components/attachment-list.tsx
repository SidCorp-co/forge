"use client";

// Shared attachment renderer (ISS-363). Extracted from issue-detail-screen's
// `AttachmentGrid` so both the issue-level attachments card and per-comment
// attachments render identically. Images become clickable thumbnails (open
// full size in a new tab); everything else is a download link with name + size.
// Accepts the minimal `{ id; name; mime; size; url }` shape so it works for
// both issue attachments and comment attachments.

import { Icon } from "@/design";
import { coreFileUrl } from "@/lib/api/client";

export interface AttachmentListItem {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AttachmentList({ rows }: { rows: AttachmentListItem[] }) {
  return (
    <ul className="flex flex-wrap gap-3">
      {rows.map((a) => {
        const href = coreFileUrl(a.url);
        const isImage = a.mime.startsWith("image/");
        return (
          <li key={a.id}>
            {isImage ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                title={`${a.name} · ${formatBytes(a.size)}`}
                className="block overflow-hidden rounded-md border border-line hover:border-line-strong"
              >
                {/* biome-ignore lint/a11y/useAltText: alt is the file name */}
                <img src={href} alt={a.name} className="h-28 w-28 object-cover" loading="lazy" />
              </a>
            ) : (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 hover:bg-hover"
              >
                <Icon name="folder" size={16} className="flex-none text-subtle" />
                <span className="fg-body-sm max-w-[14rem] truncate text-fg" title={a.name}>
                  {a.name}
                </span>
                <span className="fg-caption flex-none">{formatBytes(a.size)}</span>
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}
