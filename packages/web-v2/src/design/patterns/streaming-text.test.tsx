// @vitest-environment jsdom
//
// ISS-1229 r41, judge-115: a code block in a room reply ran past the reply's right edge at 1280, where a sideways
// scroll shows no sign of itself; a reply's code block wraps inside the reply instead.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "./markdown";
import { StreamingText } from "./streaming-text";

afterEach(cleanup);

const REFUSAL =
  "```text\nforge issue failed: status is not a field an update writes: the tracker moves it on a route of its own and refuses it here.\n```";

const codeOf = (container: HTMLElement) => container.querySelector("pre > code") as HTMLElement;

describe("a code block in a reply", () => {
  it("wraps its long lines inside the reply rather than scrolling past its edge", () => {
    const { container } = render(<StreamingText text={REFUSAL} />);
    const code = codeOf(container);
    expect(code.textContent).toContain("refuses it here.");
    expect(code.className).toContain("whitespace-pre-wrap");
    expect(code.className).toContain("[overflow-wrap:anywhere]");
    expect(code.className).not.toContain("overflow-x-auto");
  });

  it("leaves a code block elsewhere scrolling, each line whole", () => {
    const { container } = render(<Markdown>{REFUSAL}</Markdown>);
    const code = codeOf(container);
    expect(code.className).toContain("overflow-x-auto");
    expect(code.className).not.toContain("whitespace-pre-wrap");
  });
});
