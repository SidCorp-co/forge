// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GithubLanded, githubLandedWords } from "./github-landed";

afterEach(cleanup);

describe("GithubLanded — GitHub's return when Forge could not finish (ISS-1421 r27)", () => {
  it("says in words why nothing was recorded, by the refusal's code", () => {
    render(<GithubLanded code="NOT_FOUND" />);
    expect(screen.getByText(/No GitHub App connected to a project you administer owns this installation/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Integrations" }).getAttribute("href")).toBe("/integrations");
  });

  it("names an unreadable App's key, and words any code it does not know the same safe way", () => {
    expect(githubLandedWords("CREDENTIAL_UNREADABLE")).toContain("could not read the stored key");
    expect(githubLandedWords("SOMETHING_NEW")).toBe(githubLandedWords(null));
    expect(githubLandedWords(null)).toMatch(/^Forge could not finish adding the GitHub App/);
  });

  it("never shows a code or a raw answer", () => {
    render(<GithubLanded code="CREDENTIAL_UNREADABLE" />);
    expect(document.body.textContent).not.toContain("CREDENTIAL_UNREADABLE");
    expect(document.body.textContent).not.toContain("{");
  });
});
