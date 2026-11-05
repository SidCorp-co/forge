// A release's one proof number drawn once (ISS-1001): a bar of its criteria proven of their total,
// where they were judged, and how many issues it carries; and the short tags of what needs the
// decider's attention. The list row and the page header both draw these, from `proof.ts`.

import { ProgressBar } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";
import type { ReleaseProof } from "../proof";

export function ReleaseProofBar({ proof, issues, className }: { proof: ReleaseProof | null; issues: number; className?: string }) {
  const t = useCopy();
  const parts = [
    ...(proof ? [t("releases.proof.of", { proven: proof.proven, total: proof.total })] : []),
    ...(proof?.on ? [t("releases.proof.on", { env: proof.on })] : []),
    t("releases.issuesCount", { n: issues }),
  ];
  return (
    <span className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-1", className)} data-testid="release-proof" data-proven={proof?.proven} data-total={proof?.total}>
      {proof ? (
        <span className="w-40 max-md:w-28" title={t("releases.proof.label", { proven: proof.proven, total: proof.total })}>
          <ProgressBar value={(proof.proven / proof.total) * 100} tone={proof.proven === proof.total ? "green" : "accent"} className="h-1.5" />
        </span>
      ) : null}
      <span className="text-12-5 text-muted tabular-nums">{parts.join(" · ")}</span>
    </span>
  );
}

export interface ReleaseTag {
  key: string;
  text: string;
  tone: "warn" | "info";
}

export function ReleaseTags({ tags }: { tags: readonly ReleaseTag[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1.5" data-testid="release-tags">
      {tags.map((tag) => (
        <span
          key={tag.key}
          data-tag={tag.key}
          className={cn(
            "whitespace-nowrap rounded-sm border px-1.5 text-11-5",
            tag.tone === "warn" ? "border-warn-7 text-warn-11" : "border-info-7 text-info-11",
          )}
        >
          {tag.text}
        </span>
      ))}
    </span>
  );
}
