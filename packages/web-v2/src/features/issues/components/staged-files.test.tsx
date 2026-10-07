// HOP ISS-126 (dev, 2026-10-07): fifteen files chosen for one comment staged the first ten and
// dropped the rest, and the person found out from the thread. Core takes any number of files on a
// comment, one upload each, so the composer stages them all; an issue's create carries at most
// ISSUE_CREATE_ATTACHMENTS_MAX inline, so a pick past it is refused whole, by name, before any upload.

import { ISSUE_CREATE_ATTACHMENTS_MAX } from "@forge/contracts/attachments";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { StagedFileList, useStagedFiles } from "./staged-files";

function Composer({ unit }: { unit: "comment" | "issue" }) {
  const staged = useStagedFiles({ unit, video: false, uniqueNames: unit === "issue" });
  return (
    <div>
      {staged.input}
      <StagedFileList files={staged.files} warnings={staged.warnings} remove={staged.remove} />
    </div>
  );
}

const files = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => new File([`shot ${from + i}`], `shot-${from + i}.png`, { type: "image/png" }));

function picker(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("no file input");
  return input;
}

describe("files chosen for a comment", () => {
  it("are staged every one, past ten", async () => {
    const user = userEvent.setup();
    const { container } = render(<Composer unit="comment" />);
    await user.upload(picker(container), files(15));
    expect(screen.getAllByRole("button", { name: /^Remove shot-/ })).toHaveLength(15);
    expect(screen.queryByText(/skipped/i)).toBeNull();
  });
});

describe("files chosen for a new issue", () => {
  it("are refused whole, by name, when the pick would carry more than the create takes", async () => {
    const user = userEvent.setup();
    const { container } = render(<Composer unit="issue" />);
    await user.upload(picker(container), files(8));
    await user.upload(picker(container), files(4, 8));
    expect(screen.getAllByRole("button", { name: /^Remove shot-/ })).toHaveLength(8);
    expect(
      screen.getByText(
        `An issue takes at most ${ISSUE_CREATE_ATTACHMENTS_MAX} files; 12 chosen. Remove some, or attach the rest to a comment once it is filed.`,
      ),
    ).toBeInTheDocument();
  });

  it("are staged up to the limit exactly", async () => {
    const user = userEvent.setup();
    const { container } = render(<Composer unit="issue" />);
    await user.upload(picker(container), files(ISSUE_CREATE_ATTACHMENTS_MAX));
    expect(screen.getAllByRole("button", { name: /^Remove shot-/ })).toHaveLength(ISSUE_CREATE_ATTACHMENTS_MAX);
    expect(screen.queryByText(/at most/)).toBeNull();
  });
});
