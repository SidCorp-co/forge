"use client";

// What a verdict was written with, where a person reads a criterion's verdict (REQ-40 BC-4): its own
// evidence note, and each clip or picture it names, reachable from the criterion and played in place.
// A file that is neither opens from its link. The files are the issue's attachments behind the
// session, so a clip is fetched with the session's credentials and played from a local object URL.

import { releaseMediaKindOf } from "@forge/contracts/release-page";
import Image from "next/image";
import { useState } from "react";
import { useCopy } from "@/lib/i18n/interface-language";
import { coreFileUrl } from "@/lib/utils/core-url";
import { useMediaSrc } from "@/lib/utils/use-media-src";

export interface VerdictEvidenceFile {
  name: string;
  mime: string;
  /** Where the file is read from: `/api/attachments/<id>/download`. */
  url: string;
}

function Player({ file, kind }: { file: VerdictEvidenceFile; kind: "clip" | "picture" }) {
  const t = useCopy();
  const src = useMediaSrc(file.url, true);
  if (src.state === "loading") return <p className="text-12-5 text-muted">…</p>;
  if (src.state === "lost")
    return (
      <p className="text-12-5 text-muted" data-testid="verdict-file-lost">
        {t("common.evidence.lost")}
      </p>
    );
  return kind === "clip" ? (
    // muted: a QA screen recording has no spoken track, so there is nothing to caption
    <video className="mt-1 aspect-video w-full max-w-xl border border-line bg-sunken" src={src.src} controls muted preload="metadata" playsInline aria-label={file.name} data-testid="verdict-clip" />
  ) : (
    // A blob address of no known size: unoptimized, with Next's documented form for unknown dimensions.
    <Image className="mt-1 max-h-96 w-auto max-w-full border border-line" src={src.src} alt={file.name} width={0} height={0} sizes="100vw" unoptimized style={{ width: "auto", height: "auto" }} data-testid="verdict-picture" />
  );
}

function EvidenceFile({ file }: { file: VerdictEvidenceFile }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  const kind = releaseMediaKindOf(file.mime);
  if (kind === null)
    return (
      <a className="text-link hover:underline" href={coreFileUrl(file.url)} target="_blank" rel="noreferrer" data-testid="verdict-file-link">
        {t("common.evidence.open", { name: file.name })}
      </a>
    );
  return (
    <div data-testid="verdict-file" data-kind={kind}>
      <button type="button" className="text-left text-link hover:underline" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="verdict-file-toggle">
        {t(kind === "clip" ? "common.evidence.watch" : "common.evidence.see", { name: file.name })}
      </button>
      {open ? <Player file={file} kind={kind} /> : null}
    </div>
  );
}

/** The verdict's note and its files; nothing where it has neither. */
export function VerdictEvidence({ note, files, className }: { note: string | null; files: readonly VerdictEvidenceFile[]; className?: string }) {
  if (!note && files.length === 0) return null;
  return (
    <div className={className ?? "grid gap-1 text-12-5"} data-testid="verdict-evidence">
      {note ? (
        <p className="whitespace-pre-wrap text-muted" data-testid="verdict-note">
          {note}
        </p>
      ) : null}
      {files.map((f) => (
        <EvidenceFile key={`${f.url}`} file={f} />
      ))}
    </div>
  );
}
