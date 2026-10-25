// The chat acting on a requirement and on feedback (REQ-69 BC-3, BC-5; ISS-692), witnessed at desktop
// and phone width, light and dark, over a stubbed core. The assistant's reply offers three cards:
// agree REQ-3, decline FB-12, defer REQ-4. Pressing the first shows REQ-3 agreed; pressing the second
// shows FB-12 declined; the third is refused by core, and its card says why, what to do next and
// links the requirement's page. Nothing may scroll sideways and no card text may be cut.
//
//   pnpm --filter web-v2 witness witness/item-acts.witness.tsx --out <dir> [--clip]

import type { ItemActOffer } from "@forge/contracts/item-acts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { useActOffers } from "@/features/conversations/act-offers";
import type { ConversationMessage } from "@/features/conversations/types";
import "./entry";
import { InRouter } from "./router";

const P = "6f0ee160-8432-4b84-98cf-956b6cd65a29";
const status: Record<string, string> = { "REQ-3": "draft", "REQ-4": "agreed", "FB-12": "new" };
const sent: { path: string; body: unknown }[] = [];
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
const requirement = (key: string) => ({ key, title: key, status: status[key], revisions: [{ revision: 2, state: "current" }] });

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://forge.test");
  const path = url.pathname.replace(/^\/api/, "");
  const method = init?.method ?? "GET";
  const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
  const req = /^\/projects\/[^/]+\/requirements\/(REQ-\d+)(?:\/(\w+))?$/.exec(path);
  if (req && method === "GET") return json(requirement(req[1] ?? ""));
  if (req && method === "POST") {
    sent.push({ path, body });
    if (req[2] === "defer") {
      const detail = "deferring REQ-4 needs requirements.approve on this project, which you do not hold";
      return json({ code: "PERMISSION_FORBIDDEN", message: detail, detail, error: { code: "PERMISSION_FORBIDDEN", message: detail } }, 403);
    }
    status[req[1] ?? ""] = "agreed";
    return json(requirement(req[1] ?? ""));
  }
  const fb = /^\/projects\/[^/]+\/feedback\/(FB-\d+)(\/triage)?$/.exec(path);
  if (fb && method === "GET") return json({ feedback: { key: fb[1], phase: status[fb[1] ?? ""] } });
  if (fb && method === "POST") {
    sent.push({ path, body });
    status[fb[1] ?? ""] = "declined";
    return json({ feedback: { key: fb[1], phase: "declined" } });
  }
  return new Promise<Response>(() => {});
};

const offers: ItemActOffer[] = [
  { v: 1, act: "requirement.agree", projectId: P, key: "REQ-3", ref: "REQ-3", title: "Export orders as a spreadsheet", from: "draft", revision: 2, reason: "Sales confirmed the columns they file" },
  { v: 1, act: "feedback.triage", projectId: P, key: "FB-12", ref: "FB-12", title: "Export button stays grey", from: "new", triage: { route: "decline", note: "Works as designed: export needs a filter first" } },
  { v: 1, act: "requirement.defer", projectId: P, key: "REQ-4", ref: "REQ-4", title: "Reminders keep their time zone", from: "agreed", reason: "Waits for the clinic calendar work" },
];
const MESSAGE = {
  id: "m1",
  blocks: offers.map((offer, i) => ({
    type: "tool",
    toolCall: { id: `call-${i}`, name: "offer_item_act", output: JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ offer }) }] }) },
  })),
} as unknown as ConversationMessage;

