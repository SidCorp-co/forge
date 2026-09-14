// @vitest-environment jsdom
//
// ISS-1011 — the sentences a person is shown before they change who is in a
// room, and the two rows they are shown afterwards.
//
// The confirmation is the part of this issue whose truth had to be established
// rather than assumed, so it is asserted as CLAIMS rather than as prose: each
// `data-claim` is one fact about what the code does, and a copy edit may move
// the wording without moving what the dialogue promises. What no test here may
// do is pass while the dialogue offers removal as an undo, which is the one
// thing the issue says the confirmation must never say.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentAdditionClaims,
  composerRefusal,
  personAdditionClaims,
  removalClaim,
  roomOpeningClaims,
  scopeDerivation,
} from "./membership";
import { ScopeNotice } from "./components/scope-notice";
import type {
  ConversationMembership,
  ConversationParticipant,
  ConversationProject,
  HandleCandidate,
} from "./types";

expect.extend(matchers);
afterEach(cleanup);

const alpha: ConversationProject = { id: "p1", name: "Alpha", slug: "alpha" };
const beta: ConversationProject = { id: "p2", name: "Beta", slug: "beta" };

const agent = (id: string, projectId: string, handle: string): ConversationParticipant => ({
  id,
  kind: "handle",
  userId: `u-${id}`,
  projectId,
  label: handle,
  displayName: handle,
  reachable: true,
});

const person: ConversationParticipant = {
  id: "pp1",
  kind: "person",
  userId: "u1",
  projectId: null,
  label: null,
  displayName: "Ada",
  reachable: null,
};

const oneToOne: ConversationMembership = {
  shape: "direct",
  participants: [agent("a1", alpha.id, "alpha"), person],
  scope: [alpha.id],
  scopeProjects: [alpha],
  canChangeMembership: true,
};

const shared: ConversationMembership = {
  shape: "group",
  participants: [agent("a1", alpha.id, "alpha"), agent("a2", beta.id, "beta"), person],
  scope: [alpha.id, beta.id],
  scopeProjects: [alpha, beta],
  canChangeMembership: true,
};

const candidate: HandleCandidate = {
  userId: "u-a2",
  handle: "beta",
  project: beta,
  losesReaders: [],
};
const sameProject: HandleCandidate = {
  userId: "u-a3",
  handle: "alpha-two",
  project: alpha,
  losesReaders: [],
};

const textOf = (claims: Array<{ text: string }>) => claims.map((c) => c.text).join(" ");

