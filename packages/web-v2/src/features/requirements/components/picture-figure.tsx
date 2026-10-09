"use client";

// The frame every requirement picture is drawn in (REQ-35 BC-11, BC-12): its rough-sketch label,
// what else the reader is told about it, and its text alternative as its accessible name.

import type { PictureKind } from "@forge/contracts/requirement-pictures";
import type { ReactNode } from "react";
import { useCopy } from "@/lib/i18n/interface-language";

/** One picture's frame: its rough-sketch label, who drew it, and its text alternative as its accessible name. */
export function Figure({ alt, kind, sample, by, children }: { alt: string; kind: PictureKind | "workflow"; sample?: boolean; by?: ReactNode; children: ReactNode }) {
  const t = useCopy();
  return (
    <figure aria-label={alt} className="m-0 grid min-w-0 gap-2" data-testid="picture-figure" data-picture={kind}>
      <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 text-12 text-muted">
        <span className="rounded-sm border border-dashed border-line-strong px-1.5 py-0.5 font-semibold text-fg" data-testid="rough-sketch">
          {t("requirements.picture.roughSketch")}
        </span>
        {sample ? <span className="font-semibold">{t("requirements.picture.sample")}</span> : null}
        {by}
      </figcaption>
      {children}
    </figure>
  );
}

