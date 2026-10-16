// The approval inbox witnessed as drawn (REQ-8, REQ-11): one row per record waiting on the viewer's
// approve-type decision, each with its key, who asked, how long it waited and its acts, beside the
// project menu whose Approvals row carries the same count. At 390 px the acts wrap under the title and
// nothing scrolls sideways. Each case is shot light, dark, with an approve's confirm step open, and
// with a decline's reason step open.
//
//   pnpm --filter web-v2 witness witness/approval-inbox.witness.tsx --out <dir>

import { type ApprovalInbox as Inbox, approvalInboxSchema } from "@forge/contracts/approvals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { NavRail } from "@/design";
import { ApprovalInbox } from "@/features/approvals";
import { projectMenu, workspaceNavItems } from "@/features/shell/nav-model";
import "./entry";
import { InRouter } from "./router";

const P = "6f0ee160-8432-4b84-98cf-956b6cd65a29";
const PHONE = 600;
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const act = (a: string, path: string, reason: "required" | "optional" | "none") => ({ act: a, path, body: {}, reason });
const base = { suggestionKind: null, mockupKind: null, revision: null } as const;

const READ: Inbox = approvalInboxSchema.parse({
  generatedAt: new Date().toISOString(),
  total: 7,
  items: [
    {
      ...base,
      kind: "suggestion",
      suggestionKind: "revision_diff",
      id: "suggestion:s1",
      key: "REQ-12",
      title: "Patients see their discharge letter in the portal within a day",
      askedBy: { kind: "assistant", name: "Lan Nguyen" },
      since: ago(6),
      opens: { kind: "requirement", key: "REQ-12" },
      approve: act("suggestion.accept", `/api/projects/${P}/suggestions/s1/accept`, "optional"),
      decline: act("suggestion.reject", `/api/projects/${P}/suggestions/s1/reject`, "required"),
    },
    {
      ...base,
      kind: "revision",
      revision: 3,
      id: "revision:r1:3",
      key: "REQ-7",
      title: "A nurse hands a case over at shift change",
      askedBy: { kind: "person", name: "Minh Tran" },
      since: ago(4),
      opens: { kind: "requirement", key: "REQ-7" },
      approve: act("revision.accept", `/api/projects/${P}/requirements/REQ-7/revisions/3/accept`, "optional"),
      decline: act("revision.return", `/api/projects/${P}/requirements/REQ-7/revisions/3/return`, "required"),
    },
    {
      ...base,
      kind: "design",
      revision: 2,
      id: "design:w1",
      key: "post-discharge",
      title: "Post-discharge follow-up",
      askedBy: { kind: "agent", name: "forge-master" },
      since: ago(3),
      opens: { kind: "workflow", key: "post-discharge" },
      approve: { act: "design.decide", path: `/api/projects/${P}/workflows/w1/design/decision`, body: { revision: 2, decision: "approve" }, reason: "optional" },
      decline: { act: "design.decide", path: `/api/projects/${P}/workflows/w1/design/decision`, body: { revision: 2, decision: "return" }, reason: "required" },
    },
    {
      ...base,
      kind: "mockup",
      mockupKind: "html",
      id: "mockup:m1",
      key: "MK-4",
      title: "The checkout as it should look",
      askedBy: { kind: "person", name: "Ana" },
      since: ago(2),
      opens: { kind: "issue", key: "ISS-41" },
      approve: act("mockup.accept", `/api/projects/${P}/mockups/MK-4/accept`, "optional"),
      decline: act("mockup.return", `/api/projects/${P}/mockups/MK-4/return`, "required"),
    },
    {
      ...base,
      kind: "preview",
      id: "preview:p1",
      key: "ISS-52",
      title: "Pay by card on the portal",
      askedBy: { kind: "person", name: "Minh Tran" },
      since: ago(1),
      opens: { kind: "issue", key: "ISS-52" },
      approve: act("preview.approve", "/api/previews/p1/approve", "none"),
      decline: null,
    },
    {
      ...base,
      kind: "release",
      id: "release:2.4.0",
      key: "2.4.0",
      title: "",
      askedBy: { kind: "person", name: "Lan Nguyen" },
      since: ago(0.2),
      opens: { kind: "release", key: "2.4.0" },
      approve: act("release.decide", `/api/projects/${P}/release-batches/run1/approvals/a1/decision`, "required"),
      decline: act("release.decide", `/api/projects/${P}/release-batches/run1/approvals/a1/decision`, "required"),
    },
    {
      ...base,
      kind: "repin",
      id: "repin:intake",
      key: "intake",
      title: "",
      askedBy: null,
      since: null,
      opens: { kind: "workflow", key: "intake" },
      approve: null,
      decline: null,
    },
  ],
});