describe("the confirmation shown before an agent is added", () => {
  const claims = agentAdditionClaims({ candidate, room: oneToOne });
  const keys = claims.map((c) => c.key);

  it("says the agent is shown what was said before it joined", () => {
    expect(keys).toContain("reads-what-was-said");
    expect(textOf(claims)).toMatch(/already been said/i);
  });

  it("says the agent reads the recent part of the room and not the whole of it", () => {
    const one = claims.find((c) => c.key === "reads-what-was-said");
    expect(one?.text).toMatch(/recent part of the room, not the whole of it/i);
  });

  it("says removing it later unreads nothing", () => {
    expect(keys).toContain("removal-unreads-nothing");
    expect(textOf(claims)).toMatch(/does not unread what it has already read/i);
  });

  it("says its replies stay in the room", () => {
    expect(keys).toContain("replies-stay");
    expect(textOf(claims)).toMatch(/stays in the room/i);
  });

  // cm:guard this is the criterion the issue states in the negative, so it is asserted in the negative: no claim may offer removal as a way back. A dialogue that says "you can always take it out again" satisfies every other assertion in this file and is the exact sentence ISS-1011 exists to forbid.
  it("never offers removal as a way to undo the addition", () => {
    const text = textOf(claims).toLowerCase();
    for (const forbidden of ["undo", "reversible", "revert", "take it out again", "change your mind"]) {
      expect(text, `the confirmation offers "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it("names the project the agent brings and the projects the room will then be about", () => {
    const scoped = claims.find((c) => c.key === "scope-after");
    expect(scoped?.text).toContain("Beta");
    expect(scoped?.text).toContain("Alpha and Beta");
  });

  it("says so where the room gains a second project", () => {
    expect(keys).toContain("second-project");
    expect(textOf(claims)).toMatch(/no message can be sent to it from Forge/i);
  });

  it("says nothing about a second project where the agent brings one already there", () => {
    const same = agentAdditionClaims({ candidate: sameProject, room: oneToOne });
    expect(same.map((c) => c.key)).not.toContain("second-project");
  });

  it("says so where a one-to-one room becomes readable by everyone with a role on its projects", () => {
    expect(keys).toContain("readers-widen");
    expect(textOf(claims)).toMatch(/becomes a shared room/i);
  });

  it("says nothing about widening where the room is already shared", () => {
    const already = agentAdditionClaims({ candidate: sameProject, room: shared });
    expect(already.map((c) => c.key)).not.toContain("readers-widen");
  });
});

describe("the confirmation shown before a person is added", () => {
  it("says a one-to-one room becomes readable by them, history included", () => {
    const claims = personAdditionClaims({ name: "Grace", room: oneToOne });
    expect(claims.map((c) => c.key)).toEqual(["person-can-read"]);
    expect(textOf(claims)).toMatch(/everything said in it before now/i);
  });

  // cm:guard a shared room is told the TRUTH rather than the reassuring version: everyone holding a role on its projects can already open it, so claiming an access change would be a claim the code does not make.
  it("says a shared room's access does not change", () => {
    const claims = personAdditionClaims({ name: "Grace", room: shared });
    expect(claims.map((c) => c.key)).toEqual(["person-already-could"]);
    expect(textOf(claims)).toMatch(/changes nobody's access/i);
  });
});

describe("taking a member out", () => {
  it("says which projects the room is left about, and that nothing is unsaid", () => {
    const beta2 = shared.participants.find((p) => p.id === "a2") as ConversationParticipant;
    const said = removalClaim(beta2, shared);
    expect(said).toContain("Alpha");
    expect(said).not.toContain("Beta.");
    expect(said).toMatch(/already read and already said stays as it is/i);
  });
});

describe("a room's projects on screen", () => {
  it("are said to be derived from the agents in the room", () => {
    expect(scopeDerivation(shared)).toMatch(/Read from the agents in this room/i);
    expect(scopeDerivation(shared)).toMatch(/Nobody chooses it/i);
  });

  it("render as a standing notice naming them", () => {
    render(<ScopeNotice room={shared} />);
    expect(screen.getByTestId("scope-notice")).toHaveTextContent("Alpha, Beta");
  });

  // cm:guard the notice describes something STILL TRUE, so it collapses and does not vanish: the collapse control is a disclosure carrying `aria-expanded`, and there is no control anywhere in the notice whose accessible name is a dismissal (ISS-1011 criteria 31, 32).
  it("can be collapsed", () => {
    render(<ScopeNotice room={shared} />);
    const toggle = screen.getByRole("button", { expanded: true });
    expect(toggle).toBeInTheDocument();
  });

  it("carry no control that dismisses them", () => {
    render(<ScopeNotice room={shared} />);
    const notice = screen.getByTestId("scope-notice");
    for (const button of notice.querySelectorAll("button")) {
      const label = `${button.getAttribute("aria-label") ?? ""} ${button.textContent ?? ""}`;
      expect(label.toLowerCase()).not.toMatch(/dismiss|close|hide|got it|don't show/);
    }
    expect(notice.querySelectorAll("button")).toHaveLength(1);
  });
});

describe("a room about more than one project", () => {
  it("cannot be sent into from Forge, and says why and what to do", () => {
    const refusal = composerRefusal(shared);
    expect(refusal).not.toBeNull();
    expect(refusal?.reason).toMatch(/answered under exactly one project/i);
    expect(refusal?.wayOut).toMatch(/Take one of its agents out/i);
  });

  it("is not refused where the room is about one", () => {
    expect(composerRefusal(oneToOne)).toBeNull();
  });
});

describe("an agent that would put somebody in the room outside it", () => {
  const costly: HandleCandidate = {
    userId: "u-a2",
    handle: "beta",
    project: beta,
    losesReaders: ["Grace"],
  };

  it("names who loses the room, rather than warning that somebody might", () => {
    const claim = agentAdditionClaims({ candidate: costly, room: oneToOne }).find(
      (c) => c.key === "readers-lose",
    );
    expect(claim?.text).toMatch(/Grace is in this room today/);
    expect(claim?.text).toContain(beta.name);
  });

  it("says the reason — a role on every project in the room — and that nothing read is taken back", () => {
    const claim = agentAdditionClaims({ candidate: costly, room: oneToOne }).find(
      (c) => c.key === "readers-lose",
    );
    expect(claim?.text).toMatch(/every project in it/i);
    expect(claim?.text).toMatch(/already read is taken back/i);
  });

  it("joins two names and agrees with the plural", () => {
    const claim = agentAdditionClaims({
      candidate: { ...costly, losesReaders: ["Grace", "Amir"] },
      room: oneToOne,
    }).find((c) => c.key === "readers-lose");
    expect(claim?.text).toMatch(/Grace and Amir are in this room today and hold no role/);
  });

  it("says nothing at all where nobody loses the room", () => {
    const keys = agentAdditionClaims({ candidate, room: oneToOne }).map((c) => c.key);
    expect(keys).not.toContain("readers-lose");
  });
});

describe("the confirmation shown before a room is opened", () => {
  it("says what the room will be about, and that the scope is read and not chosen", () => {
    const claim = roomOpeningClaims({ projects: [alpha], agentCount: 1 }).find(
      (c) => c.key === "room-scope",
    );
    expect(claim?.text).toContain(alpha.name);
    expect(claim?.text).toMatch(/nobody chooses it/i);
  });

  // cm:guard the pre-join claim is the one sentence this builder must NOT carry: nothing has been said in a room that does not exist, so reusing `agentAdditionClaims` here would put a false claim in front of every person who opens one (ISS-1011, review F4).
  it("does not claim the agents will be shown what was already said", () => {
    const keys = roomOpeningClaims({ projects: [alpha, beta], agentCount: 2 }).map((c) => c.key);
    expect(keys).not.toContain("reads-what-was-said");
    expect(keys).not.toContain("removal-unreads-nothing");
  });

  it("warns that a two-project room takes no messages, before it is opened", () => {
    const claims = roomOpeningClaims({ projects: [alpha, beta], agentCount: 2 });
    expect(claims.map((c) => c.key)).toContain("second-project");
    expect(textOf(claims)).toMatch(/answered under exactly one project/i);
  });

  it("calls a one-agent room private and a two-agent room readable by role-holders", () => {
    const one = roomOpeningClaims({ projects: [alpha], agentCount: 1 });
    expect(one.map((c) => c.key)).toContain("room-private");
    expect(textOf(one)).toMatch(/read only by the people in it/i);

    const two = roomOpeningClaims({ projects: [alpha, beta], agentCount: 2 });
    expect(two.map((c) => c.key)).toContain("room-shared");
    expect(textOf(two)).toMatch(/not only the people listed here/i);
  });
});
