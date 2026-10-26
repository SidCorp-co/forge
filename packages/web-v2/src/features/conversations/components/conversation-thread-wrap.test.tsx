// @vitest-environment node
// @gate-input whole-tree
//
// ISS-1229 r42, judge-118 at 390: a message holding a long URL ran past its bubble's right edge and the
// whole thread could be dragged 134px sideways. Laid out in a real Chrome over the app's stylesheet,
// because whether a word breaks inside its bubble is a fact of layout, which jsdom does not do.

import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeChrome, WARM_HOOK_MS, warmChrome } from "@/test-support/chrome-layout";
import { measuredAt } from "@/test-support/flat-in-chrome";
import type { ConversationItem } from "@/features/session/types";
import { Conversation } from "@/features/session/components/conversation";
import type { ConversationMessage, OutboxMessage } from "../types";
import { ConversationThread } from "./conversation-thread";

vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: "me" } }) }));

beforeAll(() => warmChrome(), WARM_HOOK_MS);
afterAll(() => closeChrome());

const URL_WORD = `https://example.com/api/v1/really/long/path/${"segment".repeat(30)}?query=${"x".repeat(60)}`;
const SAID = `Please post to ${URL_WORD} so the line is well over 250 characters.`;
const AT = "2026-10-25T11:20:00.000Z";

const said = (over: Partial<ConversationMessage>): ConversationMessage => ({
  id: "m1",
  seq: 0,
  role: "user",
  authorUserId: "me",
  authorLabel: "You",
  content: SAID,
  silenceReason: null,
  createdAt: AT,
  ...over,
});

const outbox = (state: OutboxMessage["state"]): OutboxMessage => ({
  id: `o-${state}`,
  content: SAID,
  state,
  ...(state === "failed" ? { error: "The room refused it." } : {}),
});

const prompt: ConversationItem = {
  kind: "prompt",
  id: "p1",
  turnId: "p1",
  turnIndex: 0,
  role: "user",
  thinkingCount: 0,
  text: SAID,
  blocks: [],
  attachments: [],
  editedAt: null,
};

const thread = () =>
  renderToStaticMarkup(
    <>
      <ConversationThread
        messages={[
          said({ id: "m1", seq: 0 }),
          said({ id: "m2", seq: 1, authorUserId: "u2", authorLabel: "Mai Tran" }),
          said({ id: "m3", seq: 2, role: "assistant", authorUserId: null, authorLabel: "Assistant" }),
        ]}
        windows={[]}
        outbox={[outbox("sending"), outbox("failed")]}
      />
      <Conversation items={[prompt]} />
    </>,
  );

interface Wrapped {
  viewport: number;
  scrollsSideways: boolean;
  bubbles: { at: string; past: number }[];
  pastColumn: number;
}

const MEASURE = `
(function () {
  function textRight(el) {
    var right = -Infinity;
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      var range = document.createRange();
      range.selectNodeContents(node);
      for (var r of range.getClientRects()) right = Math.max(right, r.right);
    }
    return right;
  }
  var col = document.getElementById("col");
  var bubbles = Array.prototype.filter
    .call(col.querySelectorAll(".rounded-lg"), function (el) { return el.textContent.indexOf("example.com") >= 0; })
    .map(function (el) {
      var host = el.closest("[data-testid]");
      return { at: host ? host.getAttribute("data-testid") : "prompt", past: Math.round(textRight(el) - el.getBoundingClientRect().right) };
    });
  var edge = col.getBoundingClientRect().right - 16;
  var doc = document.documentElement;
  return {
    viewport: window.innerWidth,
    scrollsSideways: doc.scrollWidth > doc.clientWidth + 1,
    bubbles: bubbles,
    pastColumn: Math.max(0, Math.round(textRight(col) - edge))
  };
})()`;

describe.each([1280, 390])("a long word in a room at %ipx", (viewport) => {
  it("wraps inside every bubble that holds it: the reader's own, another person's, an unsent one and a run's prompt", async () => {
    const m = await measuredAt<Wrapped>(thread(), viewport, MEASURE);
    expect(m.bubbles.map((b) => b.at).sort()).toEqual(
      ["prompt", "said-by-another", "said-by-you", "thread-outbox-failed", "thread-outbox-sending"].sort(),
    );
    expect(m.bubbles.filter((b) => b.past > 0)).toEqual([]);
  });

  it("runs no text, the assistant's reply included, past the column, so the thread never scrolls sideways", async () => {
    const m = await measuredAt<Wrapped>(thread(), viewport, MEASURE);
    expect(m.pastColumn).toBe(0);
    expect(m.scrollsSideways).toBe(false);
  });
});
