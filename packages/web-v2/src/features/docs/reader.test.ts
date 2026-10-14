import { describe, expect, it } from "vitest";
import { HELP_DOCS } from "./help-content.generated";
import { matchExcerpt, searchDocs, splitAtMatch } from "./reader";

const page = (title: string, body: string, summary: string | null = null) => ({ title, body, summary });

describe("the order of search results", () => {
  it("puts every page whose title holds the words ahead of every page that only mentions them", () => {
    const docs = [
      page("What you can ask", "Ask for an issue's status."),
      page("Pair a runner", "Nothing here."),
      page("Read an issue's status", "The badge."),
      page("Tell when an issue is done", "Its status reads closed."),
      page("Status colours", "Each colour."),
    ];
    expect(searchDocs(docs, "status")?.map((d) => d.title)).toEqual([
      "Read an issue's status",
      "Status colours",
      "What you can ask",
      "Tell when an issue is done",
    ]);
  });

  it("puts the help page named for an issue's status first for the placeholder's own word", () => {
    const titles = (searchDocs(HELP_DOCS, "status") ?? []).map((d) => d.title);
    expect(titles[0]).toBe("Read an issue's status");
    const firstWithout = titles.findIndex((t) => !t.toLowerCase().includes("status"));
    expect(titles.slice(firstWithout).every((t) => !t.toLowerCase().includes("status"))).toBe(true);
  });

  it("finds a page by its summary alone, and answers null for a blank query", () => {
    expect(searchDocs([page("A", "b", "the summary word")], "summary word")).toHaveLength(1);
    expect(searchDocs([page("A", "b")], "  ")).toBeNull();
    expect(searchDocs([page("A", "b")], "absent")).toEqual([]);
  });
});

describe("where a page matched", () => {
  it("cuts a text at its first match, keeping the text's own case", () => {
    expect(splitAtMatch("Run it in the Foreground, then again in the foreground", "foreground")).toEqual({
      before: "Run it in the ",
      match: "Foreground",
      after: ", then again in the foreground",
    });
    expect(splitAtMatch("nothing", "absent")).toBeNull();
    expect(splitAtMatch("anything", " ")).toBeNull();
  });

  it("names the heading the first matching line sits under, and the words around it as a reader sees them", () => {
    const body = "# Pair a runner\n\nIntro.\n\n## Keep it running\n\nRun **forge-runner** in the `foreground` once.";
    expect(matchExcerpt(page("Pair a runner", body), "foreground")).toEqual({
      heading: "Keep it running",
      before: "Run forge-runner in the ",
      match: "foreground",
      after: " once.",
    });
  });

  it("passes over a heading that repeats the page's title, as neither the match nor the place", () => {
    const body = "# Read an issue's status\n\nEach issue has a status.";
    expect(matchExcerpt(page("Read an issue's status", body), "status")).toEqual({
      heading: null,
      before: "Each issue has a ",
      match: "status",
      after: ".",
    });
  });

  it("drops code marks without leaving a space where they were", () => {
    expect(matchExcerpt(page("T", "Is it running (`forge-runner status`)?"), "status")?.before).toBe(
      "Is it running (forge-runner ",
    );
  });

  it("names no heading where the match is the heading itself", () => {
    expect(matchExcerpt(page("T", "## The foreground mode\n\ntext"), "foreground")).toEqual({
      heading: null,
      before: "The ",
      match: "foreground",
      after: " mode",
    });
  });

  it("reads a link's words, a list item's and a quoted line's without their markup", () => {
    const excerpt = (line: string) => matchExcerpt(page("T", line), "runner");
    expect(excerpt("- See [Pair a runner](/guides?path=pair-a-runner) first")?.before).toBe("See Pair a ");
    expect(excerpt("> A runner is a box")?.before).toBe("A ");
    expect(excerpt("1. Start the runner")?.before).toBe("Start the ");
  });

  it("shows a line as written where the words are only in its markup, such as a link's address", () => {
    expect(matchExcerpt(page("T", "Read [the guide](/guides/dispatch-a-wave)."), "dispatch-a")).toEqual({
      heading: null,
      before: "Read [the guide](/guides/",
      match: "dispatch-a",
      after: "-wave).",
    });
  });

  it("keeps the heading above a fenced block a match sits in, and reads no heading inside the fence", () => {
    const body = "## Install\n\n```sh\n# not a heading\nforge-runner pair --foreground\n```";
    expect(matchExcerpt(page("T", body), "foreground")?.heading).toBe("Install");
  });

  it("shows a fence's opening line where only its language marker holds the words", () => {
    const body = "## Install\n\n```sh\nforge-runner pair\n```";
    expect(matchExcerpt(page("T", body), "sh")).toEqual({ heading: "Install", before: "```", match: "sh", after: "" });
  });

  it("falls back to the summary, and says nothing where only the title holds the words", () => {
    expect(matchExcerpt(page("T", "body", "Blocks edges gate dispatch."), "edges")).toEqual({
      heading: null,
      before: "Blocks ",
      match: "edges",
      after: " gate dispatch.",
    });
    expect(matchExcerpt(page("Foreground", "body"), "foreground")).toBeNull();
  });

  it("trims a long line to whole words either side of the match, saying where it cut", () => {
    const line = `${"lead ".repeat(30)}target ${"tail ".repeat(60)}`;
    const e = matchExcerpt(page("T", line), "target");
    expect(e?.before.startsWith("…lead")).toBe(true);
    expect(e?.before.length).toBeLessThanOrEqual(41);
    expect(e?.after.endsWith("tail…")).toBe(true);
    expect(e?.after.length).toBeLessThanOrEqual(121);
  });
});
