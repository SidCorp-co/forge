// What the requirement builds on, linked and unlinked by hand: the designs of this project it serves,
// and the contracts its project publishes or consumes. A link is the requirement's, not one revision's;
// the next agree or re-pin pins each design's approved revision and each contract's current version.
// Core decides every link and refuses by name (REQUIREMENT_CONTRACT_UNKNOWN, a design not in the project).

import { useState } from "react";
import { Button, FactsEmpty, FactsGroup, IconButton, Select, StatusBadge, Tooltip } from "@/design";
import { useWorkflows } from "@/features/workflows";
import { Link } from "@/lib/navigation/router";
import { workflowHref } from "@/lib/routes/workflows";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useLinkableContracts, useRequirementLink } from "../hooks";
import type { RequirementDetail } from "../types";

/** A pick from `options` and the act that links it; closed, one button opens it. */
function LinkPick({ label, open, options, testId, onLink, busy }: { label: string; open: string; options: { value: string; label: string }[]; testId: string; onLink: (ref: string) => void; busy: boolean }) {
  const t = useCopy();
  const [shown, setShown] = useState(false);
  const [picked, setPicked] = useState("");
  if (!shown) {
    return (
      <Button variant="ghost" size="sm" icon="plus" onClick={() => setShown(true)} data-testid={`${testId}-open`}>
        {open}
      </Button>
    );
  }
  return (
    <form
      className="grid gap-2 pt-1.5"
      data-testid={testId}
      onSubmit={(e) => {
        e.preventDefault();
        if (picked) onLink(picked);
        setPicked("");
        setShown(false);
      }}
    >
      {options.length === 0 ? <FactsEmpty>{t("requirements.links.noneToLink")}</FactsEmpty> : <Select options={options} value={picked} onChange={setPicked} placeholder={label} aria-label={label} />}
      <span className="flex items-center gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={!picked || busy}>
          {t("requirements.links.link")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setShown(false)}>
          {t("common.cancel")}
        </Button>
      </span>
    </form>
  );
}

/** The designs it serves, each with its approval; linked and unlinked here while it is not done. */
export function RequirementDesigns({ projectId, slug, d, editable }: { projectId: string; slug: string; d: RequirementDetail; editable: boolean }) {
  const t = useCopy();
  const link = useRequirementLink(projectId, d.key);
  const designs = useWorkflows(editable ? projectId : undefined).data?.workflows ?? [];
  const linked = new Set(d.workflows.map((w) => w.workflowId));
  const options = designs.filter((w) => !linked.has(w.document.id)).map((w) => ({ value: w.document.id, label: w.document.title }));
  return (
    <FactsGroup title={t("requirements.facts.design")} testId="facts-design">
      {d.workflows.length === 0 ? (
        <FactsEmpty>{t("requirements.facts.noDesign")}</FactsEmpty>
      ) : (
        <ul className="grid gap-1">
          {d.workflows.map((w) => (
            <li key={w.workflowId} className="flex min-w-0 items-center gap-1.5 text-13" data-testid="rail-design">
              <Link href={workflowHref(slug, w.flow)} className="min-w-0 flex-1 truncate text-link hover:underline">
                {w.title}
              </Link>
              {w.designStatus ? (
                <Tooltip label={w.approvedRevision !== null ? t("requirements.facts.newestApproved", { r: w.approvedRevision }) : t("requirements.facts.noApproved")}>
                  <span className="inline-flex">
                    <StatusBadge family="design" value={w.designStatus} />
                  </span>
                </Tooltip>
              ) : null}
              {editable ? <IconButton icon="x" size="sm" aria-label={t("requirements.links.unlink", { name: w.title })} disabled={link.isPending} onClick={() => link.mutate({ to: "workflow", ref: w.workflowId, unlink: true })} /> : null}
            </li>
          ))}
        </ul>
      )}
      {editable ? <LinkPick label={t("requirements.links.pickDesign")} open={t("requirements.links.linkDesign")} options={options} testId="link-design" busy={link.isPending} onLink={(ref) => link.mutate({ to: "workflow", ref })} /> : null}
      <RefusalLine error={link.error} testid="link-design-refusal" />
    </FactsGroup>
  );
}

/** The contracts it builds on, each with the version an agree would pin; linked and unlinked here. */
export function RequirementContracts({ projectId, slug, d, editable }: { projectId: string; slug: string; d: RequirementDetail; editable: boolean }) {
  const t = useCopy();
  const link = useRequirementLink(projectId, d.key);
  const linkable = useLinkableContracts(editable ? projectId : undefined, slug).data ?? [];
  const linked = new Set(d.contracts.map((c) => c.contract));
  const options = linkable.filter((c) => !linked.has(c)).map((c) => ({ value: c, label: c }));
  return (
    <FactsGroup title={t("requirements.links.contracts")} testId="facts-contracts">
      {d.contracts.length === 0 ? (
        <FactsEmpty>{t("requirements.links.noContract")}</FactsEmpty>
      ) : (
        <ul className="grid gap-1">
          {d.contracts.map((c) => (
            <li key={c.contract} className="flex min-w-0 items-center gap-1.5 text-13" data-testid="rail-contract">
              <span className="min-w-0 flex-1 truncate font-mono text-12">{c.contract}</span>
              <span className="flex-none font-mono text-12 text-muted" title={t("requirements.links.pinsAt")}>
                {c.currentVersion ?? t("requirements.links.noVersion")}
              </span>
              {editable ? (
                <IconButton icon="x" size="sm" aria-label={t("requirements.links.unlink", { name: c.contract })} disabled={link.isPending} onClick={() => link.mutate({ to: "contract", ref: c.contract, unlink: true })} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editable ? (
        <LinkPick label={t("requirements.links.pickContract")} open={t("requirements.links.linkContract")} options={options} testId="link-contract" busy={link.isPending} onLink={(ref) => link.mutate({ to: "contract", ref })} />
      ) : null}
      <RefusalLine error={link.error} testid="link-contract-refusal" />
    </FactsGroup>
  );
}
