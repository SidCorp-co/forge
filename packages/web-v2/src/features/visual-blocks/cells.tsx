"use client";

import type { ReportCell, ReportField } from "@forge/contracts/report-queries";
import { cellText } from "@forge/contracts/visual-blocks";
import Link from "next/link";
import { useVisualBlockContext } from "./context";
import { refHref } from "./ref-link";

/** One frame cell as it is read: a `ref` is a link to what it names when the project is known, everything else is its text. */
export function Cell({ field, cell }: { field: ReportField; cell: ReportCell | undefined }) {
  const { projectSlug } = useVisualBlockContext();
  const text = cellText(field, cell);
  if (field.type === "ref" && typeof cell === "string" && cell !== "" && projectSlug) {
    return (
      <Link className="font-mono font-semibold text-link hover:underline" href={refHref(projectSlug, cell)}>
        {text}
      </Link>
    );
  }
  return <>{text}</>;
}
