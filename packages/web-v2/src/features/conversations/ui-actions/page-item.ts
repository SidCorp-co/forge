// The record the page beside the chat is about, read off its path (REQ-30 BC-6), and the mockup open
// full screen over it (REQ-49 BC-4).

import { type UiPageItem, uiPageItemSchema } from "@forge/contracts/ui-actions";

// each record page's list segment under /projects/<slug>, and the kind of record it shows
const ITEM_SEGMENT: Record<string, UiPageItem["kind"]> = {
  issues: "issue",
  requirements: "requirement",
  feedback: "feedback",
  workflows: "workflow",
};

/** The record a project path is the page of (`/requirements/REQ-30`), or null: a key its kind does not take names none. */
export function pageItemOf(rest: string): UiPageItem | null {
  const m = /^\/([a-z]+)\/([^/]+)$/.exec(rest);
  const kind = m ? ITEM_SEGMENT[m[1]] : undefined;
  if (!m || !kind) return null;
  let key: string;
  try {
    key = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  const parsed = uiPageItemSchema.safeParse({ kind, key });
  return parsed.success ? parsed.data : null;
}

const MOCKUP_HOSTS: ReadonlySet<UiPageItem["kind"]> = new Set(["requirement", "feedback", "issue"]);

/**
 * A mockup open full screen on its item's page (`?mockup=MK-n`) is what the page is about while it is
 * open, so a chat started there is about the mockup (REQ-49 BC-4); otherwise the page's own record.
 */
export function mockupOpenOn(item: UiPageItem | null, search: string): UiPageItem | null {
  if (!item || !MOCKUP_HOSTS.has(item.kind)) return item;
  const parsed = uiPageItemSchema.safeParse({ kind: "mockup", key: new URLSearchParams(search).get("mockup") ?? "" });
  return parsed.success ? parsed.data : item;
}
