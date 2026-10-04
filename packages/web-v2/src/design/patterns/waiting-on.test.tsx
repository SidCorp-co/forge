// @vitest-environment jsdom
//
// Whose turn it is reads the same everywhere: who in bold, what they owe, the whole line and the rule on hover.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActorChip } from "./person-chip";
import { WaitingOn } from "./waiting-on";

expect.extend(matchers);
afterEach(cleanup);

describe("WaitingOn", () => {
  it("says who and what, with the whole of it and the rule in the tooltip", () => {
    render(<WaitingOn w={{ kind: "you", who: "You", act: "approve the release", rule: "release.approval.required" }} />);
    const w = screen.getByTestId("waiting-on");
    expect(w).toHaveTextContent("You · approve the release");
    expect(w.getAttribute("title")).toBe("You · approve the release — release.approval.required");
    expect(w.dataset.kind).toBe("you");
  });

  it("keeps what a narrow cell truncates readable on hover", () => {
    render(<WaitingOn w={{ kind: "system", who: "Release gate", act: "release note missing and 1 more" }} />);
    expect(screen.getByTestId("waiting-on").getAttribute("title")).toBe("Release gate · release note missing and 1 more");
  });

  it("reads nobody as a quiet line", () => {
    render(<WaitingOn w={{ kind: "none", who: "Nobody", act: "" }} />);
    expect(screen.getByTestId("waiting-on")).toHaveTextContent(/^Nobody$/);
  });
});

describe("ActorChip", () => {
  it("marks an agent as one and a person as a person", () => {
    render(
      <>
        <ActorChip name="Master" kind="agent" />
        <ActorChip name="Bao" kind="human" />
      </>,
    );
    expect(screen.getByTestId("agent-chip").getAttribute("title")).toBe("Master · agent");
    expect(screen.getByTestId("person-chip")).toHaveTextContent("Bao");
  });
});
