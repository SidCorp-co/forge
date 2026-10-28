// @vitest-environment jsdom

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "@/design/patterns/markdown";
import { inlineCode } from "@/features/project-settings/components/inline-code";
import { unbrokenKeys } from "./unbroken-keys";

expect.extend(matchers);
afterEach(cleanup);

const held = (root: Element) =>
  [...root.querySelectorAll("span.whitespace-nowrap")].map((k) => k.textContent);

// ISS-1421 r42 (judge-169): "ISS-5" broke at its hyphen at 390 in the Batch release dialog's lead.
describe("an issue key in a sentence is one unbroken token", () => {
  it("holds each key on one line and leaves the rest of the sentence plain", () => {
    const { container } = render(<p>{unbrokenKeys("ISS-7, HOP-12 and ISS-1421 have no release note.")}</p>);
    expect(held(container)).toEqual(["ISS-7", "HOP-12", "ISS-1421"]);
    expect(container).toHaveTextContent("ISS-7, HOP-12 and ISS-1421 have no release note.");
  });

  it("takes no part of a longer word, a version or a lower-case phrase", () => {
    const { container } = render(
      <p>{unbrokenKeys("XISS-12abc, iss-4, ISS-, A-1, a re-run and 0.10.0 are not keys.")}</p>,
    );
    expect(held(container)).toEqual([]);
  });

  it("holds the keys in a sentence the inline renderer draws, beside its code spans", () => {
    const { container } = render(<p>{inlineCode("ISS-6 is not marked merged; send `mark_merged` for ISS-6.")}</p>);
    expect(held(container)).toEqual(["ISS-6", "ISS-6"]);
    expect(container.querySelector("code")).toHaveTextContent("mark_merged");
  });

  it("holds the keys in a comment's Markdown, in prose, lists, links and inline code", () => {
    const { container } = render(
      <Markdown>{"Blocked by ISS-5.\n\n- see [ISS-9](https://example.test/9)\n\n`ISS-3` stays code."}</Markdown>,
    );
    expect(held(container)).toEqual(["ISS-5", "ISS-9", "ISS-3"]);
    expect(container.querySelector("code")).toHaveTextContent("ISS-3");
    expect(container).toHaveTextContent("Blocked by ISS-5.");
  });

  it("leaves a fenced block as it is written", () => {
    const { container } = render(<Markdown>{"```\nISS-3 in a block\n```"}</Markdown>);
    expect(held(container)).toEqual([]);
    expect(container.querySelector("pre")).toHaveTextContent("ISS-3 in a block");
  });
});
