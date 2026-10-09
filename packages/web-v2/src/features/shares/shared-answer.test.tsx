import type { ShareSnapshot } from "@forge/contracts/shares";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { doneDayText } from "@/lib/i18n/eta-clock-words";
import { fakeCore, renderWithQuery } from "@/test/render";
import { SharedAnswer, SharedAnswerView } from "./components/shared-answer";

// The page a share link opens draws the frozen answer as text and nothing else: no link into the
// project, no markup parsed, an unknown block named rather than dropped, and the token sent only in
// a request body.

const TOKEN = `forge_share_${"x".repeat(43)}`;

function snapshot(audience: "members" | "link" = "link"): ShareSnapshot {
  const frame = {
    fields: [
      { name: "requirement", type: "ref" as const, label: "Requirement" },
      { name: "note", type: "string" as const, label: "Note" },
      { name: "proven", type: "number" as const, label: "Proven" },
    ],
    rows: [{ requirement: "REQ-7", note: "[click](https://evil.example) <b>bold</b>", proven: 5 }],
  };
  return {
    audience,
    expiresAt: "2026-10-15T09:00:00.000Z",
    document: {
      templateId: "progress",
      version: 1,
      params: {},
      runs: [
        {
          runId: "run-1",
          queryId: "progress-by-requirement",
          version: 1,
          params: {},
          projectId: "p1",
          actor: { kind: "human", id: "u1" },
          asOf: "2026-10-08T09:00:00.000Z",
          frame,
        },
      ],
      blocks: [
        { kind: "table", v: 1, title: "Progress", columns: ["requirement", "note", "proven"], source: { runId: "run-1" }, frame },
      ],
      narrative: { summary: "One requirement moved.", risks: "", recommendations: "Prove REQ-7." },
    },
  };
}