function Reply() {
  const { offersFor } = useActOffers({ messages: [MESSAGE], progress: null, slug: "hop" });
  return (
    <div data-witness="chat" className="flex flex-col gap-2">
      <p className="fg-body-sm text-fg">
        I understood three acts. Agreeing REQ-3 records your reason on its history, declining FB-12 tells the reporter why, and deferring REQ-4 records why it waits. Press each card to do it.
      </p>
      {offersFor("m1")}
    </div>
  );
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at="/projects/hop/requirements/REQ-3" pattern="/projects/$slug/requirements/$requirement">
    <QueryClientProvider client={client}>
      <div className="min-h-screen bg-canvas">
        <div className="mx-auto max-w-xl p-4">
          <Reply />
        </div>
      </div>
    </QueryClientProvider>
  </InRouter>,
);

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cards = () => [...document.querySelectorAll<HTMLElement>("[data-testid=item-act-offer]")];
const cardOf = (act: string) => cards().find((c) => c.dataset.act === act) ?? null;
const until = async (ok: () => boolean, ms = 3000) => {
  for (let i = 0; i < ms / 50 && !ok(); i += 1) await pause(50);
  return ok();
};
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const confirmIn = (card: HTMLElement | null) => [...(card?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.trim() === "Confirm") ?? null;

/** What every stage owes: no sideways scroll, no card line cut. */
function always(): string[] {
  const wrong: string[] = [];
  const width = window.innerWidth;
  if (document.documentElement.scrollWidth > width) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${width}`);
  for (const p of document.querySelectorAll<HTMLElement>("[data-testid=item-act-offer] p")) {
    if (p.scrollWidth > p.clientWidth + 1) wrong.push(`"${p.textContent?.slice(0, 40)}" is cut at ${width} px`);
  }
  return wrong;
}

async function press(act: string, done: (card: HTMLElement) => boolean): Promise<string[]> {
  const card = cardOf(act);
  const button = confirmIn(card);
  if (!button) return [`the ${act} card offers no Confirm`];
  await until(() => !button.disabled);
  button.click();
  const ok = await until(() => (card ? done(card) : false));
  return ok ? [] : [`the ${act} card did not settle: ${card?.textContent?.slice(0, 160)}`];
}

window.__witness = {
  cases: [
    { name: "desktop", width: 1440 },
    { name: "phone", width: 390 },
  ],
  ready: () => cards().length === 3 && cards().every((c) => confirmIn(c) !== null),
  stages: [
    {
      name: "1-offered-light",
      run: () => {
        theme("light");
        const wrong = always();
        if (!(cardOf("requirement.agree")?.textContent ?? "").includes("Agrees revision 2 of REQ-3")) wrong.push("the agree card does not say what it records");
        if (!(cardOf("feedback.triage")?.textContent ?? "").includes("Declines FB-12 and tells the reporter why")) wrong.push("the decline card does not say the reporter is told why");
        return wrong;
      },
    },
    {
      name: "2-requirement-agreed-light",
      run: async () => {
        const wrong = await press("requirement.agree", (c) => (c.textContent ?? "").includes("REQ-3 is now Agreed"));
        const agree = sent.find((s) => s.path.endsWith("/requirements/REQ-3/agree"));
        if (JSON.stringify(agree?.body) !== JSON.stringify({ revision: 2, reason: "Sales confirmed the columns they file" })) wrong.push(`the agree sent ${JSON.stringify(agree?.body)}`);
        return [...wrong, ...always()];
      },
    },
    {
      name: "3-feedback-declined-dark",
      run: async () => {
        theme("dark");
        const wrong = await press("feedback.triage", (c) => (c.textContent ?? "").includes("FB-12 is now"));
        if (!sent.some((s) => s.path.endsWith("/feedback/FB-12/triage"))) wrong.push("the decline did not go to the triage route");
        return [...wrong, ...always()];
      },
    },
    {
      name: "4-refused-says-next-dark",
      run: async () => {
        const wrong = await press("requirement.defer", (c) => c.querySelector("[data-testid=item-act-failed]") !== null);
        const failed = cardOf("requirement.defer")?.querySelector("[data-testid=item-act-failed]")?.textContent ?? "";
        if (!failed.includes("requirements.approve")) wrong.push("the refused card does not say why");
        if (!failed.includes("such as a project admin, can do it")) wrong.push("the refused card does not say what to do next");
        if (!failed.includes("Open REQ-4")) wrong.push("the refused card does not link REQ-4's page");
        return [...wrong, ...always()];
      },
    },
    {
      name: "5-settled-light",
      run: () => {
        theme("light");
        return always();
      },
    },
  ],
};
