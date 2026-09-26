import { describe, expect, it } from "vitest";
import {
  acceptAttribute,
  CONVERSATION_ATTACHMENTS,
  formatSize,
  refusalSentence,
  SESSION_ATTACHMENTS,
  stageFiles,
} from "./attachments";

function file(name: string, type: string, size: number): File {
  const f = new File([""], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

const png = () => file("shot.png", "image/png", 4096);

describe("stageFiles — what a conversation takes", () => {
  it("stages an image of a type the conversation takes", () => {
    const out = stageFiles([png()], CONVERSATION_ATTACHMENTS, 0);
    expect(out.accepted).toHaveLength(1);
    expect(out.refused).toEqual([]);
  });

  it("stages nothing for a type it does not take, and names the file and the reason", () => {
    const out = stageFiles(
      [file("spec-conversations.pdf", "application/pdf", 2048)],
      CONVERSATION_ATTACHMENTS,
      0,
    );
    expect(out.accepted).toEqual([]);
    expect(out.refused).toEqual([
      {
        name: "spec-conversations.pdf",
        reason:
          "application/pdf is not a type a conversation takes — attach a PNG, JPEG, GIF or WebP image",
      },
    ]);
  });

  it("refuses the same type a session would have taken, because the target decides", () => {
    const pdf = file("spec.pdf", "application/pdf", 2048);
    expect(stageFiles([pdf], CONVERSATION_ATTACHMENTS, 0).accepted).toEqual([]);
    expect(stageFiles([pdf], SESSION_ATTACHMENTS, 0).accepted).toHaveLength(1);
  });

  it("keeps the files it can and refuses only the ones it cannot", () => {
    const out = stageFiles(
      [png(), file("notes.txt", "text/plain", 12)],
      CONVERSATION_ATTACHMENTS,
      0,
    );
    expect(out.accepted.map((f) => f.name)).toEqual(["shot.png"]);
    expect(out.refused.map((r) => r.name)).toEqual(["notes.txt"]);
  });
});

describe("stageFiles — the boundaries", () => {
  it("takes a file exactly at the byte cap", () => {
    const at = file("big.png", "image/png", CONVERSATION_ATTACHMENTS.maxBytes);
    expect(stageFiles([at], CONVERSATION_ATTACHMENTS, 0).accepted).toHaveLength(1);
  });

  it("refuses one byte over it, naming both sizes", () => {
    const over = file("big.png", "image/png", CONVERSATION_ATTACHMENTS.maxBytes + 1);
    const [refusal] = stageFiles([over], CONVERSATION_ATTACHMENTS, 0).refused;
    expect(refusal?.reason).toBe(
      "it is 10.0 MB and a conversation takes files up to 10.0 MB",
    );
  });

  it("refuses an empty file rather than uploading nothing", () => {
    const [refusal] = stageFiles(
      [file("nothing.png", "image/png", 0)],
      CONVERSATION_ATTACHMENTS,
      0,
    ).refused;
    expect(refusal).toEqual({ name: "nothing.png", reason: "it is empty" });
  });

  it("counts what is already staged against the cap", () => {
    const out = stageFiles([png(), png()], CONVERSATION_ATTACHMENTS, 9);
    expect(out.accepted).toHaveLength(1);
    expect(out.refused[0]?.reason).toBe("one message carries at most 10 files");
  });

  it("stages nothing more once the cap is already reached", () => {
    const out = stageFiles([png()], CONVERSATION_ATTACHMENTS, 10);
    expect(out.accepted).toEqual([]);
    expect(out.refused).toHaveLength(1);
  });

  it("names a pasted file the browser gave no name", () => {
    const [refusal] = stageFiles(
      [file("", "application/zip", 10)],
      CONVERSATION_ATTACHMENTS,
      0,
    ).refused;
    expect(refusal?.name).toBe("an unnamed file");
  });

  it("says so when the browser named no type at all", () => {
    const [refusal] = stageFiles(
      [file("mystery", "", 10)],
      CONVERSATION_ATTACHMENTS,
      0,
    ).refused;
    expect(refusal?.reason).toContain("no type the browser could name");
  });
});

describe("the sentence a person reads", () => {
  it("leads with the file, not with the rule", () => {
    expect(refusalSentence({ name: "a.pdf", reason: "it is empty" })).toBe(
      "Couldn't attach a.pdf — it is empty.",
    );
  });

  it("hints the dialog with every mime and extension the target takes", () => {
    const accept = acceptAttribute(CONVERSATION_ATTACHMENTS);
    expect(accept).toContain("image/webp");
    expect(accept).toContain(".webp");
    expect(accept).not.toContain("application/pdf");
  });
});

describe("formatSize", () => {
  it("reads in bytes, kilobytes and megabytes", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("the name the server would refuse", () => {
  it("refuses it here instead, naming the rule, so it is not lost at the upload", () => {
    const long = `${"a".repeat(177)}.png`;
    const out = stageFiles([file(long, "image/png", 4096)], CONVERSATION_ATTACHMENTS, 0);
    expect(out.accepted).toEqual([]);
    expect(out.refused[0]?.reason).toMatch(/^its name is too long — shorten it to at most 180 plain letters/);
    expect(out.refused[0]?.reason).not.toContain("bytes");
  });

  it("counts the bytes of the name, not its characters", () => {
    const long = `${"\u00e9".repeat(91)}.png`;
    const out = stageFiles([file(long, "image/png", 4096)], CONVERSATION_ATTACHMENTS, 0);
    expect(out.accepted).toEqual([]);
  });

  it("takes a name that fits once punctuation is cleaned out of it", () => {
    const out = stageFiles([file("a photo (1).png", "image/png", 4096)], CONVERSATION_ATTACHMENTS, 0);
    expect(out.accepted).toHaveLength(1);
  });
});
