// The dashboard's failed-onboarding line (ISS-605 c2), drawn from forge's own live onboarding read on
// forge-dev with the hint core now derives from it (`onboarding-failed.fixture.json`): who acts reads
// as the role holding onboarding.request, never the permission id, and You to its holder, who alone is
// offered the act; the same in Vietnamese; and the runner's failure tag only in the Developer view.
//
//   pnpm --filter web-v2 witness witness/onboarding-failed.witness.tsx --out <dir> --clip

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { writeUrlParams } from "@/design/hooks/use-url-params";
import { OnboardingHint } from "@/features/onboarding";
import { InterfaceLanguageScope } from "@/lib/i18n/interface-language";
import "./entry";
import LIVE from "./onboarding-failed.fixture.json";
import { InRouter } from "./router";

type Reader = "member" | "you";
let reader: Reader = "member";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input), "http://witness.test").pathname;
  if ((init?.method ?? "GET") === "GET" && path.endsWith("/onboarding")) {
    return json({ onboarding: LIVE.onboarding, hint: LIVE.hints[reader], firstRequirements: null });
  }
  return new Promise<Response>(() => {});
};

const root = createRoot(document.getElementById("root") as HTMLElement);

let shown = 0;

/** Draws the line for `next` in `language`, tagged so a stage reads its own render, never the last one. */
function show(next: Reader, language: "en" | "vi"): string {
  reader = next;
  shown += 1;
  const stage = String(shown);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root.render(
    <InRouter key={`${next}-${language}-${Math.random()}`} at="/projects/forge" pattern="/projects/$slug">
      <QueryClientProvider client={client}>
        <InterfaceLanguageScope language={language}>
          <main className="min-h-screen bg-app text-fg" data-witness="page" data-stage={stage}>
            <OnboardingHint projectId="p1" projectName="forge" />
          </main>
        </InterfaceLanguageScope>
      </QueryClientProvider>
    </InRouter>,
  );
  return stage;
}

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function drawn(stage: string): Promise<HTMLElement | null> {
  for (let i = 0; i < 60; i += 1) {
    const line = q(`[data-stage="${stage}"] [data-testid=onboarding-hint]`);
    if (line) return line;
    await pause(50);
  }
  return null;
}

/** What is wrong with the line a reader sees: its words, its act, and whether the runner's tag shows. */
async function reads(stage: string, want: { line: string; act: boolean; tag: boolean }): Promise<string[]> {
  const line = await drawn(stage);
  if (!line) return ["the onboarding line is not drawn"];
  const text = line.textContent ?? "";
  const wrong: string[] = [];
  if (!text.includes(want.line)) wrong.push(`the line reads "${text}", not "${want.line}"`);
  if (text.includes("onboarding.request")) wrong.push("the line names the permission id onboarding.request");
  if (Boolean(q("[data-testid=onboarding-hint-action]")) !== want.act) wrong.push(want.act ? "the act is not offered" : "the act is offered to a reader the ask refuses");
  if (!want.act && !q("[data-testid=onboarding-hint-act]")) wrong.push("the line does not say the act");
  if (Boolean(q("[data-testid=onboarding-hint-ended]")) !== want.tag) wrong.push(want.tag ? "the Developer view hides the runner's tag" : "the runner's tag shows outside the Developer view");
  if (!want.tag && text.includes("cc-startup-death")) wrong.push("the line carries the runner's tag");
  return wrong;
}

window.__witness = {
  cases: [{ name: "dashboard-line-1440", width: 1440 }],
  ready: () => true,
  stages: [
    {
      name: "member-en",
      run: () => {
        const stage = show("member", "en");
        return reads(stage, { line: "Attempt 10 failed · Waits on: Member · Ask for a re-analysis", act: false, tag: false });
      },
    },
    {
      name: "you-en",
      run: () => {
        const stage = show("you", "en");
        return reads(stage, { line: "Attempt 10 failed · Waits on: You · Ask for a re-analysis", act: true, tag: false });
      },
    },
    {
      name: "member-vi",
      run: () => {
        const stage = show("member", "vi");
        return reads(stage, { line: "Lần thử 10 thất bại · Đang chờ: Thành viên · Yêu cầu phân tích lại", act: false, tag: false }); // i18n-allow: the vi line the witness reads
      },
    },
    {
      name: "developer-view",
      run: () => {
        writeUrlParams({ view: "developer" });
        const stage = show("you", "en");
        return reads(stage, { line: "Attempt 10 failed · Waits on: You · Ask for a re-analysis", act: true, tag: true });
      },
    },
  ],
};
