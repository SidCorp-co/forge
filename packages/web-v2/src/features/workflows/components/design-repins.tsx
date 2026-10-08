"use client";

import Link from "next/link";
import { Button } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import type { Refusal } from "@/lib/api/refusals";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { workflowHref } from "@/lib/routes/workflows";
import { useRepinAct, useRepinPlan } from "../hooks";
import type { PinOnlyChange, RepinItem, RepinRefused } from "../types";

const pinsWords = (pins: PinOnlyChange["pins"], t: Copy) => pins.map((p) => t("workflows.pinOnly.pin", { flow: p.workflow, from: p.from, to: p.to })).join(", ");

const proofWords = (change: Pick<PinOnlyChange, "changed" | "fingerprint">, approved: number, t: Copy) =>
  t("workflows.pinOnly.proof", { r: approved, paths: change.changed.join(", "), fp: change.fingerprint.slice(0, 12) });

/** A proposal that only moves the revisions its bases are pinned at, named as such with the pins and the proof nothing else moved. */
export function PinOnlyReading({ change, approvedRevision }: { change: PinOnlyChange | null; approvedRevision: number | null }) {
  const t = useCopy();
  if (!change || approvedRevision === null) return null;
  return (
    <span className="grid basis-full gap-0.5 text-12-5" data-testid="design-pin-only">
      <span>
        <span className="font-semibold text-fg">{t("workflows.pinOnly.head")}</span>
        <span className="text-muted"> · {t("workflows.pinOnly.pins", { pins: pinsWords(change.pins, t) })}</span>
      </span>
      <span className="text-subtle" data-testid="design-pin-only-proof">
        {proofWords(change, approvedRevision, t)}
      </span>
    </span>
  );
}

const REFUSAL_WORDS = {
  WORKFLOW_REPIN_PENDING_CHANGE: "workflows.repins.refusal.pending",
  WORKFLOW_DESIGN_BASE_UNAPPROVED: "workflows.repins.refusal.unapproved",
  WORKFLOW_REPIN_CYCLE: "workflows.repins.refusal.cycle",
} as const;

const isRefusalCode = (code: string): code is keyof typeof REFUSAL_WORDS => code in REFUSAL_WORDS;

/** An act refusal in the viewer's words, from its code and the design it names; null leaves core's detail. */
const actRefusalWords = (t: Copy) => (r: Refusal) => {
  const flow = (r as Refusal & { flow?: unknown }).flow;
  return typeof flow === "string" && isRefusalCode(r.code) ? t(REFUSAL_WORDS[r.code], { flow }) : null;
};

const refusedWords = (r: RepinRefused, t: Copy) => {
  const code = r.refusal.code;
  return isRefusalCode(code) ? t(REFUSAL_WORDS[code], { flow: r.flow }) : t("workflows.repins.refusal.other", { flow: r.flow, code });
};

function ReadyRow({ item, slug }: { item: RepinItem; slug: string }) {
  const t = useCopy();
  return (
    <li className="grid min-w-0 gap-0.5 border-t border-line-subtle py-1.5 first:border-t-0" data-testid="repin-ready" data-flow={item.flow}>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <Link href={workflowHref(slug, item.flow)} className="font-mono text-12 font-semibold text-link hover:underline">
          {item.flow}
        </Link>
        <span className="text-fg">{pinsWords(item.pins, t)}</span>
        <span className="text-muted">
          {item.source === "proposal" ? t("workflows.repins.filed", { r: item.approves, who: item.proposedByName ?? "" }) : t("workflows.repins.written", { r: item.approves })}
        </span>
      </span>
      <span className="text-subtle">{proofWords(item.proof, item.approvedRevision, t)}</span>
    </li>
  );
}

/**
 * The base's pin-only dependents, cleared by one act: what it takes, in the order core approves them,
 * each with its pins and the proof nothing else changed, and what it will not take, each named.
 */
export function RepinPanel({ projectId, workflowId, slug }: { projectId: string; workflowId: string; slug: string }) {
  const t = useCopy();
  const plan = useRepinPlan(projectId, workflowId).data;
  const act = useRepinAct(projectId, workflowId);
  if (!plan || plan.base.approvedRevision === null || (plan.ready.length === 0 && plan.refused.length === 0 && !act.isSuccess)) return null;
  const n = plan.ready.length;
  const r = plan.base.approvedRevision;
  const take = () => act.mutate({ revision: r, designs: plan.ready.map((i) => ({ workflowId: i.workflowId, revision: i.revision })) });
  return (
    <section className="grid gap-2 border-b border-line-subtle px-6 py-2.5 text-12-5 max-md:px-4" data-testid="design-repins">
      {n > 0 ? (
        <>
          <span className="grid gap-0.5">
            <span className="text-13 font-semibold text-fg">{t(n === 1 ? "workflows.repins.headOne" : "workflows.repins.headMany", { n, r })}</span>
            <span className="text-muted">{t("workflows.repins.why")}</span>
          </span>
          <ul className="grid max-w-[720px]">
            {plan.ready.map((item) => (
              <ReadyRow key={item.workflowId} item={item} slug={slug} />
            ))}
          </ul>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button size="sm" variant="primary" onClick={take} disabled={!plan.canDecide || act.isPending} data-testid="repin-act">
              {t(n === 1 ? "workflows.repins.actOne" : "workflows.repins.actMany", { n })}
            </Button>
            {plan.canDecide ? null : <span className="text-muted">{t("workflows.repins.approverOnly")}</span>}
          </span>
        </>
      ) : null}
      {act.isSuccess ? (
        <span className="font-medium text-fg" data-testid="repin-done">
          {t("workflows.repins.done", { n: act.data.approved.length })}
        </span>
      ) : null}
      <RefusalLine error={act.isError ? act.error : null} testid="repin-error" words={actRefusalWords(t)} />
      {plan.refused.length > 0 ? (
        <span className="grid gap-0.5">
          <span className="font-semibold text-fg">{t("workflows.repins.notTaken")}</span>
          <ul className="grid max-w-[720px]">
            {plan.refused.map((x) => (
              <li key={x.workflowId} className="border-t border-line-subtle py-1 text-muted first:border-t-0" data-testid="repin-refused" data-code={x.refusal.code}>
                {refusedWords(x, t)}
              </li>
            ))}
          </ul>
        </span>
      ) : null}
    </section>
  );
}
