import { ISSUE_ACTIVITY_ACTIONS } from "@forge/contracts/issue-vocabulary";
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

  it("names both statuses of a move by their labels", () => {
    expect(said(item("issue.statusChanged", { payload: { from: "releasing", to: "awaiting_release" } }))).toBe(
      "Lan Pham moved this issue from Releasing to Awaiting release",
    );
  });

  it("names the fields an edit changed in words", () => {
    expect(said(item("issue.updated", { payload: { fields: ["title", "acceptanceCriteria"] } }))).toBe(
      "Lan Pham changed the title and acceptance criteria",
    );
    expect(
      said(item("issue.updated", { payload: { fields: ["priority"], before: { priority: "medium" }, after: { priority: "high" } } })),
    ).toBe("Lan Pham changed the priority from medium to high");
  });

  it("says an action this build has no words for as a change by its actor, never as its code", () => {
    expect(said(item("issue.somethingNew"))).toBe("Lan Pham changed this issue");
  });

  it("names an actor core could not resolve without inventing one", () => {
    expect(said(item("comment.created", { actor: null }))).toBe("Another member commented");
    expect(said(item("comment.created", { actor: null, actorType: "device" }))).toBe("An agent commented");
  });
});
