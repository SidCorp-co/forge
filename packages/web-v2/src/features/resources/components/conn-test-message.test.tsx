// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConnTestMessage } from "./conn-test-message";

describe("a Test connection answer (ISS-1421 r11)", () => {
  it("shows the host's own words on a line of their own", () => {
    const ours =
      "The git host refused this deploy key. Give it read access to the repository, which is all Forge needs; devices that push with it need write access.";
    const host = "git@github.com: Permission denied (publickey).";
    const { container } = render(<ConnTestMessage message={`${ours}\n${host}`} />);
    const lines = [...container.querySelectorAll("span.block")].map((s) => s.textContent);
    expect(lines).toEqual([ours, host]);
  });
});
