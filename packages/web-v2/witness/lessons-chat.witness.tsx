// A project chat's lesson lines witnessed as drawn (REQ-50 BC-1, BC-4), at phone and desktop width,
// light and dark: under the person's reply the classifier kept, "Kept as a correction · Not a
// correction"; under the answer, the lessons it applied, each with "Wrongly applied". Mounted inside
// the real thread, so the lines sit where a reader meets them.
//
//   pnpm --filter web-v2 witness witness/lessons-chat.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ConversationThread } from "@/features/conversations/components/conversation-thread";
import type { ConversationMessage } from "@/features/conversations/types";
import "./entry";
import { stubLessonsCore } from "./lessons.fixture";
import { InRouter } from "./router";

const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const said = (id: string, role: "user" | "assistant", content: string, minutes: number) =>
  ({ id, role, content, createdAt: at(minutes), blocks: null }) as unknown as ConversationMessage;

const MESSAGES = [
  said("m-ask", "user", "List the wards for tonight's handover.", 9),
  said("m-first", "assistant", "Tonight's wards: Aster, Birch, Cedar, Dahlia, Elm.", 8),
  said("m-person", "user", "The ward list is sorted by name again; nurses read it by floor.", 6),
  said("m-answer", "assistant", "By floor: ground floor Elm and Aster; first floor Birch; second floor Cedar and Dahlia. Each ward shows its bed count and the nurse in charge.", 5),
];

window.localStorage.clear();
stubLessonsCore();
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter>
    <QueryClientProvider client={client}>
      <div className="min-h-screen bg-app p-4" data-testid="witness-chat">
        <div className="mx-auto max-w-3xl">
          <ConversationThread projectId="p1" projectSlug="forge-dev" conversationId="cv1" messages={MESSAGES} windows={[]} />
        </div>
      </div>
    </QueryClientProvider>
  </InRouter>,
);

const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const settle = () => new Promise((r) => setTimeout(r, 200));

function inside(): string[] {
  const wrong: string[] = [];
  for (const el of document.querySelectorAll("[data-testid=witness-chat] button, [data-testid=witness-chat] p")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > window.innerWidth + 0.5) wrong.push(`"${(el.textContent ?? "").trim().slice(0, 40)}" runs past the window's right edge`);
  }
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
  return wrong;
}

function drawn(): string[] {
  const wrong: string[] = [];
  const kept = document.querySelectorAll("[data-testid=chat-lesson-correction]");
  if (kept.length !== 1) wrong.push(`${kept.length} replies say they were kept as a correction, not the one the classifier kept`);
  if (!document.querySelector("[data-testid=chat-lesson-dismiss]")) wrong.push("the kept correction offers no way to say it was not one");
  const applied = document.querySelector("[data-testid=chat-lessons-applied]");
  if (!applied?.textContent?.includes("L-2") || !applied.textContent.includes("L-3")) wrong.push("the answer does not list the lessons it applied");
  if (document.querySelectorAll("[data-testid=chat-lesson-wrong]").length !== 2) wrong.push("each applied lesson does not offer Wrongly applied");
  return wrong;
}

window.__witness = {
  cases: [
    { name: "chat-phone", width: 390 },
    { name: "chat-desktop", width: 1280 },
  ],
  ready: () => document.querySelector("[data-testid=chat-lessons-applied]") !== null,
  stages: [
    {
      name: "light",
      run: async () => {
        theme("light");
        await settle();
        return [...drawn(), ...inside()];
      },
    },
    {
      name: "wrong-light",
      run: async () => {
        document.querySelector<HTMLElement>("[data-testid=chat-lesson-wrong]")?.click();
        await settle();
        return [...(document.querySelector("[data-testid=reject-step]") ? [] : ["Wrongly applied asks for no reason"]), ...inside()];
      },
    },
    {
      name: "dark",
      run: async () => {
        theme("dark");
        await settle();
        return inside();
      },
    },
  ],
};
