// A proposed system-context design on its canvas, witnessed at phone and desktop width (REQ-35 BC-7,
// the decision on question 20c74d56): with Changes on, the Boundaries view's folded box for the
// payment providers wears the changed border and says "2 changed" on a chip at its foot, the chip
// covering neither the box's title nor its member count, nor any other box; with Changes off, no box
// carries either, and the reader's view survives the switch: the detail they picked, the boundary they
// opened and where they dragged the canvas. jsdom lays nothing out, so all of it is read here.
//
//   pnpm --filter web-v2 witness witness/c4-changes.witness.tsx --out <dir>

import { systemContext } from "@forge/contracts/workflow-template-systems";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkflowCanvas } from "@/features/workflows/canvas/workflow-canvas";
import { clinicGraph, graphDiff, MESSAGING, PAYMENTS } from "@/test/system-graph";
import "./entry";
import { InRouter } from "./router";

const P = "p-1";
const CHANGES = "Changes since approved rev 1";
const diff = graphDiff({ card: "changed", bank: "removed" });
const doc = {
  title: "Clinic system",
  summary: "",
  kind: "flow" as const,
  steps: clinicGraph.nodes.map((n) => ({ id: n.id, does: n.name, after: [] })),
  edges: [],
};

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
/** How long core takes to answer a graph read after the first: long enough to look at the canvas while it waits. */
const REREAD_MS = 1500;
let reads = 0;
let answered = 0;
window.fetch = async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://forge.test").pathname;
  if (path.endsWith(`/projects/${P}/workflows/w-1/system-graph`)) {
    reads += 1;
    if (reads > 1) await pause(REREAD_MS);
    answered += 1;
    return json(clinicGraph);
  }
  return new Promise<Response>(() => {});
};

function Canvas() {
  const [on, setOn] = useState(true);
  return (
    <div style={{ height: "100vh" }} className="flex flex-col">
      <WorkflowCanvas
        doc={doc as never}
        template={systemContext}
        diff={on ? diff : null}
        graph={{ projectId: P, workflowId: "w-1", revision: 2, against: on ? 1 : null }}
        changes={{ on, onToggle: setOn, label: "Changes", title: CHANGES }}
      />
    </div>
  );
}

const q = <T extends Element = HTMLElement>(sel: string, from: ParentNode = document) => from.querySelector<T>(sel);
const payments = () => q(`[data-testid=c4-box][data-id="${PAYMENTS}"]`);

async function until(what: () => boolean, ms = 5000): Promise<boolean> {
  for (let t = 0; t < ms; t += 50) {
    if (what()) return true;
    await pause(50);
  }
  return what();
}

