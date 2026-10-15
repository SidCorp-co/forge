import { describe, expect, it } from "vitest";
import { HELP_DOCS } from "./help-content.generated";
import { matchExcerpt, plainText, searchDocs, splitAtMatch, titleParts } from "./reader";

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

  it("matches a title on the words it shows, its code marks left out", () => {
    const docs = [page("Gates", "Conformance gates & pnpm verify are listed."), page("Conformance gates & `pnpm verify`", "body")];
    expect(searchDocs(docs, "gates & pnpm")?.map((d) => d.title)).toEqual(["Conformance gates & `pnpm verify`", "Gates"]);
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

  it("never rebuilds a tag out of what dropping markup leaves behind", () => {
    const shown = (line: string) => {
      const e = matchExcerpt(page("T", line), "run");
      return `${e?.before}${e?.match}${e?.after}`;
    };
    const planted = [
      "run <`script` here",
      "run <**script here",
      "run <[](x)script here",
      "run <`script`>alert(1)",
      "run <<b>script>",
      "run <b>x</b><script",
      "run <scr<i>ipt>",
    ];
    expect(planted.filter((line) => /<[A-Za-z/!?]/.test(shown(line))).map((line) => `${line} → ${shown(line)}`)).toEqual([]);
  });

  it("drops a whole tag and keeps a code span's text, angle brackets included", () => {
    const e = matchExcerpt(page("T", "Run <kbd>Enter</kbd> in place of `<your-forge-host>` and a < b."), "run");
    expect(`${e?.match}${e?.after}`).toBe("Run Enter in place of <your-forge-host> and a < b.");
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

  const conformance = page(
    "Conformance gates & `pnpm verify`",
    "## Conformance gates & `pnpm verify`\n\nA repo may carry gates, and `pnpm verify` is the entrypoint.\n\n### When to run it\n\nBefore you push.",
  );

  it("passes over a heading repeating a title that carries code marks", () => {
    expect(matchExcerpt(conformance, "pnpm verify")).toEqual({
      heading: null,
      before: "A repo may carry gates, and ",
      match: "pnpm verify",
      after: " is the entrypoint.",
    });
    expect(matchExcerpt(conformance, "the")).toMatchObject({ heading: null, match: "the" });
    expect(matchExcerpt(conformance, "push")).toMatchObject({ heading: "When to run it" });
  });

  it("shows no line where the only other place the words appear is a heading repeating the title", () => {
    expect(matchExcerpt(conformance, "Conformance gates &")).toBeNull();
  });

  const gettingStarted = page(
    "Getting started",
    "# Getting started with Forge\n\nForge runs your work as an automated pipeline.\n\n## The four pieces\n\nA runner on your machine.",
  );

  it("never names the page's own top heading as a section, though it is not the title word for word", () => {
    expect(matchExcerpt(gettingStarted, "pipeline")).toEqual({
      heading: null,
      before: "Forge runs your work as an automated ",
      match: "pipeline",
      after: ".",
    });
    expect(matchExcerpt(gettingStarted, "runner")).toMatchObject({ heading: "The four pieces" });
  });

  it("reads the page's own top heading as a match only where the title does not already hold the words", () => {
    expect(matchExcerpt(gettingStarted, "getting")).toBeNull();
    expect(matchExcerpt(gettingStarted, "with forge")).toEqual({
      heading: null,
      before: "Getting started ",
      match: "with Forge",
      after: "",
    });
  });

  it("keeps a code line as written, angle brackets and all", () => {
    const body = "## Baselines\n\n```sh\nnode scripts/check-<axis>.mjs --update-baseline\n```";
    expect(matchExcerpt(page("T", body), "update-baseline")).toEqual({
      heading: "Baselines",
      before: "node scripts/check-<axis>.mjs --",
      match: "update-baseline",
      after: "",
    });
  });

  it("reads a paragraph the source wraps as one, so the line starts where its sentence does", () => {
    const body = "Reused by a *different*\nagent on an issue — a convention\nworth keeping.\n\nNext paragraph.";
    expect(matchExcerpt(page("T", body), "issue")).toEqual({
      heading: null,
      before: "Reused by a different agent on an ",
      match: "issue",
      after: " — a convention worth keeping.",
    });
    expect(matchExcerpt(page("T", body), "different agent")?.match).toBe("different agent");
  });

  it("reads each list item, with its wrapped lines, apart from the next", () => {
    const body = "- First item that\n  wraps here.\n- Second item.";
    expect(matchExcerpt(page("T", body), "wraps")).toMatchObject({ before: "First item that ", after: " here." });
    expect(matchExcerpt(page("T", body), "second")).toMatchObject({ before: "", after: " item." });
  });

  it("reads a table row with its cells set apart, and passes over the row that only rules the table", () => {
    const body = "| Header | What goes in it |\n|---|:---:|\n| `Auth` | `Bearer`, then your token |";
    expect(matchExcerpt(page("T", body), "token")).toMatchObject({ before: "Auth · Bearer, then your " });
    expect(matchExcerpt(page("T", body), "---")).toMatchObject({ before: "|", match: "---" });
  });

  it("starts and ends a cut table row on a cell's words, never on the mark between two cells", () => {
    const runner = HELP_DOCS.find((d) => d.title === "Pair a runner");
    expect(matchExcerpt(runner!, "status")).toMatchObject({ before: "…Is the agent running (forge-runner " });
    const long = "x".repeat(60);
    const row = `| ${long} | the token | ${"y".repeat(150)} |`;
    const cut = matchExcerpt(page("T", row), "token");
    expect(cut?.before).toBe("…the ");
    const tailRow = `| the token ${"z ".repeat(57)}| ${"w".repeat(80)} |`;
    expect(matchExcerpt(page("T", tailRow), "token")?.after).not.toMatch(/·\s*…$/);
  });

  it("drops emphasis marks and keeps an asterisk or underscore that marks nothing", () => {
    const shown = (line: string, q: string) => {
      const e = matchExcerpt(page("T", line), q);
      return `${e?.before}${e?.match}${e?.after}`;
    };
    expect(shown("a *different* agent and _another_ one", "agent")).toBe("a different agent and another one");
    expect(shown("2 * 3 = 6 for some_name", "6")).toBe("2 * 3 = 6 for some_name");
  });
});

describe("a title as a reader sees it", () => {
  it("leaves its code marks out of the plain form", () => {
    expect(plainText("Conformance gates & `pnpm verify`")).toBe("Conformance gates & pnpm verify");
    expect(plainText("Read an issue's status")).toBe("Read an issue's status");
  });

  it("splits it into prose and code, the words asked for marked across both", () => {
    expect(titleParts("Conformance gates & `pnpm verify`", "gates & pnpm")).toEqual([
      { text: "Conformance ", code: false, marked: false },
      { text: "gates & ", code: false, marked: true },
      { text: "pnpm", code: true, marked: true },
      { text: " verify", code: true, marked: false },
    ]);
    expect(titleParts("Pair a runner", "")).toEqual([{ text: "Pair a runner", code: false, marked: false }]);
  });
});