describe("a shared answer", () => {
  it("draws a table and a chart through the registry, each with its text alternative and source", () => {
    const s = snapshot();
    const frame = s.document.runs.flatMap((r) => r.frame)[0];
    s.document.blocks.push({
      kind: "chart", v: 1, title: "Proven", variant: "bar", x: "requirement", y: ["proven"], source: { runId: "run-1" }, frame,
    } as never);
    const { container } = renderWithQuery(<SharedAnswerView snapshot={s} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^Progress$/);
    expect(screen.getByText("One requirement moved.")).toBeInTheDocument();
    expect(screen.queryByText("Risks")).toBeNull();
    expect(container.querySelector('[data-testid="visual-block"][data-kind="table"] table')).not.toBeNull();
    expect(container.querySelector('[data-testid="visual-block"][data-kind="chart"]')).not.toBeNull();
    expect(container.querySelector('[data-kind="chart"] [data-testid="visual-block-alt"]')).not.toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    const sources = screen.getAllByTestId("visual-block-source");
    expect(sources).toHaveLength(2);
    expect(sources[0]).toHaveTextContent("progress-by-requirement");
    expect(sources[0]?.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-08T09:00:00.000Z");
    expect(container.querySelectorAll("b")).toHaveLength(0);
  });

  it("draws a reference as its key and never as a link", () => {
    const { container } = renderWithQuery(<SharedAnswerView snapshot={snapshot()} />);
    expect(screen.getByText("REQ-7")).toBeInTheDocument();
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });

  it("names a block whose kind this build cannot show, rather than dropping it", () => {
    const s = snapshot();
    s.document.blocks = [{ kind: "pie" } as never];
    renderWithQuery(<SharedAnswerView snapshot={s} />);
    expect(screen.getByTestId("visual-block-unsupported")).toHaveTextContent("This answer has a pie block this screen cannot show.");
  });

  it("shows a shared turn whole: its question as the title, its reply as Markdown, then its three blocks in order", () => {
    const s = snapshot();
    const frame = s.document.runs[0]?.frame as ShareSnapshot["document"]["runs"][number]["frame"];
    const source = { runId: "run-1" };
    s.document = {
      ...s.document,
      templateId: "chat-answer",
      version: 2,
      title: "How far along is the project, and what ships next?",
      reply: "## Summary\n\n**REQ-7** is closest. See [the board](https://forge.example/projects/p1/requirements).",
      narrative: { summary: "", risks: "", recommendations: "" },
      blocks: [
        { kind: "table", v: 1, title: "Progress", columns: ["requirement", "proven"], source, frame },
        { kind: "table", v: 1, title: "Notes", columns: ["requirement", "note"], source, frame },
        { kind: "chart", v: 1, title: "Proven", variant: "bar", x: "requirement", y: ["proven"], source, frame },
      ] as never,
    };
    const { container } = renderWithQuery(<SharedAnswerView snapshot={s} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("How far along is the project, and what ships next?");
    expect(container.textContent).not.toContain("chat-answer");
    const reply = screen.getByTestId("shared-reply");
    expect(reply.querySelector("h2")).toHaveTextContent("Summary");
    expect(reply.querySelector("strong")).toHaveTextContent("REQ-7");
    expect(reply).toHaveTextContent("See the board.");
    expect(container.querySelectorAll("a")).toHaveLength(0);
    const kinds = [...container.querySelectorAll('[data-testid="visual-block"]')].map((b) => b.getAttribute("data-kind"));
    expect(kinds).toEqual(["table", "table", "chart"]);
    expect([...container.querySelectorAll('[data-testid="visual-block"]')].map((b) => b.textContent?.slice(0, 5))).toEqual([
      "Progr",
      "Notes",
      "Prove",
    ]);
    expect(reply.compareDocumentPosition(container.querySelector('[data-testid="visual-block"]') as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("reads every instant on the page in the viewer's timezone as chat does, never as the stored UTC text (REQ-32 BC-4, BC-17)", () => {
    const s = snapshot();
    s.document = {
      ...s.document,
      templateId: "chat-answer",
      reply: "The report was read at 2026-10-09 01:03 UTC and the next one is due 2026-10-10T19:27:00.000Z.",
      narrative: { summary: "", risks: "", recommendations: "" },
    };
    const { container } = renderWithQuery(<SharedAnswerView snapshot={s} />);
    expect(container.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(container.textContent).not.toContain("UTC");
    expect(screen.getByTestId("shared-reply").textContent).toContain(doneDayText("2026-10-09T01:03:00Z", { lang: "en", now: Date.now() }));
  });

  it("shows the settings of a run in its source, from the frozen run", () => {
    const s = snapshot();
    (s.document.runs[0] as { params: Record<string, unknown> }).params = { windowDays: 30 };
    renderWithQuery(<SharedAnswerView snapshot={s} />);
    fireEvent.click(screen.getByTestId("visual-block-source-toggle"));
    expect(screen.getByTestId("visual-block-settings")).toHaveTextContent("Settings: window days 30");
  });

  it("names a chat answer shared before it carried its question a shared answer, never by its template id", () => {
    const s = snapshot();
    s.document = { ...s.document, templateId: "chat-answer", narrative: { summary: "", risks: "", recommendations: "" } };
    const { container } = renderWithQuery(<SharedAnswerView snapshot={s} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^Shared answer$/);
    expect(container.textContent).not.toContain("chat-answer");
  });

  it("opens through the open door with the token in the body, and waits for the session first", async () => {
    const calls = fakeCore((call) =>
      call.path === "/shares/open" ? { body: snapshot() } : undefined,
    );
    const { client, rerender } = renderWithQuery(<SharedAnswer token={TOKEN} signedIn={null} />);
    expect(calls).toHaveLength(0);
    rerender(
      <QueryClientProvider client={client}>
        <SharedAnswer token={TOKEN} signedIn={false} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(/^Progress$/);
    expect(calls).toEqual([{ method: "POST", path: "/shares/open", body: { token: TOKEN } }]);
  });

  it("opens through the member door for a signed-in reader", async () => {
    const calls = fakeCore((call) =>
      call.path === "/shares/open/member" ? { body: snapshot("members") } : undefined,
    );
    renderWithQuery(<SharedAnswer token={TOKEN} signedIn />);
    expect(await screen.findByText("Shared with the project's members", { exact: false })).toBeInTheDocument();
    expect(calls.map((c) => c.path)).toEqual(["/shares/open/member"]);
  });

  it("says plainly when a link is no longer available", async () => {
    fakeCore(() => ({
      status: 404,
      body: { code: "SHARE_NOT_AVAILABLE", message: "not available", error: { code: "SHARE_NOT_AVAILABLE", message: "not available", refusals: [] } },
    }));
    renderWithQuery(<SharedAnswer token={TOKEN} signedIn={false} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("This link is not available.");
  });
});