/** The colour a token resolves to on the page, read off a probe element painted with it. */
function tokenColour(token: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${token})`;
  document.body.appendChild(probe);
  const colour = getComputedStyle(probe).color;
  probe.remove();
  return colour;
}

const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
const px = (r: DOMRect) => `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}`;

function sideways(): string[] {
  // a phone's layout viewport widens to whatever overflows it, so the window is the visual viewport
  const width = window.visualViewport?.width ?? window.innerWidth;
  return document.documentElement.scrollWidth > width ? [`the page scrolls sideways: ${document.documentElement.scrollWidth} px in a ${width} px window`] : [];
}

const button = (named: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === named || b.getAttribute("aria-label") === named);
const changesSwitch = () => q<HTMLButtonElement>(`[role=switch][aria-label="${CHANGES}"]`);

/** The Boundaries view, fitted to the window, with the payment providers in it. */
async function onBoundaries(): Promise<boolean> {
  // the view measures which detail fits once it has first drawn; a choice made before that is overwritten
  for (let i = 0; i < 20 && !payments(); i++) {
    await until(() => document.querySelectorAll("[data-testid=c4-box]").length > 0);
    button("Boundaries")?.click();
    await until(() => Boolean(payments()), 500);
  }
  if (!payments()) return false;
  await pause(300);
  button("Fit")?.click();
  await pause(600);
  await bringIntoView();
  return true;
}

/** Drags the canvas by (dx, dy), as a reader's mouse does. */
async function drag(dx: number, dy: number): Promise<void> {
  const pane = q(".react-flow__pane");
  if (!pane) return;
  const view = pane.getBoundingClientRect();
  const at = { x: view.left + view.width / 2, y: view.top + view.height / 2 };
  const mouse = (type: string, x: number, y: number) => new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: type === "mouseup" ? 0 : 1 });
  pane.dispatchEvent(mouse("mousedown", at.x, at.y));
  for (let i = 1; i <= 10; i++) window.dispatchEvent(mouse("mousemove", at.x + (dx * i) / 10, at.y + (dy * i) / 10));
  window.dispatchEvent(mouse("mouseup", at.x + dx, at.y + dy));
  await pause(400);
}

/**
 * The canvas never shrinks below a readable zoom, so at phone width the payment providers sit past the
 * window's edge until the reader drags the canvas: dragged here, as a reader would, until the box is mid-window.
 */
async function bringIntoView(): Promise<void> {
  const pane = q(".react-flow__pane");
  const box = payments();
  if (!pane || !box) return;
  const r = box.getBoundingClientRect();
  const view = pane.getBoundingClientRect();
  // the chip hangs below the box's foot; a box drawn whole with room for it is left where the fit put it
  if (r.left >= view.left && r.right <= view.right && r.top >= view.top && r.bottom + 16 <= view.bottom) return;
  await drag(view.left + view.width / 2 - (r.left + r.width / 2), view.top + view.height / 2 - (r.top + r.height / 2));
}

/** Where the reader is looking: the canvas's pan and zoom. */
const viewport = () => q(".react-flow__viewport")?.style.transform ?? "missing";
const pressed = (named: string) => {
  const b = button(named);
  return b?.getAttribute("aria-pressed") === "true" || b?.hasAttribute("data-pressed") === true;
};
const messagingOpen = () => [...document.querySelectorAll("[data-testid=c4-frame]")].some((f) => f.textContent?.includes("Messaging"));

/** An unmarked box's border width, which a marked one has to exceed. */
const plainBorder = () => {
  const plain = [...document.querySelectorAll("[data-testid=c4-box]")].find((b) => !b.hasAttribute("data-mark") && b.getAttribute("data-kind") !== "focal");
  return plain ? Number.parseFloat(getComputedStyle(plain).borderTopWidth) : 0;
};

async function changesOn(): Promise<string[]> {
  if (!(await onBoundaries())) return ["the Boundaries view draws no folded box for the payment providers"];
  const wrong: string[] = [];
  const box = payments() as HTMLElement;
  if (box.getAttribute("data-kind") !== "group") wrong.push(`the payment providers' box is a ${box.getAttribute("data-kind")}, not a folded boundary`);
  if (box.getAttribute("data-mark") !== "changed") wrong.push(`the folded box holding two changes is marked "${box.getAttribute("data-mark")}", not changed`);
  const border = getComputedStyle(box);
  const amber = tokenColour("--amber-500");
  if (border.borderTopColor !== amber) wrong.push(`the folded box's border is ${border.borderTopColor}, not the changed colour ${amber}`);
  if (Number.parseFloat(border.borderTopWidth) <= plainBorder()) wrong.push(`the folded box's border is ${border.borderTopWidth} wide, no wider than an unmarked box's ${plainBorder()}px`);
  const chip = q("[data-testid=c4-changed]", box);
  if (!chip) return [...wrong, "the folded box holding two changes carries no changed chip"];
  if (chip.textContent?.trim() !== "2 changed") wrong.push(`the chip reads "${chip.textContent}", not "2 changed"`);
  const c = chip.getBoundingClientRect();
  if (chip.scrollWidth > chip.clientWidth + 1) wrong.push(`the chip's words are cut: ${chip.clientWidth} of ${chip.scrollWidth} px shown`);
  for (const title of box.querySelectorAll(".wfc-c4-title")) {
    const r = title.getBoundingClientRect();
    if (overlaps(c, r)) wrong.push(`the chip (${px(c)}) covers the title line "${title.textContent}" (${px(r)})`);
  }
  const count = q(".wfc-c4-chip", box);
  if (!count) wrong.push("the folded box shows no member count");
  else if (overlaps(c, count.getBoundingClientRect())) wrong.push(`the chip (${px(c)}) covers the member count (${px(count.getBoundingClientRect())})`);
  for (const other of document.querySelectorAll("[data-testid=c4-box]")) {
    if (other === box) continue;
    const r = other.getBoundingClientRect();
    if (overlaps(c, r)) wrong.push(`the chip (${px(c)}) covers the box "${other.textContent}" (${px(r)})`);
  }
  const pane = q(".react-flow")?.getBoundingClientRect();
  if (pane && (c.left < pane.left || c.right > pane.right || c.top < pane.top || c.bottom > pane.bottom)) wrong.push(`the chip (${px(c)}) is drawn outside the canvas (${px(pane)})`);
  return [...wrong, ...sideways()];
}

