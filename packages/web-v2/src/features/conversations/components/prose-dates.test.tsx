// An assistant's prose reads an instant as a drawn block reads it (REQ-32 BC-17): the list's own
// reading in the viewer's timezone, never the ISO a model wrote, while code keeps its text as written.

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { doneDayText } from "@/lib/i18n/eta-clock-words";
import { instantsOn, readProseInstants } from "@/lib/i18n/instants";
import type { ConversationMessage, ConversationWindow } from "../types";
import { ConversationThread } from "./conversation-thread";

const SHIPPED = "2026-10-04T18:19:08.744Z";

beforeAll(() => {
  process.env.TZ = "Asia/Ho_Chi_Minh";
});
afterEach(cleanup);

const clock = () => ({ lang: "en" as const, now: Date.now(), timeZone: "Asia/Ho_Chi_Minh" });

const said = (content: string): ConversationMessage =>
  ({
    id: "m2",
    seq: 2,
    role: "assistant",
    authorUserId: null,
    authorLabel: null,
    content,
    blocks: null,
    silenceReason: null,
    createdAt: "2026-10-08T03:47:00Z",
  }) as unknown as ConversationMessage;

const window1: ConversationWindow = {
  id: "w1",
  firstSeq: 1,
  lastSeq: 2,
  closedAt: "2026-10-08T03:47:10Z",
  decision: null,
  decisionDetail: null,
};

const drawn = (content: string) => {
  render(<ConversationThread messages={[said(content)]} windows={[window1]} />);
  return document.body.textContent ?? "";
};

describe("an assistant's prose reads an instant as the blocks do", () => {
  it("shows the list's reading where the model wrote an ISO instant", () => {
    const text = drawn(`REQ-3 shipped at ${SHIPPED}.`);
    expect(text).toContain(`shipped at ${doneDayText(SHIPPED, clock())}.`);
    expect(text).not.toContain("2026-10-04");
  });

  it("reads the model's spaced UTC form ('2026-10-09 01:03 UTC') as the one instant it names, not as a day with a UTC time left beside it (BC-4, BC-17)", () => {
    const text = drawn("The report was read at 2026-10-09 01:03 UTC.");
    expect(text).toContain(`read at ${doneDayText("2026-10-09T01:03:00Z", clock())}.`);
    expect(text).not.toContain("UTC");
    expect(text).not.toContain("2026-10-09");
  });

  it("keeps an instant in a code span, a fenced block and a link destination as written", () => {
    const text = drawn(`Run \`date -d ${SHIPPED}\` then:\n\n\`\`\`\nat ${SHIPPED}\n\`\`\`\n\nSee [log](/logs/${SHIPPED}) and ${SHIPPED}.`);
    expect(text.split(SHIPPED).length - 1).toBe(2);
    expect(text).toContain(`${doneDayText(SHIPPED, clock())}.`);
  });
});

describe("readProseInstants", () => {
  const r = instantsOn(clock());
  const read = doneDayText(SHIPPED, clock());
  it.each([
    ["plain", `a ${SHIPPED} b`, `a ${read} b`],
    ["span", `a \`${SHIPPED}\` b ${SHIPPED}`, `a \`${SHIPPED}\` b ${read}`],
    ["double-tick span", `a \`\`x \` ${SHIPPED}\`\` ${SHIPPED}`, `a \`\`x \` ${SHIPPED}\`\` ${read}`],
    ["tilde fence", `~~~\n${SHIPPED}\n~~~\n${SHIPPED}`, `~~~\n${SHIPPED}\n~~~\n${read}`],
    ["unclosed fence runs to the end", `${SHIPPED}\n\`\`\`\n${SHIPPED}`, `${read}\n\`\`\`\n${SHIPPED}`],
    ["unmatched tick is text", `a \` ${SHIPPED}`, `a \` ${read}`],
    ["no instant", "nothing here", "nothing here"],
  ])("%s", (_n, input, want) => {
    expect(readProseInstants(input, r)).toBe(want);
  });
});
