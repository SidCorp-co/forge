"use client";

// An uploaded `text/html` attachment, rendered inline as an artifact instead of
// being offered as a download. The bytes are fetched here rather than pointed at
// with an iframe `src`: the download route sets `Content-Disposition: attachment`
// on html (`lib/attachment-headers.ts`), which a framed navigation obeys but
// `fetch` does not — so this is the only way to show the page without weakening
// that header for direct navigation.

import { useQuery } from "@tanstack/react-query";
import { HtmlArtifact, Icon, Spinner } from "@/design";
import { coreFileUrl } from "@/lib/utils/core-url";

const MAX_BYTES = 2 * 1024 * 1024;

async function fetchArtifact(url: string): Promise<string> {
  const res = await fetch(coreFileUrl(url), { credentials: "include" });
  if (!res.ok) throw new Error(`${res.status}`);
  return await res.text();
}

export function HtmlAttachmentCard({
  name,
  url,
  size,
}: {
  name: string;
  url: string;
  size: number;
}) {
  const oversize = size > MAX_BYTES;
  const q = useQuery({
    queryKey: ["attachment-html", url],
    queryFn: () => fetchArtifact(url),
    enabled: !oversize,
    staleTime: 5 * 60 * 1000,
  });

  if (oversize || q.isError) {
    return (
      <a
        href={coreFileUrl(url)}
        target="_blank"
        rel="noreferrer noopener"
        className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 hover:bg-hover"
      >
        <Icon name="folder" size={16} className="flex-none text-subtle" />
        <span className="fg-body-sm max-w-[14rem] truncate text-fg" title={name}>
          {name}
        </span>
        <span className="fg-caption flex-none">
          {oversize ? "too large to preview" : "preview failed"}
        </span>
      </a>
    );
  }

  if (q.isPending) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2">
        <Spinner size={14} />
        <span className="fg-caption text-muted">{name}</span>
      </div>
    );
  }

  return <HtmlArtifact html={q.data} title={name} className="w-full" />;
}
