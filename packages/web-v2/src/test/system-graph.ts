// A system-context design as core's system-graph read serves it: a clinic app with a clerk, two payment
// providers in one outside boundary and two messaging services in another, each of which the
// Boundaries view folds into a single box. The vitest test and the screen witness of a folded box's
// changes both draw this one.

import { systemContext } from "@forge/contracts/workflow-template-systems";
import type { DesignDiff, StepMark } from "@/features/workflows/design-diff";
import type { GraphNode, SystemGraph } from "@/features/workflows/types";

export const graphNode = (id: string, kind: GraphNode["kind"], name: string, boundary: string | null = null): GraphNode => ({
  id,
  kind,
  title: name,
  name,
  purpose: "",
  owner: null,
  boundary,
  integration: null,
  mark: null,
  removed: false,
});

/** The folded boundary: its label wraps to two lines in a box, beside the box's member count. */
export const PAYMENTS = "outside:payments";
/** A second folded boundary, which a reader opens while the payment providers stay folded. */
export const MESSAGING = "outside:messaging";

const uses = systemContext.edgeKinds.find((k) => k.id === "uses");
if (!uses) throw new Error("the system-context template declares no `uses` line");

export const clinicGraph: SystemGraph = {
  workflowId: "w-1",
  revision: 2,
  against: 1,
  focal: { boundary: null, title: "Clinic app", tip: "", purpose: "", parts: ["app"] },
  nodes: [graphNode("clerk", "person", "Front-desk clerk"), graphNode("app", "system", "Clinic app"), graphNode("card", "external", "Card processor", "payments"), graphNode("bank", "external", "Bank transfers", "payments"), graphNode("sms", "external", "SMS gateway", "messaging"), graphNode("mail", "external", "Email service", "messaging")],
  relationships: [
    { id: "r1", from: "clerk", to: "app", label: "books visits", technology: null, kind: uses },
    { id: "r2", from: "app", to: "card", label: "takes card payments", technology: null, kind: uses },
    { id: "r3", from: "app", to: "bank", label: "sends invoices", technology: null, kind: uses },
    { id: "r4", from: "app", to: "sms", label: "texts reminders", technology: null, kind: uses },
    { id: "r5", from: "app", to: "mail", label: "emails receipts", technology: null, kind: uses },
  ],
  boundaries: [
    { id: PAYMENTS, lane: "payments", side: "outside", label: "Payment providers", tip: "", members: ["card", "bank"] },
    { id: MESSAGING, lane: "messaging", side: "outside", label: "Messaging", tip: "", members: ["sms", "mail"] },
  ],
  facts: { people: [], externals: 4, boundaries: [], namedBoundaries: 2 },
};

/** Core's diff as the canvas reads it, marking the named steps. */
export const graphDiff = (steps: Record<string, StepMark>): DesignDiff => ({ steps: new Map(Object.entries(steps)), edges: new Map(), removed: [] });
