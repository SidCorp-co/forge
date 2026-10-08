import { describe, expect, it } from "vitest";
import { CONVERSATION_ATTACHMENTS, refusalSentence, SESSION_ATTACHMENTS, stageFiles } from "./attachments";

const MB = 1024 * 1024;

function file(name: string, type: string, size = 64): File {
  const f = new File(["x"], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

describe("what a conversation's composer stages", () => {
  it("takes a markdown spec, the file a BA was refused on dev", () => {
    const out = stageFiles([file("hop-parity-crmhp-spec.md", "text/markdown")], CONVERSATION_ATTACHMENTS, 0);
    expect(out.refused).toEqual([]);
    expect(out.accepted.map((f) => f.name)).toEqual(["hop-parity-crmhp-spec.md"]);
  });

  it("takes plain text, CSV, JSON, PDF and Word documents", () => {
    const picked = [
      file("notes.txt", "text/plain"),
      file("criteria.csv", "text/csv"),
      file("export.json", "application/json"),
      file("audit.pdf", "application/pdf"),
      file("brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ];
    expect(stageFiles(picked, CONVERSATION_ATTACHMENTS, 0).accepted).toHaveLength(5);
  });

  it("takes a .md the browser named no type for, and a Windows .csv named as Excel", () => {
    const out = stageFiles(
      [file("spec.md", ""), file("criteria.csv", "application/vnd.ms-excel")],
      CONVERSATION_ATTACHMENTS,
      0,
    );
    expect(out.refused).toEqual([]);
    expect(out.accepted).toHaveLength(2);
  });

  it("refuses a markdown file over its cap, naming the type, the cap and every type it takes", () => {
    const out = stageFiles([file("big.md", "text/markdown", 3 * MB)], CONVERSATION_ATTACHMENTS, 0);
    expect(out.accepted).toEqual([]);
    expect(refusalSentence(out.refused[0] ?? { name: "", reason: "" })).toBe(
      "Couldn't attach big.md — it is 3.0 MB of text/markdown, and a conversation takes text/markdown up to 2 MB — attach .png, .jpg, .jpeg, .gif, .webp, .pdf or .docx up to 10 MB; .md, .markdown, .txt, .csv or .json up to 2 MB.",
    );
  });

  it("refuses a type it does not take, naming every type it does", () => {
    const out = stageFiles([file("tool.exe", "application/x-msdownload")], CONVERSATION_ATTACHMENTS, 0);
    expect(out.refused[0]?.reason).toBe(
      "application/x-msdownload is not a type a conversation takes — attach .png, .jpg, .jpeg, .gif, .webp, .pdf or .docx up to 10 MB; .md, .markdown, .txt, .csv or .json up to 2 MB",
    );
  });

  it("keeps a session's one cap for every type it takes", () => {
    const out = stageFiles([file("big.md", "text/markdown", 11 * MB)], SESSION_ATTACHMENTS, 0);
    expect(out.refused[0]?.reason).toBe("it is 11.0 MB and a session takes files up to 10.0 MB");
  });
});
