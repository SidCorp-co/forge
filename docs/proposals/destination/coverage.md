# Coverage

What this set answers, and what it is silent about. **Silence is the dangerous half**: a reference
used to audit existing logic does not flag the areas it never modelled — it approves them by saying
nothing.

53 questions, 10 areas. **36 answered · 17 open.**

## The rule for this table

A row may claim `answered` only if the named page actually carries the concept. Re-derive the
claim, do not trust it:

```sh
cd docs/proposals/destination
for t in tenant permission revoke lease retry attempt priorit cancel \
         depend fair starv idempot retention; do
  printf '%-12s %3s hits\n' "$t" "$(grep -oiE "$t" *.html | wc -l)"
done
```

Every term above returning 0–1 hits is an open row below. The count was taken at `2026-09-19`; a row
whose status is not re-derived is a claim, not a status.

## A · Identity and authority — 1 / 6

| | Question | Answered in |
|---|---|---|
| A1 | What principals exist and how one is minted | `vision.html` §2 |
| A2 | What roles a human holds, and who grants them | **open** |
| A3 | Delegation — an agent acting for a human, as a record | **open** |
| A4 | Revoking a principal's authority | **open** |
| A5 | The project / organisation boundary | **open** |
| A6 | How a cross-project read or write is refused | **open** |

## B · Intent — 2 / 6

| | Question | Answered in |
|---|---|---|
| B1 | Who may create an Intent | `integrations.html` §7 |
| B2 | Is an Intent mutable, and is it versioned | **open** |
| B3 | Ordering and dependency between Intents | **open** |
| B4 | Priority — the ranking rule behind "what next" | **open** |
| B5 | Deliberate cancellation by a human | **open** |
| B6 | What makes an Intent done | `vision.html` §0, `floor.html` |

## C · Work — 4 / 7

| | Question | Answered in |
|---|---|---|
| C1 | The unit of work | `session-tree.html` §1 |
| C2 | Exclusivity — who holds an Intent right now, across boxes | **open** |
| C3 | Attempt and retry | **open** |
| C4 | Caps: depth, concurrency, budget | `session-tree.html` §6 |
| C5 | Fairness across projects sharing a pool | **open** |
| C6 | Close policies and subtree closure | `session-tree.html` §3–4 |
| C7 | Held / parked, and why it is not an orphan | `session-tree.html` §5 |

## D · State — 5 / 6

| | Question | Answered in |
|---|---|---|
| D1 | The fact row and its immutability | `fact-projection.html` §1 |
| D2 | Two clocks; late and out-of-order arrival | `fact-projection.html` §2 |
| D3 | Correction by supersede | `fact-projection.html` §3 |
| D4 | The projection, and swapping it over history | `fact-projection.html` §5–6 |
| D5 | Insert-time gates, and the write-skew hole | `fact-projection.html` §4 |
| D6 | Retention and volume | **open** — deferrable; a capacity question, not a correctness one |

## E · Not knowing — 4 / 5

| | Question | Answered in |
|---|---|---|
| E1 | The question row and its fixed shape | `question.html` §2, §5.5 |
| E2 | Timers, routing, and who may answer | `question.html` §3–4 |
| E3 | Dedup, coalescing, answering from memory | `question.html` §5 |
| E4 | Promotion of an answer to policy | `question.html` §7 |
| E5 | An open question whose Intent is cancelled | **open** — depends on B5 |

## F · Evidence — 4 / 5

| | Question | Answered in |
|---|---|---|
| F1 | The independence vector | `floor.html` §4 |
| F2 | The substance floor, declared per claim class | `floor.html` §4 |
| F3 | Anti-cheat mechanisms and who owns each | `floor.html` §2 |
| F4 | Falsification tests that can come back wrong | `floor.html` §6 |
| F5 | Evidence that arrives after the merge | **open** |

## G · The outside world — 5 / 6

| | Question | Answered in |
|---|---|---|
| G1 | What role a provider plays in the fact model | `integrations.html` §1 |
| G2 | An Actor returns a witness, or it failed | `integrations.html` §3 |
| G3 | `reverify`, and why it has three answers | `integrations.html` §4 |
| G4 | Degradation — what an outage may not do | `integrations.html` §6 |
| G5 | Classifying an inbound delivery | `integrations.html` §7 |
| G6 | Idempotency of an outbound act, as a rule | **open** — named once in a figure, never modelled |

## H · Boundaries — 5 / 5

| | Question | Answered in |
|---|---|---|
| H1 | The three wires and who refuses on each | `core-runner.html` §1 |
| H2 | The broker, and why a credential stops at the daemon | `core-runner.html` §2 |
| H3 | What a restart reconstructs, in what order | `core-runner.html` §4 |
| H4 | No fact may have the box as its sole witness | `core-runner.html` §5 |
| H5 | The assignment as a core-issued token | `architecture.html` §15 |

## I · Change over time — 4 / 5

| | Question | Answered in |
|---|---|---|
| I1 | Policy admission, and monotone floors | `vision.html` §7 |
| I2 | Pinning `policy_version` into the root session | `fact-projection.html` §4.2 |
| I3 | Version skew across the three artifacts | `architecture.html` §14 |
| I4 | Forward-only migrations for pinned fact types | `architecture.html` §14 |
| I5 | Forcing a policy upgrade onto an in-flight session | **open** |

## J · Adapter — 2 / 2

| | Question | Answered in |
|---|---|---|
| J1 | Compiled-in or out-of-process — the decision | `architecture.html` §16 |
| J2 | Where a normalised adapter lies, and how it refuses | `architecture.html` §16 |

## What this means for using the set

**Do not** use it to judge existing logic in: tenancy and cross-project access · human roles and
permissions · revocation · retry and attempt semantics · exclusivity between boxes · dependency and
priority between Intents · cancellation. On those it has no opinion, and an audit run against it
will read that silence as approval.

The first three areas — A, B, C — hold 12 of the 17 open rows. They are the foundation, and they are
the part that was written last, because the set was drawn from the middle outward.
