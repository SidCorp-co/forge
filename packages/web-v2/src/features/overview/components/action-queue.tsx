"use client";

import { useState } from "react";
import {
  PageSection,
  PageSectionBody,
  SectionTitle,
} from "@/design";
import type { PulseActionKey } from "@forge/contracts/needs-you";
import { useCopy } from "@/lib/i18n/interface-language";
import { ageText } from "../derive";
import type { PulseResponse } from "../types";
import { RecordPanel } from "./record-panel";

export interface ActionQueueProps {
  pulse: PulseResponse;
}

/** Section 3 — what needs a person? */
export function ActionQueue({ pulse }: ActionQueueProps) {
  const [open, setOpen] = useState<PulseActionKey | null>(null);
  const rows = pulse.actions;
  const t = useCopy();

  return (
    <PageSection>
      <PageSectionBody className="flex flex-col gap-3">
        <SectionTitle className="fg-h3">{t("overview.actions.title")}</SectionTitle>

        {rows.length === 0 ? (
          <p className="fg-body-sm text-muted">
            {t("overview.actions.empty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {rows.map((row) => {
              const label = t(`overview.action.${row.key}`);
              const age = ageText(row.oldestSeconds, t);
              return (
              <li key={row.key}>
                <button
                  type="button"
                  onClick={() => setOpen(open === row.key ? null : row.key)}
                  aria-label={t(age === null ? "overview.actions.rowAria" : "overview.actions.rowAriaOldest", { label, n: row.count, age: age ?? "" })}
                  className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-md px-2 py-1.5 text-left hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                >
                  <span className="fg-h3 tabular-nums">{row.count}</span>
                  <span className="fg-body-sm min-w-0 flex-1">
                    <span className="block font-medium">{label}</span>
                    <span className="block text-muted">{t(`overview.action.${row.key}.hint`)}</span>
                  </span>
                  <span className="fg-body-sm shrink-0 text-subtle">
                    {t(`overview.owner.${row.owner}`)}
                  </span>
                  {age === null ? null : (
                    <span className="fg-body-sm shrink-0 tabular-nums text-subtle">
                      {t("overview.actions.oldest", { age })}
                    </span>
                  )}
                </button>
                {open === row.key ? (
                  <RecordPanel
                    title={label}
                    total={row.count}
                    records={row.records}
                    onClose={() => setOpen(null)}
                  />
                ) : null}
              </li>
              );
            })}
          </ul>
        )}
      </PageSectionBody>
    </PageSection>
  );
}
