// A refused save witnessed as drawn (REQ-34 BC-18; ISS-457): on the New requirement form and the
// feedback form, each of core's refusals is drawn inside the field its path names, between that
// field's label and the next field, and the line under the form keeps only what no field owns. jsdom
// lays nothing out, so "on its field" goes red here.
//
//   pnpm --filter web-v2 witness witness/field-refusals.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { createRoot } from "react-dom/client";
import { FeedbackForm } from "@/features/feedback/components/feedback-form";
import { CreateRequirementForm } from "@/features/requirements/components/requirements-screen";
import "./entry";

// a requirement is created from its title alone (ISS-456), so its one field is the title
const REQUIREMENT_REFUSALS = [
  { code: "BAD_REQUEST", path: "/title", detail: "The requirement title is too long." },
  { code: "REQUIREMENT_HELD", path: "", detail: "The project is read-only." },
];
const FEEDBACK_REFUSALS = [
  { code: "BAD_REQUEST", path: "/title", detail: "The title is too long." },
  { code: "FEEDBACK_TARGET_NOT_IN_PROJECT", path: "/requirement", detail: "REQ-3 is not in this project." },
];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refused = (refusals: unknown[]) => json({ error: { code: "REFUSED", message: "refused", refusals } }, 422);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input), "http://forge.test").pathname;
  if (init?.method === "POST" && path.endsWith("/requirements")) return refused(REQUIREMENT_REFUSALS);
  if (init?.method === "POST" && path.endsWith("/feedback")) return refused(FEEDBACK_REFUSALS);
  if (path.endsWith("/projects")) return json([{ id: "p1", role: "member" }]);
  if (path.endsWith("/projects/p1/requirements")) return json({ requirements: [{ key: "REQ-3", title: "The board keeps its cards" }], returned: 1 });
  return new Promise<Response>(() => {});
};

const noop = () => {};
const router = { push: noop, replace: noop, prefetch: noop, back: noop, forward: noop, refresh: noop, hmrRefresh: noop };
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root") as HTMLElement).render(
  <QueryClientProvider client={client}>
    <AppRouterContext.Provider value={router as never}>
      <div className="grid gap-6 p-4 lg:grid-cols-2">
        <section data-witness="requirement">
          <CreateRequirementForm projectId="p1" onDone={noop} />
        </section>
        <section data-witness="feedback">
          <FeedbackForm projectId="p1" onDone={noop} />
        </section>
      </div>
    </AppRouterContext.Provider>
  </QueryClientProvider>,
);

const q = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Types into a React-controlled field the way a person does: the native setter, then an input event. */
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The field wrapper whose label reads `label`, inside `form`. */
function field(form: HTMLElement, label: string): HTMLElement | null {
  const l = [...form.querySelectorAll("label")].find((x) => (x.textContent ?? "").replace("*", "").trim() === label);
  return (l?.parentElement as HTMLElement | null) ?? null;
}

/** What is wrong with where `detail` is drawn: inside `label`'s field box, below its label, and nowhere else. */
function onField(form: HTMLElement, label: string, detail: string): string[] {
  const box = field(form, label);
  if (!box) return [`no ${label} field is drawn`];
  const shown = [...form.querySelectorAll("[role=alert]")].filter((a) => a.textContent?.includes(detail));
  if (shown.length === 0) return [`"${detail}" is drawn nowhere`];
  const wrong: string[] = [];
  if (!shown.some((a) => box.contains(a))) wrong.push(`"${detail}" is drawn outside the ${label} field`);
  const b = box.getBoundingClientRect();
  const inside = shown.find((a) => box.contains(a));
  if (inside) {
    const r = inside.getBoundingClientRect();
    if (r.top < (box.querySelector("label")?.getBoundingClientRect().bottom ?? b.top) || r.bottom > b.bottom + 1) wrong.push(`"${detail}" is drawn outside the ${label} field's box`);
    if (r.width === 0 || r.right > window.innerWidth) wrong.push(`"${detail}" is cut off at ${Math.round(r.right)} px in ${window.innerWidth}`);
  }
  if (shown.length > 1) wrong.push(`"${detail}" is drawn ${shown.length} times`);
  return wrong;
}

async function send(): Promise<string[]> {
  const req = q("[data-witness=requirement] form") as HTMLElement;
  const fb = q("[data-witness=feedback] form") as HTMLElement;
  type(q<HTMLInputElement>("input", field(req, "Title") ?? req) as HTMLInputElement, "Staff open the root page");
  type(q<HTMLInputElement>("input", field(fb, "Title") ?? fb) as HTMLInputElement, "Cards vanish");
  type(q<HTMLInputElement>("input[aria-label=Target]", fb) as HTMLInputElement, "The board keeps its cards");
  await pause(200);
  for (const form of [req, fb]) (q<HTMLButtonElement>("button[type=submit]", form) as HTMLButtonElement).click();
  for (let i = 0; i < 40 && document.querySelectorAll("[role=alert]").length < 3; i += 1) await pause(50);
  const wrong = [
    ...onField(req, "Title", "The requirement title is too long."),
    ...onField(fb, "Title", "The title is too long."),
    ...onField(fb, "About", "REQ-3 is not in this project."),
  ];
  const line = q("[data-testid=refusal]", req);
  if (!line?.textContent?.includes("The project is read-only.")) wrong.push("the line under the requirement form does not name the refusal no field owns");
  if (line && /too long/.test(line.textContent ?? "")) wrong.push("the line under the requirement form repeats a refusal drawn on its field");
  if (q("[data-testid=refusal]", fb)) wrong.push("the feedback form draws a line under it though every refusal is on a field");
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
  return wrong;
}

window.__witness = {
  cases: [
    { name: "phone", width: 390 },
    { name: "desktop", width: 1440 },
  ],
  ready: () => document.querySelectorAll("form").length === 2 && document.querySelector("[data-testid=feedback-choices]") !== null,
  stages: [{ name: "refused", run: send }],
};