window.localStorage.clear();
window.fetch = async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes(`/projects/${P}/approvals`)) return new Response(JSON.stringify(READ), { headers: { "content-type": "application/json" } });
  return new Promise<Response>(() => {});
};

const noop = () => {};
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const phone = window.innerWidth < PHONE;

createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at="/projects/hop/approvals" pattern="/projects/$slug/approvals">
    <QueryClientProvider client={client}>
      <div style={{ display: "flex", minHeight: "100vh" }} className="bg-app">
        {phone ? null : (
          <div style={{ height: "100vh", flex: "none" }} data-testid="witness-rail">
            <NavRail
              compact={false}
              workspaceItems={workspaceNavItems(0, undefined)}
              projectItems={projectMenu({ approvals: READ })}
              activeKey="proj-approvals"
              onNavigate={noop}
              groupOpen={{}}
              onToggleGroup={noop}
            />
          </div>
        )}
        <main style={{ flex: 1, minWidth: 0 }}>
          <ApprovalInbox projectId={P} slug="hop" />
        </main>
      </div>
    </QueryClientProvider>
  </InRouter>,
);

const rows = () => [...document.querySelectorAll("[data-testid=approval-entry]")];

function drawn(): string[] {
  const wrong: string[] = [];
  const all = rows();
  if (all.length !== READ.items.length) wrong.push(`${all.length} rows are drawn, not ${READ.items.length}`);
  for (const [i, item] of READ.items.entries()) {
    const row = all[i];
    if (!row) continue;
    const text = row.textContent ?? "";
    if (!text.includes(item.key)) wrong.push(`row ${i + 1} does not read its key ${item.key}`);
    const approve = row.querySelector("[data-testid=approval-approve]");
    if (Boolean(approve) !== Boolean(item.approve)) wrong.push(`row ${item.key} ${approve ? "offers" : "lacks"} Approve`);
    const open = row.querySelector("[data-testid=approval-open]");
    if (!open || open.getBoundingClientRect().width === 0) wrong.push(`row ${item.key} draws no Open link`);
    for (const b of row.querySelectorAll("button, a")) {
      const r = b.getBoundingClientRect();
      if (r.right > window.innerWidth + 0.5) wrong.push(`row ${item.key}: "${b.textContent?.trim()}" runs past the window's right edge`);
    }
  }
  if (!phone) {
    const rail = document.querySelector("[data-testid=witness-rail]")?.textContent ?? "";
    if (!rail.includes("Approvals")) wrong.push("the menu draws no Approvals row");
    if (!rail.includes(String(READ.total))) wrong.push(`the menu's Approvals row does not read its count ${READ.total}`);
  }
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
  return wrong;
}

const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const settle = () => new Promise((r) => setTimeout(r, 150));

function press(testId: string, key: string): string[] {
  const row = rows().find((r) => r.textContent?.includes(key));
  const button = row?.querySelector<HTMLElement>(`[data-testid=${testId}]`);
  if (!button) return [`row ${key} has no ${testId}`];
  button.click();
  return [];
}

window.__witness = {
  cases: [
    { name: "phone", width: 390 },
    { name: "desktop", width: 1440 },
  ],
  ready: () => rows().length === READ.items.length,
  stages: [
    {
      name: "light",
      run: async () => {
        theme("light");
        await settle();
        return drawn();
      },
    },
    {
      name: "dark",
      run: async () => {
        theme("dark");
        await settle();
        return drawn();
      },
    },
    {
      name: "approve-step-light",
      run: async () => {
        theme("light");
        const wrong = press("approval-approve", "MK-4");
        await settle();
        if (!document.querySelector("[data-testid=accept-step]")) wrong.push("Approve opened no confirm step");
        else if (!document.body.textContent?.includes("Accepts mockup MK-4.")) wrong.push("the confirm step does not say what it does");
        return wrong;
      },
    },
    {
      name: "decline-step-dark",
      run: async () => {
        theme("dark");
        const cancel = [...document.querySelectorAll<HTMLElement>("[data-testid=accept-step] button")].find((b) => b.textContent?.trim() === "Cancel");
        cancel?.click();
        await settle();
        const wrong = press("approval-decline", "REQ-12");
        await settle();
        const step = document.querySelector("[data-testid=reject-step]");
        if (!step) wrong.push("Decline opened no reason step");
        else if (!(step.querySelector("button[type=submit]") as HTMLButtonElement | null)?.disabled) wrong.push("Decline can be sent with no reason");
        return wrong;
      },
    },
  ],
};
