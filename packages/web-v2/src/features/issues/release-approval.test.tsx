// @vitest-environment jsdom
//
// req-feedback-decisions: awaiting_release is amber (a person's turn) only where the project requires
// a release approval. The Table and the status edit draw from rows that carry no project rule, so
// the screen provides it; with no provider the contract default stands, and nothing pretends to know.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReleaseApprovalProvider, useStatusTone } from "./release-approval";

afterEach(cleanup);

function Probe({ status }: { status: string }) {
  return <span data-testid="tone">{useStatusTone(status) ?? "unknown"}</span>;
}

describe("an issue status's tone on its project", () => {
  it("reads awaiting_release as ready where no approval is required", () => {
    render(
      <ReleaseApprovalProvider value={false}>
        <Probe status="awaiting_release" />
      </ReleaseApprovalProvider>,
    );
    expect(screen.getByTestId("tone").textContent).toBe("ready");
  });

  it("reads it as a person's turn where approval is required", () => {
    render(
      <ReleaseApprovalProvider value>
        <Probe status="awaiting_release" />
      </ReleaseApprovalProvider>,
    );
    expect(screen.getByTestId("tone").textContent).toBe("you");
  });

  it("claims no tone where the project's rule is not known", () => {
    render(<Probe status="awaiting_release" />);
    expect(screen.getByTestId("tone").textContent).toBe("unknown");
  });

  it("leaves every other status at its legend tone", () => {
    render(
      <ReleaseApprovalProvider value={false}>
        <Probe status="needs_info" />
      </ReleaseApprovalProvider>,
    );
    expect(screen.getByTestId("tone").textContent).toBe("you");
  });
});
