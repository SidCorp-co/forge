"use client";

// An uploaded `text/html` attachment, rendered inline as an artifact instead of
// being offered as a download. The bytes are fetched here rather than pointed at
// with an iframe `src`: the download route sets `Content-Disposition: attachment`
// on html (`lib/attachment-headers.ts`), which a framed navigation obeys but
// `fetch` does not — so this is the only way to show the page without weakening
// that header for direct navigation.

import { useQuery } from "@tanstack/react-query";
import { HtmlArtifact, Icon, Spinner } from "@/design";
import { useRetryWait, useWaitAnnounced } from "@/design/hooks/use-retry-wait";
import { RetryWait } from "@/design/primitives/retry-wait";
import { apiFile } from "@/lib/api/client";
import { useAskedAgainAfterTheWait } from "@/lib/api/core-file";
import { coreFileUrl } from "@/lib/utils/core-url";
import { fileWaitWords, shownAgainWords } from "@/lib/utils/retry-rule";

const MAX_BYTES = 2 * 1024 * 1024;

/** Read through the client, so a refusal with a wait holds it like any read (ISS-1229 r55, judge-170). */
async function fetchArtifact(url: string): Promise<string> {
  return await (await apiFile(url)).text();
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
  useAskedAgainAfterTheWait(q.error, q.refetch);
  const wait = useRetryWait(q.isError ? q.error : null, shownAgainWords);
  useWaitAnnounced(q.isError ? q.error : null, fileWaitWords(q.error, name));

  // While the server's wait runs the file is not offered as a link either: opening it would ask around the hold.
  if (wait) {
    return (
      <div data-testid="html-attachment-held" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-line bg-surface px-3 py-2">
        <Icon name="folder" size={16} className="flex-none text-subtle" />
        <span className="fg-body-sm max-w-[14rem] truncate text-fg" title={name}>
          {name}
        </span>
        <span className="fg-caption flex-none">preview failed</span>
        <RetryWait wait={wait} testId="html-attachment" />
      </div>
    );
  }

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
