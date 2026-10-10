"use client";

// A marker on a design's step or edge, settled where it is read: keep it, rewrite it, or delete it,
// recorded as the workflow decision that carries the node (REQ-17 BC-26). Core checks the approver.

import { NODE_DECISION_VERDICTS, type HealthMarker, type HealthNode, type NodeDecisionVerdict } from "@forge/contracts/workflow-health";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/design";
import { commentsApi } from "@/features/comments";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";

const sameTarget = (a: HealthNode["target"], b: HealthMarker["target"]) =>
  a.kind === "step" ? b.kind === "step" && a.step === b.step && a.layer === b.layer : b.kind === "edge" && a.from === b.from && a.to === b.to && a.label === b.label && a.layer === b.layer;

export function SettleMarker({ projectId, flow, marker, nodes }: { projectId: string; flow: string; marker: HealthMarker; nodes: readonly HealthNode[] }) {
  const t = useCopy();
  const qc = useQueryClient();
  const target = marker.target;
  const node = target.kind === "workflow" ? null : nodes.find((n) => sameTarget(n.target, target));
  const settle = useMutation({
    mutationFn: (verdict: NodeDecisionVerdict) => {
      if (target.kind === "workflow") throw new Error("a workflow-level marker names no node to settle");
      const where = target.kind === "step" ? target.step : `${target.from} to ${target.to}`;
      const common = { verdict, layer: target.layer, marker: marker.kind };
      return commentsApi.post(projectId, "workflow", flow, {
        intent: "decision",
        decision: {
          decision: `${verdict} ${where}`,
          reason: "Settled from the design page",
          node: target.kind === "step" ? { step: target.step, ...common } : { edge: { from: target.from, to: target.to, ...(target.label ? { label: target.label } : {}) }, ...common },
        },
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["workflow-health", projectId] });
      void qc.invalidateQueries({ queryKey: ["entity-decisions"] });
    },
  });
  if (!node) return null;
  if (node.decision) return <span className="text-12 text-subtle">{t("workflows.settle.done")}</span>;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {NODE_DECISION_VERDICTS.map((v) => (
        <Button key={v} type="button" size="sm" variant="ghost" loading={settle.isPending && settle.variables === v} disabled={settle.isPending} onClick={() => settle.mutate(v)}>
          {t(`workflows.settle.${v}`)}
        </Button>
      ))}
      <RefusalLine error={settle.error} />
    </span>
  );
}