async function changesOff(): Promise<string[]> {
  // the reader's view before the switch: Boundaries picked, the messaging boundary opened, the canvas dragged
  const messaging = q(`[data-testid=c4-box][data-id="${MESSAGING}"]`);
  if (!messaging) return ["the Boundaries view draws no folded box for the messaging services"];
  messaging.click();
  if (!(await until(messagingOpen))) return ["opening the messaging boundary drew no frame for it"];
  await pause(600);
  await bringIntoView();
  await drag(-36, 28);
  const looking = viewport();

  const toggle = changesSwitch();
  if (!toggle) return ["the canvas has no Changes switch"];
  toggle.click();
  await until(() => changesSwitch()?.getAttribute("aria-checked") === "false");
  // while core answers the new comparison, the canvas still shows the reader what they were reading
  await pause(REREAD_MS / 3);
  const wrong: string[] = [];
  if (!pressed("Boundaries")) wrong.push("while the comparison reloads, the toolbar picks no detail");
  if (!payments() || !messagingOpen()) wrong.push("while the comparison reloads, the canvas drops the boundaries the reader was reading");
  if (!(await until(() => reads > 1 && answered === reads, REREAD_MS * 3))) wrong.push("turning Changes off read no new comparison from core");
  await pause(800);

  if (changesSwitch()?.getAttribute("aria-checked") !== "false") wrong.push("the Changes switch did not turn off");
  if (!pressed("Boundaries")) wrong.push(`turning Changes off lost the reader's detail: ${pressed("Every system") ? "Every system" : "nothing"} is picked, not Boundaries`);
  if (!messagingOpen()) wrong.push("turning Changes off folded the messaging boundary the reader had opened");
  if (viewport() !== looking) wrong.push(`turning Changes off moved the canvas from "${looking}" to "${viewport()}": the reader's pan and zoom were lost`);
  const box = payments();
  if (!box) return [...wrong, "the folded box for the payment providers is gone with Changes off"];
  if (box.hasAttribute("data-mark")) wrong.push(`with Changes off the folded box is still marked "${box.getAttribute("data-mark")}"`);
  const chips = document.querySelectorAll("[data-testid=c4-changed]").length;
  if (chips > 0) wrong.push(`with Changes off ${chips} box(es) still carry a changed chip`);
  return [...wrong, ...sideways()];
}

window.__witness = {
  cases: [
    { name: "c4-390", width: 390 },
    { name: "c4-1440", width: 1440 },
  ],
  ready: () => document.querySelectorAll("[data-testid=c4-box]").length > 0,
  stages: [
    { name: "changes-on", run: changesOn },
    { name: "changes-off", run: changesOff },
  ],
};

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(root).render(
  <InRouter at={`/projects/clinic/workflows/clinic-system`} pattern="/projects/$slug/workflows/$flow">
    <QueryClientProvider client={client}>
      <Canvas />
    </QueryClientProvider>
  </InRouter>,
);
