"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { useCopy } from "@/lib/i18n/interface-language";
import { coreFileUrl } from "@/lib/utils/core-url";

/* The board's SVG is fetched as bytes and shown through an <img>: the download route serves every
   attachment inert, and an SVG drawn by an <img> runs no script whatever it holds. */
async function fetchSvg(attachment: string): Promise<Blob> {
  const res = await fetch(coreFileUrl(`/api/attachments/${attachment}/download`), { credentials: "include" });
  if (!res.ok) throw new Error(`${res.status}`);
  return new Blob([await res.arrayBuffer()], { type: "image/svg+xml" });
}

export function WireframeThumb({ attachment, title }: { attachment: string; title: string }) {
  const t = useCopy();
  const q = useQuery({ queryKey: ["wireframe-svg", attachment], queryFn: () => fetchSvg(attachment), staleTime: 10 * 60_000 });
  const url = useMemo(() => (q.data ? URL.createObjectURL(q.data) : null), [q.data]);
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url]);
  if (!url) return null;
  // biome-ignore lint/performance/noImgElement: a blob URL of an attachment with no known intrinsic size; `next/image` cannot optimise it
  return <img src={url} alt={t("workflows.wireframeOf", { title })} data-testid="workflow-wireframe" />;
}
