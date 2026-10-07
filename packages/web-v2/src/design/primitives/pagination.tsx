"use client";

import { useCopy } from "@/lib/i18n/interface-language";
import { IconButton } from "./icon-button";

export interface PaginationProps {
  page: number;
  pageCount: number;
  onChange?: (page: number) => void;
}

export function Pagination({ page, pageCount, onChange }: PaginationProps) {
  const t = useCopy();
  return (
    <div className="flex items-center gap-2">
      <IconButton
        icon="chevronRight"
        size="sm"
        variant="secondary"
        aria-label={t("common.page.previous")}
        disabled={page <= 1}
        className="rotate-180"
        onClick={() => onChange?.(page - 1)}
      />
      <span className="font-mono text-muted" style={{ fontSize: "var(--text-12-5)" }}>
        {page} / {pageCount}
      </span>
      <IconButton
        icon="chevronRight"
        size="sm"
        variant="secondary"
        aria-label={t("common.page.next")}
        disabled={page >= pageCount}
        onClick={() => onChange?.(page + 1)}
      />
    </div>
  );
}
