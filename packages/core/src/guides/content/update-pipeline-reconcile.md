## Update Pipeline — reconcile bundle reference

Reference for Update Pipeline stage ② (Reconcile). The decision rules live in the agents' own
instructions; this is the data dictionary and the surrounding contract. Read it when you need the
meaning of a field, not to decide a verdict.

### How a reconcile run happens
```
⓪ AUTHOR    a human writes an Update Packet { change · story · intent_class · applies_to }
① ENFORCE   whatever is expressible as platform policy ships as CODE → every project at once,
            and emits the currently-effective invariant set
② RECONCILE per project: Master agent reads the bundle → verdict + gate
            → 3 independent verifiers vote → publish, park for a human, or escalate
③ CONVERGE  new hash → manifest → runner pulls (including deletes)
④ OBSERVE   runner reports what is ACTUALLY on disk; each job records the hash it ran with
⑤ AUDIT     every state change writes an event in the same transaction
```

### The bundle
`ReconcileBundleSnapshot` — read fresh at trigger time, never from an older snapshot.

| Field | What it is | Trust |
|---|---|---|
| `change` | the diff description | authored |
| `story` | **why** this change exists and what it must not break | human, mandatory |
| `intentClass` | `invariant` / `procedure` / `enhancement` | sets adaptation latitude |
| `appliesTo` | which skill the packet targets | authored |
| `provenance` | commit, author, version | derived |
| `runningBody` | the body **observed on the project's device** — not the copy Forge stores | observed |
| `runningHash` | hash of that observed body | observed |
| `charter` | the project's Divergence Charter: differences the owner declared intentional. `null` when none exists | human |
| `knowledge_entries` | the project's own prose; an `always` entry is injected into every agent on this project | knowledge store |
| `pipelineConfig` | the project's pipeline configuration | project config |
| `recentRunEvidence` | recent runs of the stage this skill serves | observed |
| `priorReconcileHistory` | earlier reconcile runs for this same skill | observed |
| `invariantSet` | the platform invariants in force right now (stage ① output) | hard constraint |
| `mustNotBreak` | assertions derived from non-revertable charter entries | absolute |
| `sources` | per-field provenance label: `human` / `from-code` / `observed-from-run` / `agent-assertion` | — |
| `readAt` | when the bundle was assembled | freshness stamp |

Two fields are easy to misread. `runningBody` is what a device reported, so it may differ from what
Forge pushed — that difference is the whole point of having it. `mustNotBreak` is not advisory; an
entry there came from an incident.

### The refusal contract (C1–C5)
The server validates these **before** either agent runs. A missing input is a refusal, not a
degraded run — there is no best-effort mode.

| | Guarantee | Born from |
|---|---|---|
| C1 | **Sufficient** — every decision-relevant input present | agents coding against `plan: null` |
| C2 | **Fresh** — read at decision time, with a `readAt` stamp | a stale session context reopened a passing issue |
| C3 | **Sourced** — every fact carries a provenance label | an agent wrote its own guess into a verified-ground-truth field |
| C4 | **No fabrication** — `story` must be human, `runningBody` must be observed | same incident |
| C5 | **Deterministic** — same packet + same project state ⇒ same bundle | so a differing outcome is a model problem, not an input problem |

A refusal is recorded with the specific missing input. If you triggered a run and got one, the
message names exactly what to fix.

### Verdicts and the gate
The Master agent returns one of `no-op` / `apply` / `apply-with-adaptation` / `escalate`, and
**declares the gate itself** — `auto` (publishes once a majority of verifiers pass) or `human`
(parks for the owner). No server-side rule overrides that declaration; the verifiers re-judge it
adversarially instead.

There is **no automatic revert.** A wrong `auto` reaches every runner on the project, and the only
recovery is a manual step back to the run's `lastGoodBody`. That asymmetry is why the instructions
tell both agents to prefer `human` when uncertain.

### Failure containment
A failure at any stage keeps the last-good body running. The skill is never left empty and never
silently changed, and the run records why it stopped.