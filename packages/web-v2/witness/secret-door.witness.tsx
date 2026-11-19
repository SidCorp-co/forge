// The Secrets section a room agent's link opens (ISS-1348), used at desktop and phone width, light and
// dark: a link to an unfilled request lands on it (in view, focused, highlighted); a person fills a
// mailbox in labelled boxes and saves; the request then reads that it has a value; and a link to a
// slot already filled opens on that state with nothing to do.
//
//   pnpm --filter web-v2 witness witness/secret-door.witness.tsx --out <dir>

import type { SecretRequestView, SecretSlotView, SecretSlotsRead } from "@forge/contracts/secret-slots";
import { MAILBOX_FIELDS } from "@forge/contracts/secret-slots";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { SecretsSettings } from "@/features/project-settings/components/secrets/secrets-page";
import "./entry";
import { InRouter } from "./router";

const P = "11111111-1111-4111-8111-111111111111";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();

const slot = (over: Partial<SecretSlotView>): SecretSlotView => ({
  anchor: "slot-g",
  ref: { kind: "variable", environment: "production", key: "GOOGLE_CLIENT_SECRET" },
  label: "Google client secret",
  detail: "GOOGLE_CLIENT_SECRET",
  environment: "production",
  tier: "production",
  door: { kind: "variable", key: "GOOGLE_CLIENT_SECRET", environment: "production", variable: null },
  form: { kind: "value" },
  held: null,
  ...over,
});
const testing = (anchor: string, name: string, held: SecretSlotView["held"]) =>
  slot({
    anchor,
    ref: { kind: "testing", profile: "stg", service: name },
    label: name === "mail-support" ? "Mail support" : "Mail customer",
    detail: `stg · ${name}`,
    environment: null,
    tier: null,
    door: { kind: "secret", scope: "stg", name },
    form: { kind: "fields", fields: [...MAILBOX_FIELDS] },
    held,
  });

let support = testing("slot-s", "mail-support", null);
const customer = testing("slot-c", "mail-customer", { at: ago(130), by: "Chuong", via: "page" });
const play = slot({ anchor: "slot-p", ref: { kind: "variable", environment: "production", key: "PLAY_SERVICE_ACCOUNT" }, label: "Play service account", detail: "PLAY_SERVICE_ACCOUNT", door: { kind: "variable", key: "PLAY_SERVICE_ACCOUNT", environment: "production", variable: null }, form: { kind: "file" } });
const ask = (n: number, s: SecretSlotView, why: string, minutes: number, example: string | null): SecretRequestView => ({
  id: id(n),
  askIds: [id(n)],
  slot: s,
  why,
  example,
  askedAt: ago(minutes),
  askedFor: "chuong",
  filled: null,
});

