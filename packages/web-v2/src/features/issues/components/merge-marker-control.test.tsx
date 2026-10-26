// @vitest-environment jsdom
//
// ISS-791 — the shipped-work claim had no human surface at all: `POST /api/issues/:id/merge` was
// reachable only from the CLI and MCP, so a person who finished an issue by hand could not say so.
// These pin the two states of the control and the exact request each sends.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import {
  BLURB,
  COMMIT_HINT,
  COMMIT_PLACEHOLDER,
  CORRECTION_PLACEHOLDER,
  EMPTY_COMMIT_LINE,
  LANDING_BLURB,
  LATER_BLURB,
  MergeMarkerControl,
} from "./merge-marker-control";

expect.extend(matchers);

const mark = vi.fn();
const unmark = vi.fn();

vi.mock("../hooks", async () => ({
  answerShown: (await vi.importActual<typeof import("../hooks")>("../hooks")).answerShown,
  useMergeMarker: () => ({ mark, unmark, isPending: false }),
}));

afterEach(() => {
  cleanup();
  mark.mockReset();
  unmark.mockReset();
});

describe("MergeMarkerControl", () => {
  it("offers the claim when nothing has been claimed, and sends the target it was given", () => {
    render(<MergeMarkerControl issueId="i1" mergedAt={null} />);

    fireEvent.click(screen.getByRole("button", { name: "Mark merged" }));
    fireEvent.change(screen.getByPlaceholderText(/branch or PR/i), { target: { value: "main" } });
    const buttons = screen.getAllByRole("button", { name: "Mark merged" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1] as HTMLElement);

    expect(mark).toHaveBeenCalledWith({ target: "main" }, expect.anything());
    expect(unmark).not.toHaveBeenCalled();
  });

  // ISS-1300 r3: the hold asks a person to name the commit that landed, and judge-117 found the first
  // mark's panel had no field to name it in, so the commit could only be sent through the API.
  it("offers Commit on a first mark in git, and sends the commit named there", () => {
    render(<MergeMarkerControl issueId="i1" mergedAt={null} landingShape="git" />);
    fireEvent.click(screen.getByRole("button", { name: "Mark merged" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Where it landed/ }), {
      target: { value: "main" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /^Commit/ }), {
      target: { value: " 0d018a9ac5897cd4ef3fe299f9c13e4c252162e2 " },
    });
    const buttons = screen.getAllByRole("button", { name: "Mark merged" });
    fireEvent.click(buttons[1] as HTMLElement);

    expect(mark).toHaveBeenCalledWith(
      { target: "main", commit: "0d018a9ac5897cd4ef3fe299f9c13e4c252162e2" },
      expect.anything(),
    );
  });

  // ISS-1300 r3 shots: at 390px the placeholder was cut at "checked a", hiding that the commit is
  // checked. The check is said under the field, and the example is short enough to read whole.
  // ISS-1300 r5 (judge-125, N1): at 390 a one-line field hid the digit a refusal was about.
  it("wraps Commit rather than scrolling it, so a whole sha shows at any width", () => {
    render(<MergeMarkerControl issueId="i1" mergedAt="2026-10-20T09:00:00Z" landingShape="git" />);
    fireEvent.click(screen.getByRole("button", { name: "Mark a later merge" }));
    const field = screen.getByRole("textbox", { name: /^Commit/ });
    expect(field.tagName).toBe("TEXTAREA");
    expect(field).toHaveClass("break-all", "font-mono");
    expect(fireEvent.keyDown(field, { key: "Enter" })).toBe(false);
  });

  it.each([null, "2026-10-20T09:00:00Z"])("says under Commit that it is checked (mergedAt %s)", (mergedAt) => {
    render(<MergeMarkerControl issueId="i1" mergedAt={mergedAt} landingShape="git" />);
    fireEvent.click(screen.getByRole("button", { name: mergedAt ? "Mark a later merge" : "Mark merged" }));
    expect(screen.getByRole("textbox", { name: /^Commit/ })).toHaveAccessibleDescription(COMMIT_HINT);
    expect(COMMIT_PLACEHOLDER.length).toBeLessThanOrEqual(32);
  });

  // ISS-1300 r4 (judge-121): on a marked issue the field corrects where the work landed, so its
  // example describes that, never "the merge commit of the later round".
  it("describes a correction in the Commit placeholder once the issue is marked", () => {
    render(<MergeMarkerControl issueId="i1" mergedAt="2026-10-20T09:00:00Z" landingShape="git" />);
    fireEvent.click(screen.getByRole("button", { name: "Mark a later merge" }));
    const field = screen.getByRole("textbox", { name: /^Commit/ });
    expect(field).toHaveAttribute("placeholder", "e.g. 3f9c2ab, where it landed");
    expect(field.getAttribute("placeholder")).not.toMatch(/later round/);
    expect(CORRECTION_PLACEHOLDER.length).toBeLessThanOrEqual(32);
  });

  it("offers no Commit on a first mark outside git, where nothing lands at a commit", () => {
    render(<MergeMarkerControl issueId="i1" mergedAt={null} landingShape="outside_git" />);
    fireEvent.click(screen.getByRole("button", { name: "Mark merged" }));
    expect(screen.queryByRole("textbox", { name: /^Commit/ })).toBeNull();
  });

  // ISS-1421 round 5: the field once opened holding the issue's own key, so one click marked the
  // work "merged into ISS-2". It opens empty, and nothing is sent until somebody says where.
  it("opens with Where it landed empty, and sends nothing until it is filled", () => {
    render(<MergeMarkerControl issueId="i1" mergedAt={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark merged" }));

    expect(screen.getByRole("textbox", { name: /Where it landed/ })).toHaveValue("");
    const buttons = screen.getAllByRole("button", { name: "Mark merged" });
    expect(buttons[1]).toBeDisabled();
    fireEvent.click(buttons[1] as HTMLElement);
    expect(mark).not.toHaveBeenCalled();
  });

  it("omits an untouched note instead of sending an empty one", () => {
    render(<MergeMarkerControl issueId="i1" mergedAt={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark merged" }));
    fireEvent.change(screen.getByPlaceholderText(/where it landed|branch or PR/i), {
      target: { value: "  feature/by-hand  " },
    });
    const buttons = screen.getAllByRole("button", { name: "Mark merged" });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);

    expect(mark).toHaveBeenCalledWith({ target: "feature/by-hand" }, expect.anything());
  });

  it("offers the retraction once a claim exists, and never the claim", () => {
    render(
      <MergeMarkerControl issueId="i1" mergedAt="2026-09-01T00:00:00.000Z" />,
    );

    expect(screen.queryByRole("button", { name: "Mark merged" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unmark" }));
    expect(unmark).toHaveBeenCalledTimes(1);
  });
});

// ISS-1421 round 7: once marked, the page offered only Unmark, so a later round could be recorded
// only by unmarking first, which turns the move into a first mark nothing compares.
describe("MergeMarkerControl on an issue already marked, whose work lands in git", () => {
  const MARKED = "2026-10-16T00:00:00.000Z";

  it("offers Mark a later merge beside Unmark", () => {
    render(<MergeMarkerControl issueId="i1" mergedAt={MARKED} landingShape="git" />);
    expect(screen.getByRole("button", { name: "Mark a later merge" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unmark" })).toBeInTheDocument();
  });

  it("sends the later commit with the target, and never an Unmark", () => {
    render(<MergeMarkerControl issueId="i1" mergedAt={MARKED} landingShape="git" />);
    fireEvent.click(screen.getByRole("button", { name: "Mark a later merge" }));
    expect(screen.getByText(LATER_BLURB)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: /Where it landed/ }), {
      target: { value: "main" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Commit/ }), {
      target: { value: " 2b2b2b2 " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Mark merged" }));

    expect(mark).toHaveBeenCalledWith({ target: "main", commit: "2b2b2b2" }, expect.anything());
    expect(unmark).not.toHaveBeenCalled();
  });

  it("sends no commit where Commit is left empty, so the newest merged pull request is read", () => {
    render(<MergeMarkerControl issueId="i1" mergedAt={MARKED} landingShape="git" />);
    fireEvent.click(screen.getByRole("button", { name: "Mark a later merge" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Where it landed/ }), {
      target: { value: "main" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Mark merged" }));
    expect(mark).toHaveBeenCalledWith({ target: "main" }, expect.anything());
  });

  it("offers only Unmark where the work lands outside git", () => {
    render(<MergeMarkerControl issueId="i1" mergedAt={MARKED} landingShape="outside_git" />);
    expect(screen.queryByRole("button", { name: "Mark a later merge" })).toBeNull();
    expect(screen.getByRole("button", { name: "Unmark" })).toBeInTheDocument();
  });

  // ISS-1421 r8, criterion 127: the empty-Commit line showed where no pull request was held.
  it("says an empty Commit uses the newest merged pull request only where one is held at another commit", () => {
    const A = "a".repeat(40);
    const B = "b".repeat(40);
    const opened = (props: { mergedCommitSha?: string | null; newestMergedPull?: string | null }) => {
      const view = render(
        <MergeMarkerControl issueId="i1" mergedAt={MARKED} landingShape="git" {...props} />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Mark a later merge" }));
      const said = screen.queryByText(EMPTY_COMMIT_LINE, { exact: false }) !== null;
      view.unmount();
      return said;
    };
    expect(opened({ mergedCommitSha: A, newestMergedPull: B })).toBe(true);
    expect(opened({ mergedCommitSha: A, newestMergedPull: null })).toBe(false);
    expect(opened({ mergedCommitSha: A, newestMergedPull: A })).toBe(false);
    expect(opened({ mergedCommitSha: A })).toBe(false);
  });

  it("introduces the later merge in at most three sentences of at most 25 words", () => {
    const sentences = `${LATER_BLURB} ${EMPTY_COMMIT_LINE}`.trim().split(/(?<=\.)\s+/);
    expect(sentences.length).toBeLessThanOrEqual(3);
    for (const sentence of sentences) {
      expect(sentence).toMatch(/^[A-Z].*\.$/);
      expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(25);
    }
  });
});

describe("MergeMarkerControl on a project whose work lands outside git (ISS-1327)", () => {
  const open = () => {
    render(
      <MergeMarkerControl
        issueId="i1"
        mergedAt={null}
        landingShape="outside_git"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark merged" }));
  };
  const submit = () => {
    const buttons = screen.getAllByRole("button", { name: "Mark merged" });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
  };

  it("asks where the work landed, as a URL, a CMS entry or a storefront resource", () => {
    open();
    expect(screen.getByText(/the live URL, the CMS entry or the storefront resource\./)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/https:\/\/shop\.example\.com/)).toHaveValue("");
  });

  it("sends the answer as the landing, and no branch target", () => {
    open();
    fireEvent.change(screen.getByPlaceholderText(/https:\/\/shop\.example\.com/), {
      target: { value: "  https://mowmentbrand.com/products/linen-tee  " },
    });
    submit();
    expect(mark).toHaveBeenCalledWith(
      { landing: "https://mowmentbrand.com/products/linen-tee" },
      expect.anything(),
    );
  });

  it("closes the form once the mark is answered", () => {
    mark.mockImplementation((_body, options) => options?.onSuccess?.());
    open();
    fireEvent.change(screen.getByPlaceholderText(/https:\/\/shop\.example\.com/), {
      target: { value: "https://mowmentbrand.com/products/linen-tee" },
    });
    submit();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a refused mark's form open, with what was typed and the refusal in it", () => {
    const typed = "https://mowmentbrand.com/products/linen-tee";
    mark.mockImplementation((_body, options) =>
      options?.onError?.(
        new ApiError(422, "core sentence", "MARK_ALREADY_STANDS", {
          heldLanding: "https://mowmentbrand.com/prodcts/linen-tee",
        }),
      ),
    );
    open();
    fireEvent.change(screen.getByPlaceholderText(/https:\/\/shop\.example\.com/), {
      target: { value: typed },
    });
    submit();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/https:\/\/shop\.example\.com/)).toHaveValue(typed);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("https://mowmentbrand.com/prodcts/linen-tee");
    expect(alert).toHaveTextContent("press Unmark");
  });

  it("shows a refusal's quoted reason on a line of its own, never after a literal '> ' (ISS-1421 r8)", () => {
    const ours = "Commit 1a1a1a1 is not ISS-1's landing, because its subject does not name ISS-1.";
    mark.mockImplementation((_body, options) =>
      options?.onError?.(new ApiError(422, `${ours}\n> fix(core): something else (ISS-77)`, "COMMIT_NOT_THIS_ISSUE")),
    );
    open();
    fireEvent.change(screen.getByPlaceholderText(/https:\/\/shop\.example\.com/), {
      target: { value: "https://shop.example.com/a" },
    });
    submit();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(`${ours}\nfix(core): something else (ISS-77)`);
    expect(alert.className).toContain("whitespace-pre-line");
  });

  it("shows the host's own line under the reason as it said it, with no quote marks or code ticks (ISS-1421 r9)", () => {
    const ours = "Forge could not check commit 1a1a1a1 against the repository.";
    const reason = "The git host refused this project's deploy key. It is under the project's Settings → Runners → Git access.";
    mark.mockImplementation((_body, options) =>
      options?.onError?.(
        new ApiError(422, `${ours}\n> ${reason}\n>\n> \`git@github.com: Permission denied (publickey).\``, "COMMIT_UNREADABLE"),
      ),
    );
    open();
    fireEvent.change(screen.getByPlaceholderText(/https:\/\/shop\.example\.com/), {
      target: { value: "https://shop.example.com/a" },
    });
    submit();
    expect(screen.getByRole("alert").textContent).toBe(
      `${ours}\n${reason}\ngit@github.com: Permission denied (publickey).`,
    );
  });

  it("keeps a landing past 2000 characters whole, says the limit, and will not send it", () => {
    open();
    const long = `https://shop.example.com/${"x".repeat(2000)}`;
    fireEvent.change(screen.getByPlaceholderText(/https:\/\/shop\.example\.com/), {
      target: { value: long },
    });
    expect(screen.getByPlaceholderText(/https:\/\/shop\.example\.com/)).toHaveValue(long);
    expect(screen.getByRole("alert")).toHaveTextContent("At most 2000 characters");
    const buttons = screen.getAllByRole("button", { name: "Mark merged" });
    expect(buttons[buttons.length - 1]).toBeDisabled();
    submit();
    expect(mark).not.toHaveBeenCalled();
  });

  it("will not send a mark that names no landing", () => {
    open();
    const buttons = screen.getAllByRole("button", { name: "Mark merged" });
    expect(buttons[buttons.length - 1]).toBeDisabled();
  });
});

describe("MergeMarkerControl on a project that lands in git keeps its form", () => {
  it("sends the branch it was given as the target, and no landing", () => {
    render(
      <MergeMarkerControl issueId="i1" mergedAt={null} landingShape="git" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark merged" }));
    expect(screen.getByPlaceholderText(/branch or PR/)).toHaveValue("");
    fireEvent.change(screen.getByPlaceholderText(/branch or PR/), { target: { value: "main" } });
    const buttons = screen.getAllByRole("button", { name: "Mark merged" });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    expect(mark).toHaveBeenCalledWith({ target: "main" }, expect.anything());
  });

  it("explains the claim in the words it always had, never the landing's", () => {
    render(
      <MergeMarkerControl issueId="i1" mergedAt={null} landingShape="git" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark merged" }));
    expect(screen.getByText(BLURB)).toBeInTheDocument();
    expect(screen.queryByText(/lands outside git/)).toBeNull();
  });

  it.each(["git", "outside_git"] as const)("shows no literal backtick in the panel of an issue landing %s", (landingShape) => {
    render(
      <MergeMarkerControl issueId="i1" mergedAt={null} landingShape={landingShape} landingSource="project" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark merged" }));
    const panel = screen.getByRole("dialog");
    expect(panel.textContent).not.toContain("`");
    if (landingShape === "git") expect(panel).toHaveTextContent(/which a close needs/);
  });

  it("takes a target past 200 characters whole, as it did before", () => {
    render(
      <MergeMarkerControl issueId="i1" mergedAt={null} landingShape="git" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark merged" }));
    const long = `feature/${"y".repeat(240)}`;
    fireEvent.change(screen.getByPlaceholderText(/branch or PR/), { target: { value: long } });
    expect(screen.getByPlaceholderText(/branch or PR/)).toHaveValue(long);
    const buttons = screen.getAllByRole("button", { name: "Mark merged" });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    expect(mark).toHaveBeenCalledWith({ target: long }, expect.anything());
  });
});

describe("MergeMarkerControl names whose answer the lane is", () => {
  const openWith = (props: { landingShape: "git" | "outside_git"; landingSource?: "issue" | "project" }) => {
    render(<MergeMarkerControl issueId="i1" mergedAt={null} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark merged" }));
    return screen.getByTestId("landing-line");
  };

  it("says an issue that declares its own shape lands where it declares, and that the issue says so", () => {
    const line = openWith({ landingShape: "outside_git", landingSource: "issue" });
    expect(line).toHaveTextContent("This issue's work lands outside git: the issue declares it itself, under Work lands.");
    expect(screen.queryByText(/This project's work lands/)).toBeNull();
  });

  it("says an issue in git by its own declaration is in git, on a project whose shape may differ", () => {
    expect(openWith({ landingShape: "git", landingSource: "issue" })).toHaveTextContent(
      "This issue's work lands in git: the issue declares it itself, under Work lands.",
    );
  });

  it("says an issue with no declaration of its own follows its project's shape", () => {
    expect(openWith({ landingShape: "outside_git", landingSource: "project" })).toHaveTextContent(
      "This issue's work lands outside git: that is its project's shape.",
    );
  });

  it("names no source where the server did not say whose answer it is", () => {
    expect(openWith({ landingShape: "outside_git" })).toHaveTextContent(/^This issue's work lands outside git\.$/);
  });
});

// ISS-1421 r5 repair 1: the panel opened on seven lines of reasoning ("not a date field … a state
// nothing here can hold"). It says what the mark does and how it is undone, in short sentences.
describe("the Mark merged panel's introduction", () => {
  it.each([
    ["git", BLURB],
    ["outside_git", LANDING_BLURB],
  ] as const)("on an issue landing %s is at most three plain sentences of at most 25 words", (_shape, text) => {
    const sentences = text.trim().split(/(?<=\.)\s+/);
    expect(sentences.length).toBeLessThanOrEqual(3);
    for (const sentence of sentences) {
      expect(sentence).toMatch(/^[A-Z]/);
      expect(sentence).toMatch(/\.$/);
      expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(25);
    }
    expect(text).toMatch(/which a close needs/);
    expect(text).toMatch(/Unmark takes it back, unless the issue is closed\./);
    expect(text).not.toMatch(/date field|nothing here can hold|—/);
  });

  // ISS-1421 r6, criterion 95: the banner beside the panel says "not shipped yet", so the panel
  // must not say the mark says the work shipped.
  it.each([
    ["git", BLURB],
    ["outside_git", LANDING_BLURB],
  ] as const)("on an issue landing %s says the mark records where the work landed, never that it shipped", (_shape, text) => {
    expect(text).toMatch(/Marking merged records/);
    expect(text).not.toMatch(/shipped/);
  });
});
