// The session page names the rules the reply check held a conversation reply on: they were stamped on
// the session's marker for this, where before 2026-10-08 they reached only a server log line.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HeldReplyForRun } from "./held-reply-for-run";

describe("the session page's held reply section", () => {
  it("lists each rule the reply was held on, with why and the words it quoted", () => {
    const metadata = {
      conversationAgent: {
        held: {
          at: "2026-10-08T03:48:42.195Z",
          text: "I'll look into it and get back to you.",
          refusals: [{ rule: "no-empty-promise", why: "reply promises a future action but there is no follow-up turn", quote: "I'll look into it", shape: "report the result you have" }],
        },
      },
    };
    render(<HeldReplyForRun metadata={metadata} />);
    const section = screen.getByTestId("session-held-reply");
    expect(section.textContent).toContain("Reply held");
    expect(section.textContent).toContain("no-empty-promise");
    expect(section.textContent).toContain("no follow-up turn");
    expect(section.textContent).toContain("I'll look into it");
  });

  it("says a check that could not run could not run, and why, never the instruction it gave the model", () => {
    const metadata = {
      conversationAgent: {
        held: {
          at: "2026-10-08T16:00:00.000Z",
          text: "ISS-395 is merged and closed.",
          refusals: [
            {
              rule: "issue-keys-exist",
              why: "the issues this message names could not be read from the tracker this turn, so none of them can be checked — leave the issue keys out",
              quote: null,
              shape: "every issue key names an issue",
              unchecked: "the issues it names could not be read from the tracker this turn",
            },
          ],
        },
      },
    };
    render(<HeldReplyForRun metadata={metadata} />);
    const section = screen.getByTestId("session-held-reply");
    expect(section.textContent).toContain("issue-keys-exist");
    expect(section.textContent).toContain(
      "This check could not run, because the issues it names could not be read from the tracker this turn. That failed on Forge's side; the reply broke nothing it checked.",
    );
    expect(section.textContent).not.toContain("leave the issue keys out");
  });

  it("draws nothing for a session whose reply was not held", () => {
    const { container } = render(<HeldReplyForRun metadata={{ conversationAgent: { failure: null } }} />);
    expect(container.textContent).toBe("");
  });
});
