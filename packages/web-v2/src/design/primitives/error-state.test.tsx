// @vitest-environment jsdom
//
// ISS-1229 r43, judge-120: an error state's title was a <p>, so a page made of one held no heading at all.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorState } from "./error-state";

afterEach(cleanup);

describe("an error state's title", () => {
  it("is a heading, one level under the page's own title by default", () => {
    render(<ErrorState mascot={false} title="Couldn't load issue" message="The server did not answer." />);
    expect(screen.getByRole("heading", { level: 2, name: "Couldn't load issue" })).toBeTruthy();
  });

  it("is the page's heading where the error state is the whole page", () => {
    render(<ErrorState mascot={false} level={1} title="This issue is not in Desk" message="It belongs to Vault." />);
    expect(screen.getByRole("heading", { level: 1, name: "This issue is not in Desk" })).toBeTruthy();
  });

  it("keeps its default title as a heading too", () => {
    render(<ErrorState mascot={false} message="The server did not answer." />);
    expect(screen.getByRole("heading", { name: "Couldn't load" })).toBeTruthy();
  });
});
