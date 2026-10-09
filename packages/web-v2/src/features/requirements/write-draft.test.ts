import { afterEach, describe, expect, it, vi } from "vitest";
import { requirementsApi } from "./api";

// FB-83: a draft save rewrites the revision whole, so what the editor does not change goes back as held
describe("saving a draft from its editor", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the revision's reason, change summary, language and each kept criterion's form", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)));
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );

    await requirementsApi.writeDraft(
      "p1",
      "REQ-7",
      {
        revision: 2,
        spec: {},
        reason: "Owner asked for exports",
        changeSummary: "Adds the sheet export",
        writtenLang: "vi",
        criteria: [
          { id: "c1", code: "BC-1", body: "Given a board, when exported, then a sheet downloads.", form: "scenario", sinceRevision: 1, retiredRevision: null },
        ],
      },
      { tldr: "Export a board", criteria: ["Given a board, when exported, then a sheet downloads.", "The sheet names each column."] },
    );

    expect(sent[0]).toEqual({
      reason: "Owner asked for exports",
      spec: {},
      tldr: "Export a board",
      changeSummary: "Adds the sheet export",
      writtenLang: "vi",
      criteria: [
        { code: "BC-1", body: "Given a board, when exported, then a sheet downloads.", form: "scenario" },
        { body: "The sheet names each column." },
      ],
    });
  });
});
