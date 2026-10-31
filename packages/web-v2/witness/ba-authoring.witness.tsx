// The BA's authoring screens (lane 3) as drawn: a new revision opened on an agreed requirement with a
// criterion written as Given / When / Then steps beside the rail that links its designs and contracts;
// a design's Edit view under the banner that says whom it waits on; and the New design dialog. Each in
// the light theme and again in the dark one, at desktop and phone width. Every stage fails a page that
// scrolls sideways, a control cut off at the window's edge, or a part that is not drawn.
//
//   pnpm --filter web-v2 witness witness/ba-authoring.witness.tsx --out <dir>

import { BUILTIN_WORKFLOW_TEMPLATES, type WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { RequirementPage } from "@/features/requirements/components/requirement-detail";
import type { RequirementDetail, RequirementRevision } from "@/features/requirements/types";
import { NewDesign } from "@/features/workflows/components/new-design";
import { WorkflowDesignPage } from "@/features/workflows/components/workflow-design-page";
import type { WorkflowDesign, WorkflowRecord } from "@/features/workflows/types";
import { RULE, say, waitingOn } from "@/test/said";
import { reqDetail } from "@/test/vi-chrome-requirements";
import { settle, sideways, windowWidth } from "./connect-flow.fixture";
import "./entry";
import { InRouter } from "./router";

const PROJECT = "7f1c1d1e-0000-4000-8000-000000000001";
const AT = "2026-10-07T10:00:00.000Z";
const STATES = BUILTIN_WORKFLOW_TEMPLATES.find((x) => x.id === "state-machine") as WorkflowTemplate;
const FLOWS = BUILTIN_WORKFLOW_TEMPLATES.find((x) => x.id === "operational-flow") as WorkflowTemplate;

const head = reqDetail.revisions.find((r) => r.state === "current") as RequirementRevision;
const agreed = {
  ...reqDetail,
  status: "agreed",
  revisions: [head],
  contracts: [{ providerProjectId: "p2", contract: "kho/api", contractSlug: "api", currentVersion: "1.2.0" }],
  standing: { ...reqDetail.standing, attentionGroup: "moving" },
} as RequirementDetail;

const DESIGN_DOC = {
  $schema: "https://forge.sidcorp.co/schemas/workflow-v2.json",
  version: 2,
  project: PROJECT,
  flow: "dat-lich-kham",
  kind: "state",
  title: "Đặt lịch khám",
  summary: "A patient books a visit; it is held or cancelled.",
  template: { id: "state-machine", version: 1 },
  steps: [
    { id: "start", does: "The machine starts.", after: [], node: { type: "INITIAL" } },
    { id: "booked", does: "The visit is booked.", after: ["start"], node: { type: "STATE", label: "Booked", owner: "Front desk" } },
    { id: "done", does: "The visit happened.", after: ["booked"], node: { type: "FINAL", label: "Done" } },
  ],
  edges: [
    { from: "start", to: "booked", label: "booking.made" },
    { from: "booked", to: "done", label: "visit.held", onFailure: "the slot is released" },
  ],
  writtenBy: {},
  id: "w-1",
  createdAt: AT,
  updatedAt: AT,
};
const record = { revision: 2, writer: "u-1", writerName: "Lan", document: DESIGN_DOC, design: { status: "draft", approvedRevision: null } } as unknown as WorkflowRecord;
const design = {
  workflowId: "w-1",
  flow: "dat-lich-kham",
  status: "draft",
  revision: 2,
  proposedRevision: null,
  approvedRevision: null,
  approver: "workflow-designs.approve",
  canDecide: false,
  waitingOn: waitingOn("agent", { who: say("standing.who.named", { name: "Lan" }), act: say("designs.act.finish"), rule: RULE }),
  revisions: [],
  builds: [],
  gate: { open: false, rule: "held", says: { rule: "held" } },
  requirements: [],
  approvalBlocked: null,
  approvalLeavesStale: [],
  pinOnly: null,
} as unknown as WorkflowDesign;

const EXAMPLE = { ...DESIGN_DOC, flow: "case-lifecycle", title: "Follow-up case" };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input), "http://witness.test").pathname.replace(/^\/api/, "");
  if ((init?.method ?? "GET") !== "GET") return new Promise<Response>(() => {});
  if (path.endsWith("/workflow-templates/state-machine/1")) return json({ origin: "builtin", template: STATES, example: EXAMPLE });
  if (path === `/projects/${PROJECT}/interface`) return json({ declared: true, document: { publishes: { events: {} }, consumes: [{ contract: "kho/api" }] } });
  if (path === `/projects/${PROJECT}/workflows`) return json({ workflows: [record], returned: 1 });
  return new Promise<Response>(() => {});
};

const root = createRoot(document.getElementById("root") as HTMLElement);

function client(): QueryClient {
  const c = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  c.setQueryData(["requirement", PROJECT, "REQ-1"], agreed);
  return c;
}