function read(): SecretSlotsRead {
  const requests = [
    ask(1, play, "Publishing the Android build to the Play store.", 1440, "service-account.json"),
    ask(2, slot({}), "Driver sign-in with Google needs it before the release.", 4, "GOCSPX-…"),
    ask(3, support, "Tests read and answer support mail as this mailbox.", 60, null),
    ask(4, customer, "Tests send mail to customers from this mailbox.", 120, null),
  ];
  const waiting = (r: SecretRequestView) => r.slot.held === null;
  return {
    requests: [...requests.filter(waiting), ...requests.filter((r) => !waiting(r))],
    groups: [
      {
        anchor: "app-production",
        kind: "app",
        name: "production",
        usedIn: [],
        tier: "production",
        slots: [
          slot({ anchor: "slot-id", ref: { kind: "variable", environment: "production", key: "GOOGLE_CLIENT_ID" }, label: "Google client ID", detail: "GOOGLE_CLIENT_ID", held: { at: ago(2880), by: "Chuong", via: "page" } }),
          slot({}),
          slot({ anchor: "slot-db", label: "Database URL", detail: "DATABASE_URL", held: { at: ago(600), by: null, via: "presigned" } }),
          play,
        ],
      },
      { anchor: "testing-stg", kind: "testing", name: "stg", usedIn: ["staging"], tier: null, slots: [support, customer] },
      { anchor: "connections", kind: "connections", name: null, usedIn: [], tier: null, slots: [slot({ anchor: "slot-k", ref: { kind: "integration", provider: "coolify" }, label: "Coolify", detail: "coolify", environment: null, tier: null, door: { kind: "connection", connection: id(9), field: "apiKey" }, held: { at: ago(20000), by: null, via: null } })] },
    ],
    says: "",
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const writes: { method: string; url: string; body: string }[] = [];
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? "GET";
  if (method === "GET" && url.includes("/support/secrets")) return json(read());
  writes.push({ method, url, body: String(init?.body ?? "") });
  if (method === "PUT" && url.includes("/secrets/stg/mail-support")) {
    support = { ...support, held: { at: new Date().toISOString(), by: "Chuong", via: "page" } };
    return json({ ref: "x", scope: "stg", name: "mail-support", updatedAt: new Date().toISOString() });
  }
  return new Promise<Response>(() => {});
};

const root = createRoot(document.getElementById("root") as HTMLElement);
let client: QueryClient;
/** The page as a link opens it: a fresh load at `?ask=`. */
function open(askId: string) {
  window.history.replaceState(null, "", `${window.location.pathname}?tab=secrets&ask=${askId}`);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  client.setQueryData(["project", P, "secret-slots"], read());
  root.render(
    <InRouter at="/projects/epod/settings" pattern="/projects/$slug/settings">
      <QueryClientProvider client={client} key={`${askId}-${Math.random()}`}>
        <div style={{ padding: 16, minHeight: 2400 }}>
          <SecretsSettings projectId={P} canWrite canEdit={false} />
        </div>
      </QueryClientProvider>
    </InRouter>,
  );
}
open(id(3));

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const article = (label: string) => document.querySelector<HTMLElement>(`article[aria-label="${label}"]`);
const sideways = () =>
  document.documentElement.scrollWidth > window.innerWidth ? [`the page scrolls sideways: ${document.documentElement.scrollWidth} px in a ${window.innerWidth} px window`] : [];

/** The linked request: highlighted, in the window, and holding the focus. */
function landed(label: string, focusIn: "input" | "article"): string[] {
  const wrong: string[] = [];
  const a = article(label);
  if (!a) return [`no request ${label} is drawn`];
  if (a.dataset.linked !== "true") wrong.push(`${label} is not highlighted as the linked request`);
  if (!a.textContent?.includes("From your link")) wrong.push(`${label} does not say it is the link's`);
  const r = a.getBoundingClientRect();
  if (r.top < 0 || r.top > window.innerHeight - 80) wrong.push(`${label} is not in the window: its top is at ${Math.round(r.top)} px of ${window.innerHeight}`);
  const focused = document.activeElement as HTMLElement | null;
  if (focusIn === "input" && !(focused instanceof HTMLInputElement && a.contains(focused))) wrong.push(`the focus is on ${focused?.tagName ?? "nothing"}, not ${label}'s first box`);
  if (focusIn === "article" && focused !== a) wrong.push(`the focus is on ${focused?.tagName ?? "nothing"}, not on ${label}`);
  return [...wrong, ...sideways()];
}

/** Types into a React-controlled box as a person does. */
function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function fillMailbox(): Promise<string[]> {
  const a = article("Mail support");
  if (!a) return ["no Mail support request"];
  const values = ["support@example.test", "fake-mailbox-0007", "imap.example.test", "993", "smtp.example.test", "465"];
  const inputs = [...a.querySelectorAll<HTMLInputElement>("input")];
  const labels = inputs.map((i) => a.querySelector(`label[for="${i.id}"]`)?.textContent ?? i.closest("label")?.textContent ?? "");
  inputs.forEach((i, n) => type(i, values[n] ?? ""));
  await settle(100);
  [...a.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Save")?.click();
  await settle(600);
  const wrong: string[] = [];
  if (inputs.length !== 6) wrong.push(`the mailbox has ${inputs.length} boxes, not six`);
  const sent = writes.find((w) => w.method === "PUT");
  if (!sent) wrong.push("Save sent nothing");
  else if (!sent.body.includes('\\"imapHost\\":\\"imap.example.test\\"')) wrong.push(`the value was not written as one JSON object: ${sent.body.slice(0, 80)}`);
  const after = article("Mail support");
  if (!after?.textContent?.includes("Has a value")) wrong.push("the saved request does not read Has a value");
  if (!after?.textContent?.includes("Nothing needed")) wrong.push("the saved request does not say nothing is to do");
  if (labels.some((l) => /json/i.test(l))) wrong.push("a box asks for JSON");
  return [...wrong, ...sideways()];
}

function filledLink(): string[] {
  const wrong = landed("Mail customer", "article");
  const a = article("Mail customer");
  if (!a?.textContent?.includes("Has a value")) wrong.push("the filled slot does not read Has a value");
  if (!a?.textContent?.includes("by Chuong")) wrong.push("the filled slot does not say by whom");
  if (!a?.textContent?.includes("Nothing needed")) wrong.push("the filled slot does not say nothing is to do");
  if (a?.querySelector("input")) wrong.push("the filled slot draws a form");
  return wrong;
}

window.__witness = {
  cases: [
    { name: "desktop", width: 1440 },
    { name: "phone", width: 390, height: 844 },
  ],
  ready: () => article("Mail support") !== null && document.activeElement instanceof HTMLInputElement,
  stages: [
    { name: "light-landed", run: async () => (theme("light"), await settle(), landed("Mail support", "input")) },
    { name: "light-filled", run: fillMailbox },
    { name: "light-filled-link", run: async () => (open(id(4)), await settle(600), filledLink()) },
    { name: "dark-landed", run: async () => (theme("dark"), (support = { ...support, held: null }), open(id(3)), await settle(600), landed("Mail support", "input")) },
    { name: "dark-filled-link", run: async () => (open(id(4)), await settle(600), filledLink()) },
  ],
};
