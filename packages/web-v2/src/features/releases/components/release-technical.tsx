// The Technical view's addition to a release page (BC-9): the build, the range the release run read,
// and the migrations, contracts, dependencies and settings it ships, with what it changes behind a
// fold. Never drawn from a page that carries no technical notes (the Overview and every share).

import type { ReleasePage } from "@forge/contracts/release-page";
import { useState } from "react";
import { Section } from "@/design";
import { useCopy, useLabel } from "@/lib/i18n/interface-language";
import { DisclosureToggle, shortSha } from "./release-bits";
import { ANCHOR, GROUP_TITLE } from "./release-anchors";
import { changesSentence, WhatChanges } from "./release-changes";

function List({ title, items, testId }: { title: string; items: string[]; testId: string }) {
  const t = useCopy();
  return (
    <div data-testid={testId}>
      <h3 className="mb-1 text-12-5 font-medium text-muted">{title}</h3>
      {items.length === 0 ? (
        <p className="text-13 text-muted">{t("releases.page.technical.none")}</p>
      ) : (
        <ul className="divide-y divide-line-subtle border-y border-line-subtle">
          {items.map((i) => (
            <li key={i} className="break-all py-1.5 font-mono text-13">
              {i}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The Technical view's addition (BC-9): the build, the range, and what it ships; never drawn from a page that carries none. */
export function Technical({ page, slug }: { page: ReleasePage; slug?: string | undefined }) {
  const t = useCopy();
  const label = useLabel();
  const [open, setOpen] = useState(false);
  const tech = page.technical;
  if (!tech) return null;
  return (
    <Section id={ANCHOR.technical} title={t(GROUP_TITLE.technical)} testId="page-technical">
      <div className="grid gap-5">
        <p className="text-13 text-muted" data-testid="page-technical-range" data-read={page.shipped.state}>
          {page.header.build ? <span className="mr-2 font-mono text-fg">{shortSha(page.header.build)}</span> : null}
          {page.shipped.state === "read"
            ? t("releases.page.technical.range", { base: shortSha(page.shipped.base), head: shortSha(page.shipped.head) })
            : t("releases.page.technical.unread", { why: page.shipped.why })}
        </p>
        <List title={t("releases.page.technical.migrations")} items={tech.migrations} testId="page-technical-migrations" />
        <List title={t("releases.page.technical.contracts")} items={tech.contracts} testId="page-technical-contracts" />
        <List title={t("releases.page.technical.dependencies")} items={tech.dependencies} testId="page-technical-dependencies" />
        <List title={t("releases.page.technical.settings")} items={tech.settings} testId="page-technical-settings" />
        <div data-testid="release-technical">
          <DisclosureToggle open={open} onToggle={() => setOpen((o) => !o)} className="text-13" testId="release-technical-toggle">
            {t("releases.page.technical.changes")}
          </DisclosureToggle>
          <span className="ml-2 text-13 text-muted">{changesSentence(tech.changes, t, label)}</span>
          {open ? (
            <div className="mt-3">
              <WhatChanges changes={tech.changes} headed={false} {...(slug ? { slug } : {})} />
            </div>
          ) : null}
        </div>
      </div>
    </Section>
  );
}