type Screen = "revision" | "design" | "new";
function show(screen: Screen) {
  const body =
    screen === "revision" ? (
      <RequirementPage projectId={PROJECT} slug="hop" reqKey="REQ-1" tab="revisions" onTab={() => {}} />
    ) : screen === "design" ? (
      <WorkflowDesignPage projectId={PROJECT} slug="hop" d={design} record={record} template={STATES} tab="edit" onTab={() => {}} />
    ) : (
      <div className="p-6">
        <NewDesign projectId={PROJECT} slug="hop" templates={[STATES, FLOWS]} canWrite />
      </div>
    );
  root.render(
    <InRouter key={`${screen}-${Math.random()}`} at="/projects/hop/requirements/REQ-1" pattern="/projects/$slug/requirements/$requirement">
      <QueryClientProvider client={client()}>
        <div className="min-h-screen bg-app text-fg">{body}</div>
      </QueryClientProvider>
    </InRouter>,
  );
}

const q = <T extends Element = HTMLElement>(sel: string, from: ParentNode = document) => from.querySelector<T>(sel);
const all = (sel: string, from: ParentNode = document) => [...from.querySelectorAll<HTMLElement>(sel)];

async function until(test: () => boolean, what: string): Promise<string[]> {
  for (let i = 0; i < 60; i += 1) {
    if (test()) return [];
    await settle(50);
  }
  return [`${what} is not drawn`];
}

/** Types into a React-controlled field the way a person does: the native setter, then an input event. */
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const button = (from: ParentNode, text: string) => [...from.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);

/** A control whose right edge passes the window: cut off on a phone. */
function cutOff(scope: ParentNode): string[] {
  return all("input, textarea, button, [role=combobox]", scope)
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.right > windowWidth() + 1;
    })
    .slice(0, 3)
    .map((el) => `a control ends at ${Math.round(el.getBoundingClientRect().right)} px in ${windowWidth()}: "${(el.getAttribute("aria-label") ?? el.textContent ?? el.tagName).trim().slice(0, 40)}"`);
}

async function revision(dark: boolean): Promise<string[]> {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  show("revision");
  const wrong = await until(() => q("[data-testid=revision-new]") !== null, "the New revision act");
  (q<HTMLButtonElement>("[data-testid=revision-new]") as HTMLButtonElement | null)?.click();
  wrong.push(...(await until(() => q("[data-testid=revision-form]") !== null, "the revision form")));
  const form = q("[data-testid=revision-form]") as HTMLElement;
  const reason = form?.querySelector("textarea");
  if (reason) type(reason, "Clinics asked for a weekly export of their bookings");
  const second = all("[data-testid=criterion-draft]", form)[1];
  if (second) {
    button(second, "Scenario")?.click();
    await settle(100);
    const when = q<HTMLTextAreaElement>("[data-testid=criterion-when]", second);
    const then = q<HTMLTextAreaElement>("[data-testid=criterion-then]", second);
    if (when) type(when, "the week ends\nthe clinic is open");
    if (then) type(then, "a sheet of the week's bookings is sent");
  } else wrong.push("no second criterion is drawn");
  await settle(200);
  if (!q("[data-testid=facts-contracts]")) wrong.push("the rail draws no Contracts group");
  if (!q("[data-testid=requirement-progress]")) wrong.push("the strip that says where it stands is not drawn");
  window.scrollTo(0, 0);
  return [...wrong, ...sideways(), ...cutOff(document)];
}

async function designEdit(dark: boolean): Promise<string[]> {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  show("design");
  const wrong = await until(() => q("[data-testid=design-editor]") !== null, "the design editor");
  const step = all("[data-testid=step-draft]")[1];
  (step?.querySelector("button") as HTMLButtonElement | null)?.click();
  await settle(200);
  const standing = q("[data-testid=design-edit-standing]")?.textContent ?? "";
  if (!standing.includes("A save keeps it a draft")) wrong.push(`the standing line reads "${standing}"`);
  if (!q("[data-testid=design-banner]")) wrong.push("the banner that says whom it waits on is not drawn");
  if (!q("[data-testid=design-propose]")) wrong.push("the Propose act is not drawn");
  window.scrollTo(0, 0);
  return [...wrong, ...sideways(), ...cutOff(document)];
}

async function newDesign(dark: boolean): Promise<string[]> {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  show("new");
  const wrong = await until(() => q("[data-testid=new-design]") !== null, "the New design act");
  (q<HTMLButtonElement>("[data-testid=new-design]") as HTMLButtonElement | null)?.click();
  wrong.push(...(await until(() => q("[data-testid=new-design-form]") !== null, "the New design form")));
  const form = q("[data-testid=new-design-form]") as HTMLElement;
  const [title] = all("input", form) as HTMLInputElement[];
  const summary = q<HTMLTextAreaElement>("textarea", form);
  if (title) type(title, "Đặt lịch khám");
  if (summary) type(summary, "A patient books a visit.");
  wrong.push(...(await until(() => q("[data-testid=new-design-from-example]") !== null, "the line naming the example it starts from")));
  return [...wrong, ...sideways(), ...cutOff(form ?? document)];
}

window.__witness = {
  cases: [
    { name: "desktop", width: 1440 },
    { name: "phone", width: 390 },
  ],
  ready: () => q("#root") !== null,
  stages: [
    { name: "1-revision-light", run: () => revision(false) },
    { name: "2-design-edit-light", run: () => designEdit(false) },
    { name: "3-new-design-light", run: () => newDesign(false) },
    { name: "4-revision-dark", run: () => revision(true) },
    { name: "5-design-edit-dark", run: () => designEdit(true) },
    { name: "6-new-design-dark", run: () => newDesign(true) },
  ],
};
