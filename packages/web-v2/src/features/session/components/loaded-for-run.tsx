"use client";

import { CardTitle, MonoTag } from "@/design";
import type { SessionMetadata } from "@/features/sessions/types";

interface LoadedLink {
  link: string;
  contract: { provider: string; slug: string };
  paths: string[];
  from: string;
  to: string | null;
  diffNote: "measured" | "already-on-latest" | "no-version-recorded";
  guideNotes: number;
  changes: number;
}

interface ContractContextRecord {
  source: string;
  loadedAt: string;
  links: LoadedLink[];
}

const DIFF_LABEL: Record<LoadedLink["diffNote"], string> = {
  measured: "",
  "already-on-latest": "already on latest, no diff",
  "no-version-recorded": "no version recorded, no diff",
};

/** The `contractContext` core stamped on the session: which link contracts the run was given, and why. */
export function contractContextOf(metadata: SessionMetadata | null): ContractContextRecord | null {
  const raw = metadata?.contractContext as ContractContextRecord | undefined;
  return raw && Array.isArray(raw.links) && raw.links.length > 0 ? raw : null;
}

export function LoadedForRun({ metadata }: { metadata: SessionMetadata | null }) {
  const record = contractContextOf(metadata);
  if (!record) return null;
  return (
    <section>
      <CardTitle className="fg-caption sticky top-0 z-10 mb-2 bg-app py-1 uppercase tracking-wide">
        {`Loaded for this run · ${record.links.length}`}
      </CardTitle>
      <ul className="flex flex-col gap-2">
        {record.links.map((l) => (
          <li key={l.link} className="flex flex-col gap-0.5 overflow-hidden">
            <div className="flex items-center gap-2 overflow-hidden">
              <span className="flex-1 truncate fg-body-sm" title={l.link}>
                {l.contract.slug}
              </span>
              <MonoTag hue="cobalt">
                {l.from} → {l.to ?? "—"}
              </MonoTag>
            </div>
            <span className="fg-caption truncate" title={l.paths.join(", ")}>
              {l.paths.join(", ")}
            </span>
            <span className="fg-caption">
              {l.guideNotes} guide note{l.guideNotes === 1 ? "" : "s"} ·{" "}
              {l.diffNote === "measured" ? `${l.changes} change${l.changes === 1 ? "" : "s"}` : DIFF_LABEL[l.diffNote]}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
