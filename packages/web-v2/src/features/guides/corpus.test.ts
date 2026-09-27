import { describe, expect, it, vi } from "vitest";
import { HELP_DOCS } from "@/features/docs/help-content.generated";
import { searchDocs as searchCorpus } from "@/features/docs/reader";
import type { Guide } from "./api";
import { AUDIENCES, DOORS, SEARCH_EXAMPLES } from "./audience";
import {
  buildCorpus,
  docsBehind,
  doorSections,
  fromGuide,
  searchPlaceholder,
  workingExamples,
} from "./corpus";

const GUIDES: Guide[] = [
  { slug: "what-is-an-issue", audience: "agent", title: "What is an issue?", summary: "The four admission gates.", version: 1, body: "## What is an issue?\nAn issue is a unit of work." },
  { slug: "issue-dependencies", audience: "agent", title: "Issue dependencies", summary: "Blocks edges.", version: 1, body: "## Issue dependencies\nOnly a blocks edge gates dispatch." },
];

const corpus = buildCorpus(HELP_DOCS, GUIDES);

describe("the public corpus", () => {
  it("holds every help page and every core guide, once each", () => {
    expect(corpus).toHaveLength(HELP_DOCS.length + GUIDES.length);
    expect(new Set(corpus.map((d) => d.href)).size).toBe(corpus.length);
  });

  it("puts each help page behind the door its front-matter names, at its own /guides?path= address", () => {
    for (const help of HELP_DOCS) {
      const doc = corpus.find((d) => d.href === `/guides?path=${encodeURIComponent(help.slug)}`);
      expect(doc?.audience, help.slug).toBe(help.audience);
      expect(doc?.markdownUrl).toBeNull();
    }
  });

  it("puts every core guide behind the agent door at /guides/<slug>, with its markdown address", () => {
    const agents = docsBehind(corpus, "agent");
    expect(agents.map((d) => d.href)).toEqual(["/guides/what-is-an-issue", "/guides/issue-dependencies"]);
    expect(agents.map((d) => d.markdownUrl)).toEqual([
      expect.stringMatching(/\/api\/guides\/what-is-an-issue\.md$/),
      expect.stringMatching(/\/api\/guides\/issue-dependencies\.md$/),
    ]);
  });

  it("lists behind each door only that door's pages, and every one of them", () => {
    for (const audience of AUDIENCES) {
      const behind = docsBehind(corpus, audience);
      expect(behind.length, audience).toBeGreaterThan(0);
      expect(behind.every((d) => d.audience === audience)).toBe(true);
      const sectioned = doorSections(corpus, audience).flatMap((s) => s.docs);
      expect(sectioned.map((d) => d.href).sort()).toEqual(behind.map((d) => d.href).sort());
    }
  });

  it("groups the user door by the sections /docs uses, in the same order", () => {
    expect(doorSections(corpus, "user").map((s) => s.name)).toEqual([
      "Getting started",
      "Guides",
      "Reference",
      "Troubleshooting",
    ]);
  });
});

describe("search over the public corpus", () => {
  it("finds a page of every audience", () => {
    const hits = (q: string) => (searchCorpus(corpus, q) ?? []).map((d) => d.audience);
    expect(hits("pair a runner")).toContain("user");
    expect(hits("claude desktop")).toContain("assistant-setup");
    expect(hits("blocks edge gates dispatch")).toContain("agent");
  });

  it("reads the body, not only the title", () => {
    const hit = searchCorpus(corpus, "unit of work") ?? [];
    expect(hit.map((d) => d.slug)).toEqual(["what-is-an-issue"]);
  });

  it("answers null for an empty query, so the page list shows instead of 'No matches'", () => {
    expect(searchCorpus(corpus, "   ")).toBeNull();
  });
});

describe("the search placeholder", () => {
  it("names one example per door, each finding a page behind its own door", () => {
    expect(workingExamples(corpus)).toEqual(SEARCH_EXAMPLES);
    const placeholder = searchPlaceholder(corpus);
    for (const { term } of SEARCH_EXAMPLES) expect(placeholder).toContain(`“${term}”`);
    expect(new Set(SEARCH_EXAMPLES.map((e) => e.audience))).toEqual(new Set(AUDIENCES));
  });

  it("leaves out, and says so, an example that finds nothing behind its door", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const withoutDeps = buildCorpus(HELP_DOCS, [GUIDES[0]]);
    const placeholder = searchPlaceholder(withoutDeps);
    expect(placeholder).not.toContain("dependencies");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/"dependencies" finds no page behind the agent door/));
    warn.mockRestore();
  });

  it("labels each door in the reader's own words", () => {
    expect(AUDIENCES.map((a) => DOORS[a].label)).toEqual([
      "I use Forge",
      "I'm connecting an AI assistant",
      "I'm an agent or a script",
    ]);
  });
});

describe("a core guide's audience, as core declares it", () => {
  const guide = (audience?: string): Guide => ({ ...GUIDES[0], audience });

  it("places a guide core declares agent behind the agent door, with nothing on the log", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(fromGuide(guide("agent"), 0).audience).toBe("agent");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("refuses a guide core declares for another reader, naming its slug and the value", () => {
    expect(() => fromGuide(guide("user"), 0)).toThrow(
      /the guide 'what-is-an-issue' with audience 'user'.*only be placed behind the 'agent' door/,
    );
    expect(() => fromGuide(guide("agents"), 0)).toThrow(/audience 'agents'/);
  });

  it("places a guide from a core that declares none as agent, and says so on the log", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(fromGuide(guide(undefined), 0).audience).toBe("agent");
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/'what-is-an-issue' with no audience.*older than ISS-1178; this ends when that core is redeployed/),
    );
    warn.mockRestore();
  });
});
