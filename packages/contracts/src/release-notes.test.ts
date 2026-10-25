import { describe, expect, it } from "vitest";
import {
  RELEASE_NOTE_TITLE_WORDS_MAX,
  ReleaseNamingSchema,
  ReleaseNotesSchema,
  ReleaseNotesWriteSchema,
  releaseNoteUnwritten,
  sentencesIn,
} from "./release-notes.js";

// catalog-api 0.1.0 (REQ-40): every note was one long sentence the page cut at its first comma, and
// the release had no name, so its peek title was issue titles joined by ";" and cut at 72 characters.

const refusal = (out: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  out.success ? null : (out.error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`) ?? []);

describe("a release note as written (REQ-40 BC-17)", () => {
  const sentence = "Giờ có thể deploy thiết kế catalog lên cửa hàng ePOD; nếu API key bị từ chối, thiết kế được đánh dấu thất bại.";

  it("refuses a note users read that has no short title, naming the field", () => {
    const out = refusal(ReleaseNotesWriteSchema.safeParse({ section: "Added", userFacing: sentence }));
    expect(out).toEqual([expect.stringMatching(/^title: title is required for a Added note: a short title of at most 10 words/)]);
  });

  it(`refuses a title of more than ${RELEASE_NOTE_TITLE_WORDS_MAX} words, counting them`, () => {
    const title = "API key cửa hàng không còn được gửi về trình duyệt nữa";
    expect(refusal(ReleaseNotesWriteSchema.safeParse({ section: "Security", title, userFacing: sentence }))).toEqual([
      "title: title has 12 words; a title is at most 10, and the rest belongs in userFacing.",
    ]);
  });

  it("takes a title of up to ten words, its sentence and its admin steps", () => {
    const note = {
      section: "Added",
      title: "Deploy thiết kế catalog lên cửa hàng ePOD",
      userFacing: sentence,
      adminSteps: ["Chạy migration cho nguồn site epod."],
    };
    expect(ReleaseNotesWriteSchema.parse(note)).toEqual(note);
  });

  it("takes a Skip note without a title: nobody using the product reads one", () => {
    expect(ReleaseNotesWriteSchema.safeParse({ section: "Skip", userFacing: "-" }).success).toBe(true);
  });

  it("still reads a note stored before titles or before the sentence rule, so its page can say what it owes", () => {
    expect(ReleaseNotesSchema.safeParse({ section: "Added", userFacing: sentence }).success).toBe(true);
    expect(ReleaseNotesSchema.safeParse({ section: "Added", title: "Two", userFacing: `${sentence} ${sentence}` }).success).toBe(true);
  });
});

describe("a change says what it does in one sentence (REQ-70 BC-3)", () => {
  const title = "Visit reminders";
  const one = "Nurses see a reminder before each visit, e.g. the morning round.";

  it("refuses a userFacing of two sentences or of none, naming the field and how many it read", () => {
    expect(refusal(ReleaseNotesWriteSchema.safeParse({ section: "Added", title, userFacing: `${one} It works offline too.` }))).toEqual([
      expect.stringMatching(/^userFacing: userFacing has 2 sentences; it is exactly one sentence a user reads\./),
    ]);
    expect(refusal(ReleaseNotesWriteSchema.safeParse({ section: "Fixed", title, userFacing: "…" }))).toEqual([
      expect.stringMatching(/^userFacing: userFacing has 0 sentences;/),
    ]);
  });

  it("takes one long sentence: the rule counts sentences, never characters", () => {
    const long = `Nurses ${"and doctors ".repeat(60)}see a reminder before each visit.`;
    expect(long.length).toBeGreaterThan(500);
    expect(ReleaseNotesWriteSchema.safeParse({ section: "Added", title, userFacing: long }).success).toBe(true);
    expect(ReleaseNotesWriteSchema.safeParse({ section: "Added", title, userFacing: one }).success).toBe(true);
  });

  it("names what a stored note owes before it shows: a title first, then one sentence", () => {
    expect(releaseNoteUnwritten({ userFacing: one })).toBe("untitled");
    expect(releaseNoteUnwritten({ title: "  ", userFacing: one })).toBe("untitled");
    expect(releaseNoteUnwritten({ title, userFacing: `${one} ${one}` })).toBe("not_one_sentence");
    expect(releaseNoteUnwritten({ title, userFacing: one })).toBeNull();
  });
});

describe("a release's name and summary (REQ-40 BC-14)", () => {
  const summary =
    "Catalog giờ deploy được thiết kế lên cửa hàng ePOD: tạo mới, cập nhật ảnh, xoá và chạy theo lịch. Trang cài đặt cửa hàng kiểm tra được kết nối và không còn gửi API key về trình duyệt.";

  it("takes a short name and a summary of two or three sentences", () => {
    expect(ReleaseNamingSchema.parse({ name: "ePOD deploy", summary })).toEqual({ name: "ePOD deploy", summary });
  });

  it("refuses a name that lists the changes, and a summary of one sentence or four, naming each field", () => {
    const out = refusal(
      ReleaseNamingSchema.safeParse({ name: "ePOD deploy, image updates, schedules and store checks", summary: "One sentence only." }),
    );
    expect(out).toEqual([
      "name: name has 8 words; a release name is at most 6, and what it brings belongs in summary.",
      "summary: summary has 1 sentence; it is 2 to 3 sentences saying what the release brings its users.",
    ]);
    expect(refusal(ReleaseNamingSchema.safeParse({ name: "x", summary: "A. B. C. D." }))).toEqual([
      "summary: summary has 4 sentences; it is 2 to 3 sentences saying what the release brings its users.",
    ]);
  });

  it("counts sentences in any script, and never splits a version number or an abbreviation", () => {
    expect(sentencesIn("A report keeps its filter, e.g. the date range, after a reload.")).toBe(1);
    expect(sentencesIn("ePOD must run storefront-graphql 1.1.0 or later. Approve the contract.")).toBe(2);
    expect(sentencesIn("リリースしました。設定を確認してください。")).toBe(2);
  });
});
