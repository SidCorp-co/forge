# Coverage

What this set answers, and what it is silent about. **Silence is the dangerous half**: a reference
used to audit existing logic does not flag the areas it never modelled — it approves them by saying
nothing.

53 questions, 10 areas. **49 answered · 4 open.** Answered means this set carries the concept.
Whether the code does is the second column, and it is **8 of 53 checked**.

## Two columns, two different claims

**Answered in** says a page here carries the concept. **Held in code** says the running system
does it. They are not the same question, and for three rows they already disagree: C2, C3 and C7
are answered by this set and contradicted by the tree.

A cell in the second column names a `file.ts:symbol` only when that symbol is reached **on the path
the system actually runs**. Reachable is not reached — `jobs` has eight live minting paths and not
one of them is on the issue path, so it would pass a "does the code exist" test and fails this one.

`not checked` means nobody has looked. It is not a pass, and it is the honest majority today.

## The rule for the first column

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

## A · Identity and authority — 6 / 6

| | Question | Answered in | Held in code |
|---|---|---|---|
| A1 | What principals exist and how one is minted | `vision.html` §2 | not checked |
| A2 | What roles a human holds, and who grants them | `authority.html` §2 | not checked |
| A3 | Delegation — an agent acting for a human, as a record | `authority.html` §3 | not checked |
| A4 | Revoking a principal's authority | `authority.html` §4 | not checked |
| A5 | The project / organisation boundary | `authority.html` §1 | not checked |
| A6 | How a cross-project read or write is refused | `authority.html` §1 | not checked |

## B · Intent — 6 / 6

| | Question | Answered in | Held in code |
|---|---|---|---|
| B1 | Who may create an Intent | `integrations.html` §7 | not checked |
| B2 | Is an Intent mutable, and is it versioned | `lifecycle.html` §2 | not checked |
| B3 | Ordering and dependency between Intents | `lifecycle.html` §3 | `issue_dependencies` — but only `blocks` gates dispatch; `parent`/`relates` are metadata-only and `decomposes` silently waives the work-evidence check |
| B4 | Priority — the ranking rule behind "what next" | `lifecycle.html` §4 | not checked |
| B5 | Deliberate cancellation by a human | `lifecycle.html` §1, §7 | not checked |
| B6 | What makes an Intent done | `vision.html` §0, `floor.html` | not checked |

## C · Work — 7 / 7

| | Question | Answered in | Held in code |
|---|---|---|---|
| C1 | The unit of work | `session-tree.html` §1 | `drive` is the only job type the driver uses, and none has been minted for an issue since 2026-09-08 |
| C2 | Exclusivity — who holds an Intent right now, across boxes | `lifecycle.html` §5 | **nothing.** `pipeline_runs_issue_open_uq` is scoped `WHERE kind='issue'`; the lease hangs off a run session the master does not open — ISS-1134 |
| C3 | Attempt and retry | `lifecycle.html` §6 | `jobs.attempts` and the failure classifier are real, and no job is minted for issue work, so neither runs for it — ISS-1135 |
| C4 | Caps: depth, concurrency, budget | `session-tree.html` §6 | not checked |
| C5 | Fairness across projects sharing a pool | `lifecycle.html` §8 | not checked |
| C6 | Close policies and subtree closure | `session-tree.html` §3–4 | not checked |
| C7 | Held / parked, and why it is not an orphan | `session-tree.html` §5 | `pipeline/issue-run-invariant.ts` names every issue a master is working as orphaned: all three of its conditions are true of healthy work |

## D · State — 5 / 6

| | Question | Answered in | Held in code |
|---|---|---|---|
| D1 | The fact row and its immutability | `fact-projection.html` §1 | not checked |
| D2 | Two clocks; late and out-of-order arrival | `fact-projection.html` §2 | not checked |
| D3 | Correction by supersede | `fact-projection.html` §3 | not checked |
| D4 | The projection, and swapping it over history | `fact-projection.html` §5–6 | not checked |
| D5 | Insert-time gates, and the write-skew hole | `fact-projection.html` §4 | not checked |
| D6 | Retention and volume | **open** — deferrable; a capacity question, not a correctness one | `pipeline_outbox` and `phase_journal` appear in none of the 8 `RETENTION_RULES` — both accumulate without bound |

## E · Not knowing — 5 / 5

| | Question | Answered in | Held in code |
|---|---|---|---|
| E1 | The question row and its fixed shape | `question.html` §2, §5.5 | `agent_questions` — the park/resume path reads and writes it |
| E2 | Timers, routing, and who may answer | `question.html` §3–4 | not checked |
| E3 | Dedup, coalescing, answering from memory | `question.html` §5 | not checked |
| E4 | Promotion of an answer to policy | `question.html` §7 | not checked |
| E5 | An open question whose Intent is cancelled | `lifecycle.html` §7 — voided with a reason, never answered | not checked |

