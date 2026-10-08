"use client";

import { Button, useUrlParams } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { movedPageOf } from "../moved";

/** One line on the page an old Decisions, Roadmap or Memory link landed on, saying where its record is now. */
export function MovedNotice() {
  const t = useCopy();
  const [params, setParams] = useUrlParams();
  const page = movedPageOf(params.get("moved"));
  if (!page) return null;
  return (
    <p className="flex flex-wrap items-baseline gap-x-3 border-b border-line-subtle px-5 py-2 text-13 text-muted max-md:px-3" role="status" data-testid="moved-notice">
      <span className="min-w-0 flex-1">{t(`shell.moved.${page}`)}</span>
      <Button size="sm" variant="ghost" onClick={() => setParams({ moved: null })}>
        {t("shell.moved.dismiss")}
      </Button>
    </p>
  );
}
