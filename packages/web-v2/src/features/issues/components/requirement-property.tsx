"use client";

// The issue rail's Requirement property: the requirement the issue delivers, which a person links
// or unlinks there. An issue serves one requirement, so a linked one is unlinked before another is
// picked; picking one asks before it links, since a link changes what the issue is read against.
// Core refuses a requirement not agreed yet, or one the issue cannot join, by name.

import Link from "next/link";
import { useState } from "react";
import { Button, ConfirmDialog, Select } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { requirementHref } from "@/lib/routes/requirements";
import { useIssueRequirementLink, useLinkableRequirements } from "../requirement-link";

export function IssueRequirementProperty({
  projectId,
  slug,
  issueKey,
  current,
  disabled,
}: {
  projectId: string;
  slug: string;
  issueKey: string;
  /** The requirement it delivers, by key; null while it delivers none. */
  current: string | null;
  disabled: boolean;
}) {
  const t = useCopy();
  const list = useLinkableRequirements(current || disabled ? undefined : projectId);
  const act = useIssueRequirementLink(projectId, issueKey);
  const [asking, setAsking] = useState<{ key: string; title: string } | null>(null);
  if (current) {
    return (
      <div className="grid justify-items-end gap-1" data-testid="issue-requirement">
        <span className="flex items-center gap-2">
          <Link href={requirementHref(slug, current)} className="font-mono text-12 font-semibold text-link hover:underline">
            {current}
          </Link>
          {disabled ? null : (
            <Button variant="ghost" size="sm" disabled={act.isPending} onClick={() => act.mutate({ req: current, unlink: true })} data-testid="issue-requirement-unlink">
              {t("issues.rail.requirementUnlink")}
            </Button>
          )}
        </span>
        <RefusalLine error={act.error} testid="issue-requirement-refusal" />
      </div>
    );
  }
  if (disabled) return <span className="fg-body-sm text-subtle">{t("issues.rail.requirementNone")}</span>;
  const options = (list.data ?? []).map((r) => ({ value: r.key, label: `${r.key} ${r.title}` }));
  return (
    <div className="grid justify-items-end gap-1" data-testid="issue-requirement">
      <Select
        aria-label={t("issues.rail.requirementPick")}
        placeholder={t("issues.rail.requirementPick")}
        value=""
        options={options}
        disabled={act.isPending || list.isLoading}
        onChange={(req) => setAsking({ key: req, title: list.data?.find((r) => r.key === req)?.title ?? "" })}
        className="w-48"
      />
      <RefusalLine error={act.error} testid="issue-requirement-refusal" />
      <ConfirmDialog
        open={asking !== null}
        title={t("issues.rail.requirementConfirmTitle", { issue: issueKey, req: asking?.key ?? "" })}
        message={t("issues.rail.requirementConfirm", { issue: issueKey, req: asking?.key ?? "", title: asking?.title ?? "" })}
        confirmLabel={t("issues.rail.requirementConfirmAct")}
        loading={act.isPending}
        onClose={() => setAsking(null)}
        onConfirm={() => asking && act.mutate({ req: asking.key, unlink: false }, { onSettled: () => setAsking(null) })}
      />
    </div>
  );
}