## F · Evidence — 4 / 5

| | Question | Answered in | Held in code |
|---|---|---|---|
| F1 | The independence vector | `floor.html` §4 | not checked |
| F2 | The substance floor, declared per claim class | `floor.html` §4 | not checked |
| F3 | Anti-cheat mechanisms and who owns each | `floor.html` §2 | `dependency-effects.ts:WORK_EVIDENCE_WAIVER_KIND` — a string constant in TypeScript decides whether an issue may be marked merged with no branch and no commit; no migration or admin can see it |
| F4 | Falsification tests that can come back wrong | `floor.html` §6 | not checked |
| F5 | Evidence that arrives after the merge | **open** | not checked |

## G · The outside world — 5 / 6

| | Question | Answered in | Held in code |
|---|---|---|---|
| G1 | What role a provider plays in the fact model | `integrations.html` §1 | not checked |
| G2 | An Actor returns a witness, or it failed | `integrations.html` §3 | not checked |
| G3 | `reverify`, and why it has three answers | `integrations.html` §4 | not checked |
| G4 | Degradation — what an outage may not do | `integrations.html` §6 | not checked |
| G5 | Classifying an inbound delivery | `integrations.html` §7 | not checked |
| G6 | Idempotency of an outbound act, as a rule | **open** — named once in a figure, never modelled | not checked |

## H · Boundaries — 5 / 5

| | Question | Answered in | Held in code |
|---|---|---|---|
| H1 | The three wires and who refuses on each | `core-runner.html` §1 | not checked |
| H2 | The broker, and why a credential stops at the daemon | `core-runner.html` §2 | not checked |
| H3 | What a restart reconstructs, in what order | `core-runner.html` §4 | not checked |
| H4 | No fact may have the box as its sole witness | `core-runner.html` §5 | not checked |
| H5 | The assignment as a core-issued token | `architecture.html` §15 | not checked |

## I · Change over time — 4 / 5

| | Question | Answered in | Held in code |
|---|---|---|---|
| I1 | Policy admission, and monotone floors | `vision.html` §7 | not checked |
| I2 | Pinning `policy_version` into the root session | `fact-projection.html` §4.2 | not checked |
| I3 | Version skew across the three artifacts | `architecture.html` §14 | not checked |
| I4 | Forward-only migrations for pinned fact types | `architecture.html` §14 | not checked |
| I5 | Forcing a policy upgrade onto an in-flight session | **open** | not checked |

## J · Adapter — 2 / 2

| | Question | Answered in | Held in code |
|---|---|---|---|
| J1 | Compiled-in or out-of-process — the decision | `architecture.html` §16 | not checked |
| J2 | Where a normalised adapter lies, and how it refuses | `architecture.html` §16 | not checked |

## What the second column has already found

- **C2, C3, C7 — answered here, absent there.** Who holds an issue, how a failed attempt is
  retried, and what separates parked work from an orphan are each modelled in this set and held by
  nothing on the path issue work takes. ISS-1134 and ISS-1135 carry the first two; the third falls
  out of the first.
- **D6 was open and now has a measurement.** Two tables accumulate with no retention rule.
- **F3 is answered but held by a constant.** A gate exemption that only exists as a string in
  application code is not enforced in the sense F3 describes.
- **The first column is measured by grep, and this set now contains a file that pollutes it.**
  `issues-erd.html` holds the only occurrence of `priority` in the whole set, which makes B4 read
  as covered when the word appears nowhere in the page B4 cites. Conversely `fair` scores 1 while
  `starv` scores 4, so C5 is modelled under a vocabulary the grep does not look for. The count
  finds words; a row still has to be read.

## What this means for using the set

**Do not** use it to judge existing logic in: retention and volume · evidence that arrives after a
merge · idempotency of an outbound act as a stated rule · forcing a policy upgrade onto an
in-flight session. On those it has no opinion, and an audit run against it will read that silence
as approval.

The foundation areas — A identity and authority, B intent, C work — were written last, because the
set was drawn from the middle outward. They are now closed by `authority.html` and
`lifecycle.html`. The four rows still open are each a single mechanism, not a missing foundation.

## Honest costs

| Cost | What it buys, and who pays |
|---|---|
| The count measures vocabulary, not understanding | The grep block looks for words. A page naming `lease` once scores like one that models it, so a row marked answered can still be answered badly |
| Maintaining it is manual | Every new page means re-judging 53 rows by hand. The first round that is skipped, the number becomes a claim rather than a measurement |
| 49 of 53 reads as nearly finished | The four open rows are not four small ones — retention is a capacity decision, evidence-after-merge and outbound idempotency are each a mechanism, and forcing a policy upgrade touches the session tree |
