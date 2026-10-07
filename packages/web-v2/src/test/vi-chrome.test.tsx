import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InterfaceLanguageScope } from "@/lib/i18n/interface-language";
import { CHROME_SCREENS, type ChromeScreen } from "./vi-chrome-screens";
import { renderWithQuery } from "./render";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/" }));
// The bell's live delivery and a room's socket reach for a connection the walking test has none of.
vi.mock("@/features/notifications/use-notification-delivery", () => ({ useNotificationDelivery: () => undefined }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
// The canvas itself is drawn by React Flow, which jsdom cannot lay out; its chrome is rendered on its own ("Workflow canvas").
vi.mock("@/features/workflows/canvas/workflow-canvas", () => ({ WorkflowCanvas: () => null }));
// A query no screen was seeded with stays pending rather than reaching for a network.
vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
// cmdk scrolls its selected item into view, which jsdom does not lay out
Element.prototype.scrollIntoView = () => {};

// Words that are English chrome and have a Vietnamese word in the locale file. A screen rendered in vi
// that still shows one of them has a string that never went through the locale file. Brand and
// product terms the vi copy keeps (Release, Workflow, Issue, Runner, Master) are not on the list.
const ENGLISH_CHROME = [
  "needs you", "nothing", "waiting", "lands", "late", "progress", "requirements", "untriaged", "overview", "dashboard", "settings",
  "sign out", "next release", "open full page", "show", "hide", "close", "cancel", "loading", "failed", "couldn't", "no ", "search",
  "waits on", "then", "forecast", "landed", "shipped", "feedback about",
  "release train", "coming next", "approve", "return", "criteria", "proven", "maintenance", "what users get", "technical", "notes", "checks", "issues in this release",
  "cut", "approval", "decision", "policy", "environment", "deploy", "passed", "details", "reason", "designs", "diagram", "steps",
  "states", "owner", "deadline", "revisions", "decisions", "health", "updated", "all", "walk through", "zoom", "fit", "minimap",
  "legend", "stage", "next", "back", "finish", "system overview", "main journey", "users", "external systems", "where it stands", "properties", "template",
  "drawn by", "the code", "trace", "if", "who owns what", "newest first", "proposal", "coverage", "summary", "scope", "accept", "reject",
  "defer", "drop", "created", "suggestions", "activity", "evidence", "persona", "wording", "assistant", "pending", "promote", "retry",
  "step", "ago", "feedback", "triage", "funnel", "reporter", "reporters", "decline", "snooze", "reopen", "severity", "carried by",
  "sent", "message", "internal note", "preview", "history", "mockups", "route it", "unknown", "flagged", "description", "answered", "confirm",
  "what happened", "move it", "why", "status", "state", "sensitive", "clarification", "verifies", "duplicate of", "original", "until", "subject",
  "attention", "back to", "group by", "facts", "lifecycle", "optional", "add note", "send", "suggested",
  "account", "preferences", "profile", "theme", "notifications", "conversation", "conversations", "chat", "pin", "unpin", "archive",
  "archived", "delete", "rename", "copy", "workspace", "projects", "switch", "find", "organization", "docs", "threads", "ecosystem",
  "home", "more", "navigate", "actions", "recent", "pinned", "no matches", "resolved", "invitation", "mention", "sound", "desktop",
  "save", "restore", "reply style", "instructions", "upload", "sketch", "caption", "withdraw", "authority", "options considered",
  "rollback", "removed", "release note", "gate", "verdict", "owes", "held back", "sidebar", "people", "live", "not found", "add project",
  "priority", "assignee", "board", "wave", "blocked", "blocking", "queued", "running", "paused", "resume", "merged", "branch", "comment",
  "comments", "runs", "open", "closed", "on hold", "move", "mark", "labels", "complexity", "category", "cost", "tokens", "dependencies",
  "selected", "clear", "filter", "sort", "newest", "oldest", "previous", "heartbeat", "stale", "attempt", "cooldown", "answer", "question",
  "who", "build", "plan", "estimated", "critical", "high", "medium", "low", "bug", "lease", "nobody", "everyone", "list", "table",
];

const wordsIn = (root: HTMLElement): string[] => {
  const out: string[] = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) out.push(n.textContent ?? "");
  for (const el of root.querySelectorAll("[aria-label],[title],[placeholder]")) {
    for (const a of ["aria-label", "title", "placeholder"]) {
      const v = el.getAttribute(a);
      // a state badge's tooltip leads with its raw value (`shipped · ...`) and an enum badge's ends with
      // it (`kind: bug`), kept in English on purpose: the field word and the meaning are what is read
      const raw = el.getAttribute("data-value");
      const read = a !== "title" || !raw ? v : v === raw ? null : v?.startsWith(`${raw} · `) ? v.slice(raw.length + 3) : v?.endsWith(`: ${raw}`) ? v.slice(0, -raw.length - 2) : v;
      if (read) out.push(read);
    }
  }
  return out;
};

/** The English chrome word found in a rendered screen, with the text carrying it; null when none. */
function englishChromeIn(root: HTMLElement): { word: string; text: string } | null {
  for (const text of wordsIn(root)) {
    const lower = ` ${text.toLowerCase()} `;
    for (const w of ENGLISH_CHROME) {
      // a snake_case value (`in_progress`), a dotted permission (`workflow-designs.approve`) or a field in code quotes (`persona`) is an identifier the text names on purpose, not chrome
      if (new RegExp(`[^\\p{L}_.\`-]${w.trim()}[^\\p{L}_\`]`, "u").test(lower)) return { word: w.trim(), text };
    }
  }
  return null;
}

const inVi = (s: ChromeScreen) => (
  <InterfaceLanguageScope language="vi">{s.render()}</InterfaceLanguageScope>
);

describe("BA screens under vi", () => {
  for (const screen of CHROME_SCREENS) {
    it(`${screen.name} shows no English chrome word`, () => {
      // the whole document: a menu, a popover or a dialog the screen opens is drawn in a portal
      const { baseElement } = renderWithQuery(inVi(screen));
      if (screen.act) act(screen.act);
      const found = englishChromeIn(baseElement);
      expect(found, found ? `English chrome word "${found.word}" on screen "${screen.name}": "${found.text}"` : "").toBeNull();
    });
  }

  it("goes red, naming the word and the screen, on an English string planted in the Dashboard", () => {
    const planted: ChromeScreen = { name: "Dashboard", render: () => <p>Nothing to show here</p> };
    const { container } = render(inVi(planted));
    const found = englishChromeIn(container);
    expect(found?.word).toBe("nothing");
    expect(`English chrome word "${found?.word}" on screen "${planted.name}"`).toContain('on screen "Dashboard"');
  });
});

/** The rail's row labels of a screen drawn in `language`, in the order they stand. */
function factLabels(screen: ChromeScreen, language: "en" | "vi"): string[] {
  const { baseElement, unmount } = renderWithQuery(<InterfaceLanguageScope language={language}>{screen.render()}</InterfaceLanguageScope>);
  if (screen.act) act(screen.act);
  const labels = [...baseElement.querySelectorAll("[data-fact-label]")].map((el) => el.textContent?.trim() ?? "");
  unmount();
  return labels;
}

/** Two rows whose English labels differ and whose Vietnamese ones are the same word: the reader cannot tell them apart. */
function collapsedLabels(en: string[], vi: string[]): { vi: string; en: [string, string] } | null {
  for (let i = 0; i < vi.length; i++) {
    for (let j = i + 1; j < vi.length; j++) {
      if (vi[i] === vi[j] && en[i] !== en[j]) return { vi: vi[i] as string, en: [en[i] as string, en[j] as string] };
    }
  }
  return null;
}

describe("a rail's row labels under vi", () => {
  for (const screen of CHROME_SCREENS) {
    it(`${screen.name}: two rows with different English labels never read as one Vietnamese word`, () => {
      const en = factLabels(screen, "en");
      const vi = factLabels(screen, "vi");
      expect(vi.length, `${screen.name} draws ${en.length} rows in en and ${vi.length} in vi`).toBe(en.length);
      const hit = collapsedLabels(en, vi);
      expect(hit, hit ? `"${hit.en[0]}" and "${hit.en[1]}" both read "${hit.vi}" on screen "${screen.name}"` : "").toBeNull();
    });
  }

  it("goes red on two rows whose different English labels share one Vietnamese word", () => {
    expect(collapsedLabels(["ETA", "Forecast"], ["Dự kiến", "Dự kiến"])).toEqual({ vi: "Dự kiến", en: ["ETA", "Forecast"] }); // i18n-allow: the planted collision pair
    expect(collapsedLabels(["State", "State"], ["Trạng thái", "Trạng thái"])).toBeNull(); // i18n-allow: one English label read twice is no collision
  });
});
