import { ISSUE_ACTIVITY_ACTIONS, ISSUE_UPDATE_FIELDS } from "@forge/contracts/issue-vocabulary";
import { describe, expect, it } from "vitest";
import { activitySentence, sentenceText } from "./activity-sentences";
import type { ActivityItem } from "./types";

const item = (action: string, over: Partial<ActivityItem> = {}): ActivityItem => ({
  id: "a1",
  issueId: "i1",
  action,
  actorType: "user",
  actorId: "u1",
  actor: { type: "user", id: "u1", displayName: "Lan Pham", isAgent: false },
  payload: {},
  createdAt: "2026-10-20T10:00:00Z",
  ...over,
});

const said = (i: ActivityItem) => sentenceText(activitySentence(i));

// ISS-1229 r22, judge-63: the Activity tab printed "comment.created" and "comment.mentioned".
describe("an Activity event, said as a sentence", () => {
  it.each(ISSUE_ACTIVITY_ACTIONS)("opens with who acted and shows no code (%s)", (action) => {
    const text = said(item(action));
    expect(text.startsWith("Lan Pham ")).toBe(true);
    expect(text).not.toMatch(/[a-z][._][a-zA-Z]/);
    expect(text).not.toContain(action);
  });

  it("says a comment, an edit and a mention in words", () => {
    expect(said(item("comment.created"))).toBe("Lan Pham commented");
    expect(said(item("comment.updated"))).toBe("Lan Pham edited a comment");
    expect(said(item("comment.mentioned", { payload: { mentionedUserIds: ["a", "b"] } }))).toBe(
      "Lan Pham mentioned 2 members in a comment",
    );
    expect(said(item("comment.mentioned", { payload: { mentionedUserIds: ["a"] } }))).toBe(
      "Lan Pham mentioned a member in a comment",
    );
  });

  // ISS-1229 r25, judge-72: the reader mentioned read "mentioned a member" in their own Activity.
  it('says "mentioned you" where the reader was mentioned', () => {
    const toMe = (ids: string[]) =>
      sentenceText(activitySentence(item("comment.mentioned", { payload: { mentionedUserIds: ids } }), "me"));
    expect(toMe(["me"])).toBe("Lan Pham mentioned you in a comment");
    expect(toMe(["me", "a"])).toBe("Lan Pham mentioned you and another member in a comment");
    expect(toMe(["a", "me", "b"])).toBe("Lan Pham mentioned you and 2 other members in a comment");
    expect(toMe(["a"])).toBe("Lan Pham mentioned a member in a comment");
  });

  it("names both statuses of a move by their labels", () => {
    expect(said(item("issue.statusChanged", { payload: { from: "releasing", to: "awaiting_release" } }))).toBe(
      "Lan Pham moved this issue from Releasing to Awaiting release",
    );
  });

  it("names the fields an edit changed in words", () => {
    expect(said(item("issue.updated", { payload: { fields: ["title", "acceptanceCriteria"] } }))).toBe(
      "Lan Pham changed the title and the acceptance criteria",
    );
    expect(
      said(item("issue.updated", { payload: { fields: ["priority"], before: { priority: "medium" }, after: { priority: "high" } } })),
    ).toBe("Lan Pham changed the priority from Medium to High");
  });

  // ISS-1229 r24, judge-70: "from s to xl" while the properties panel showed "XL".
  it.each([
    ["complexity", "s", "xl", "Lan Pham changed the complexity from Small to XL"],
    ["priority", "none", "critical", "Lan Pham changed the priority from None to Critical"],
    ["category", "bug", "enhancement", "Lan Pham changed the category from Bug to Enhancement"],
  ])("quotes a %s change as the properties panel shows it", (field, from, to, words) => {
    expect(said(item("issue.updated", { payload: { fields: [field], before: { [field]: from }, after: { [field]: to } } }))).toBe(
      words,
    );
  });

  it("says a value set where none stood, in the panel's words", () => {
    expect(said(item("issue.updated", { payload: { fields: ["complexity"], before: { complexity: null }, after: { complexity: "m" } } }))).toBe(
      "Lan Pham set the complexity to Medium",
    );
  });

  // ISS-1229 r23, judge-66: "changed the merged at, merged commit sha and merged landing".
  it("says a merge record as the one act it is, and no stored field name in any edit", () => {
    expect(
      said(
        item("issue.updated", {
          payload: {
            fields: ["mergedAt", "mergedCommitSha", "mergedLanding"],
            before: { mergedAt: null },
            after: { mergedAt: "2026-10-20T10:00:00Z", mergedCommitSha: "abc", mergedLanding: "pr" },
          },
        }),
      ),
    ).toBe("Lan Pham recorded the merge");
    expect(
      said(item("issue.updated", { payload: { fields: ["mergedAt", "mergedCommitSha", "mergedLanding"], after: { mergedAt: null } } })),
    ).toBe("Lan Pham took back the merge record");
    for (const field of ISSUE_UPDATE_FIELDS) {
      const text = said(item("issue.updated", { payload: { fields: [field] } }));
      expect(text, field).not.toMatch(/merged at|commit sha|landing|detector key|session context|metadata|assignee id/i);
      if (/[A-Z]/.test(field)) expect(text, field).not.toContain(field);
    }
    expect(said(item("issue.updated", { payload: { fields: ["releaseNotes", "sessionContext"] } }))).toBe(
      "Lan Pham changed the release note and the agent's working notes",
    );
    expect(said(item("issue.updated", { payload: { fields: ["someNewColumn"] } }))).toBe("Lan Pham changed this issue");
  });

  // ISS-1229 r23, judge-66: the reader saw their own events as "Another member".
  it("names the reader You, whatever name core gave them", () => {
    expect(sentenceText(activitySentence(item("comment.created", { actor: null }), "u1"))).toBe("You commented");
    expect(sentenceText(activitySentence(item("comment.created"), "u1"))).toBe("You commented");
    expect(sentenceText(activitySentence(item("comment.created"), "u2"))).toBe("Lan Pham commented");
  });

  it("says an action this build has no words for as a change by its actor, never as its code", () => {
    expect(said(item("issue.somethingNew"))).toBe("Lan Pham changed this issue");
  });

  it("names an actor core could not resolve without inventing one", () => {
    expect(said(item("comment.created", { actor: null }))).toBe("A member commented");
    expect(said(item("comment.created", { actor: null, actorType: "device" }))).toBe("An agent commented");
  });
});
