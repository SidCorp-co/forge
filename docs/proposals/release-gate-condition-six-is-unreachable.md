# One release-gate verdict cannot be earned on the fleet that runs the gate

- Status: **measured, undecided**
- Related: the project's `release-gate` fact (`forge_config` → `projectFacts`) ·
  `docs/proposals/agent-driven-pipeline.md`

## What is true

`release-gate` offers three verdicts. **PASS** needs the acceptance criteria walked against the live
deploy. **VERIFIED-BY-TEST** needs all six of its conditions stated explicitly, and condition 6 is an
independent code review returning APPROVE on the same SHA. **BLOCKED-FIXTURE** is the honest answer
when neither holds.

On `forge-vm`, condition 6 has no mechanism: the review runs through `forge codex consult`, which
needs a gateway profile at `~/.claude/claude-proxy.env`, and that file does not exist on the box.
Re-checked 2026-09-07 at 11:0xZ, 11:2xZ and 17:4xZ — absent each time. So on the box that runs most
of this project's pipeline, **VERIFIED-BY-TEST is unreachable by construction**, and every issue
whose criteria cannot be walked live has exactly one legal verdict left.

Condition 4 has a narrower version of the same problem: it asks that the deploy be *"live and healthy
with `SOURCE_COMMIT` matching that merge"*, and `GET /version` answers `version` and `uptimeSeconds`
and nothing else. What a session can actually prove is that the deploy *contains* a given merge — by
reading a string back out of served content — which is weaker than the condition as written. ISS-966
covers the missing `SOURCE_COMMIT`; this document is about what the gate should say while it is
missing.

## Why this is a decision rather than a defect

Two readings, and they lead to different fleets:

1. **Condition 6 is a hard requirement.** Then the gate is correct and the fleet is
   under-provisioned: a gateway profile is owed on every box that runs a pipeline, and until it
   lands the honest verdict is BLOCKED-FIXTURE — which is what sessions have been recording, at a
   cost of one owner decision per parked issue (15 of them between 07:34 and 07:47Z on 2026-09-07
   alone).
2. **Condition 6 is aspirational on a single-provider box.** Then the gate needs a fourth verdict,
   or condition 6 needs a named substitute (a second model on the same provider; a reviewer subagent
   with its independence stated as weaker) — and whichever substitute is chosen has to be written
   into the fact text, because a condition an agent cannot meet is one it will eventually meet
   dishonestly.

Recording it because the second reading is the dangerous one to arrive at by drift. A session that
quietly downgrades condition 6 to "a subagent reviewed it" has changed the gate without anyone
deciding to.

## Honest costs

| Choice | What it takes from whoever adopts it |
|---|---|
| Reading 1 — condition 6 is hard | A gateway profile owed on every pipeline box: a second provider credential per box to provision, rotate and pay for. Until it lands the gate keeps producing BLOCKED-FIXTURE parks at about one owner decision each, and correct-but-unclosed issues accumulate — 15 of them between 07:34 and 07:47Z on 2026-09-07. Paid in owner attention, not agent time. |
| Reading 2 — name a substitute | Whatever is named is weaker than condition 6 as written, and the weakening becomes permanent once it is in the fact text. A reviewer subagent shares the parent's model, prompt and blind spots, so "independent" stops meaning independent, and nobody downstream can tell which verdicts were earned under which rule unless the record says so per issue. |
| Doing nothing | The condition stays unmeetable, and the first session that treats "a subagent approved it" as satisfying it has changed the gate with nobody deciding to. Cheapest of the three until a verdict is wrong, then the most expensive. |
