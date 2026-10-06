# Three steps of requirement-to-delivery cost a person a second write the design never counted

**Removed when:** each gap below is either taken (its change lands and deletes its section) or
refused by name in the design text, which ISS-246 carries, and the last section leaves this file
empty. The change that removes the final section deletes the file.

The third round of the ePOD and Catalog ecosystem exercise ran a breakdown, a revision route and a
provider version through two live masters. Each gap was a step the design draws as one act and the
code makes several, and in each the extra writes came from the person or the master by hand. They
are written here, not filed, because the rules refuse a residual as an issue; each section ends
with what the design text would say if its recommendation is accepted, and none of them has been
applied to the live design.

## 1. A breakdown carries no contract wait

### What happens today

The `breakdown` payload names `blockedBy` (an issue ref or the index of an item) and nothing for a
contract. `packages/core/src/suggestions/breakdown.ts:breakdownEffect` files every item at `draft`
and writes only `blocks` edges through `writeIssueRelations`. A wait on `contract >= version`, the
E1 shape requirement-to-delivery `contract-first` and feedback-triage `upgrade` both use, is written
elsewhere: `packages/core/src/ecosystem/contract/waits.ts:addContractWait` for the REST door and
`packages/core/src/feedback/triage.ts:upgradeWaitIn` for a triage.

Evidence: suggestion d26ce577 (the breakdown of REQ-1 revision 2) was accepted and filed catalog-fe
ISS-3 at draft. The issue had to build against `catalog-api/admin-rest-v1 >= 3.1.0`, which was not
yet approved. The breakdown format has no field for it, so the master added the wait after the accept
("Once it is filed as a draft, I will add the wait").

### Why it costs

The accept is the person's act and the wait is the master's second write, which the accepting person
never saw: what they approved is not what is held. It is safe only because a breakdown files at
`draft`, so nothing dispatches before the wait lands. A master that promotes first, or a breakdown
accepted over the web with no master awake, leaves an issue that dispatches against a provider
version that does not exist.

### Options

- **A. A `contractWaits` array on each breakdown item.** `{ contract, minVersion, dueAt? }`, written by
  `breakdownEffect` inside the accept transaction through `insertContractWaitIn`. The guard
  (`breakdownGuardIn`) refuses by name what `addContractWait` refuses today
  (`CONTRACT_WAIT_CONTRACT_UNKNOWN`, `CONTRACT_WAIT_VERSION_NOT_IN_SCHEME`) at propose and again at
  accept, so the BA reads the wait in the suggestion they approve. Cost: `addRefusals` reads through
  `db`, not a `Tx`, so its checks are lifted to take an executor first; and the payload schema gains a
  field every proposer must learn.
- **B. Infer the wait from the item's criteria.** An item whose build links a pinned contract version
  that is not yet approved gets the wait automatically. No new field, but the inference is a guess
  about intent where the rules want a refusal by name, and it cannot say `dueAt`.
- **C. Leave it and say so.** Keep the second write, document that a breakdown's waits are added
  after the accept, and make the standing read name a draft issue from a breakdown that consumes an
  unapproved version. Cheapest; the person still approves less than what is held.

### Recommendation

A. It is the one option where what the person accepts is what core writes, which is what the design
already says of the other issue-filing acts (`triage` writes its upgrade wait in the triage's own
transaction). B is refused for guessing; C leaves the silent second write in place.

### What the design text would say

requirement-to-delivery `breakdown`: "The master proposes issues with technical criteria traced to
BC codes, the blocks edges between them and, where an issue must build against a provider version
not yet approved, its wait on that version (contract >= version, an optional dueAt), as one
breakdown suggestion." `approve`: "...core creates every issue with requirement_id,
planned_revision, issue_criteria, blocks edges and contract waits in one transaction."

## 2. The revision route takes three person acts for one change

### What happens today

Routing FB-1 to `revision` carries a `revision_diff` suggestion. Accepting it runs
the `revision_diff` branch of `packages/core/src/suggestions/effects.ts:writeEffect`, which
calls `packages/core/src/requirements/revision-write.ts:newDraftRevisionIn`: a revision at state
`draft`, authored by the suggestion's producer (`authorOf`). It is never the head. Two more acts follow:
`packages/core/src/requirements/service.ts:proposeRevision` (`project.write`, draft to proposed) and
`packages/core/src/requirements/agree.ts:acceptRevision` (a holder of `requirements.approve`,
proposed to current, re-baselining an agreed requirement). The master expected a fourth, re-agree,
and core refused `REQUIREMENT_ALREADY_AGREED` ("a change after the agree is a new revision, and
accepting it re-baselines"). The refusal is correct and clear.

Evidence: catalog-fe pane 13:08 ("Accepting that revision only creates a draft revision, so REQ-1
still has to go through propose, accept and re-agree"); the 422 on
`POST .../requirements/REQ-1/agree {revision:2}`.

### Why it costs

The person approved the text once, at the suggestion. The next two acts re-ask about the same text.
In the round the propose waited on the agent that authored the revision, with nothing in the
standing naming who owed it. `proposeRevision` asks only `project.write`, so core would let the
accepting person propose it; that the exercise did not is an affordance gap, not a rule. Nothing is
lost silently, since each step refuses by name, so this is a cost in round-trips rather than a defect.

### Options

- **A. The accept of a `revision_diff` lands the revision at `proposed`.** `newDraftRevisionIn` takes
  the state; the effect passes `proposed` with `proposedBy` the accepting person. The person's
  accept of the suggestion is the propose. Two acts remain (accept suggestion, accept revision), and
  the second keeps its job: the re-baseline pins designs and contracts as they are at that moment.
- **B. The accept also accepts the revision.** One act. The suggestion door would run
  `acceptRevision`'s guards (deferred, stale base, near-duplicate, readiness) inside the effect. It
  makes a re-baseline a side effect of answering a feedback route, and a refusal in the second half
  would refuse the suggestion that the person thought was only about text.
- **C. Keep three acts, make the owed one visible.** The feedback's waiting-on names "propose
  revision 2" until it is proposed. No behaviour change.

### Recommendation

A, and C's visibility inside it: after the change the only act a revision still owes is the
baseline's own. B is refused: a re-baseline is a sign-off on pins, and the suggestion accept does not
show them.

### What the design text would say

feedback-triage `revision`: "The BA accepts the revision_diff suggestion against the head revision
it was based on (routed_suggestion_id); the revision it writes is proposed, awaiting the same
person's accept, which re-baselines an agreed requirement." requirement-lifecycle `rev_draft`
gains: "A revision accepted from a revision_diff suggestion is never left here."

## 3. An additive provider version costs the consumer three re-pin writes

### What happens today

feedback-triage `breaking` says a non-breaking version "only notifies".
`packages/core/src/notifications/notify-ecosystem.ts:versionApproved` sends the bell ("nothing this
project does is owed"), and `packages/core/src/ws/master-wake.ts` wakes the master of each issue a
settled wait freed. When admin-rest-v1 3.1.1 (non-breaking) was approved, the consumer still owed,
by hand and in order: its interface `builtAgainst` from 3.0.0 to 3.1.1
(`packages/core/src/ecosystem/interface-service.ts:writeInterface`, a whole-document write), a
re-pin of REQ-1 (`requirements/baselines.ts:writePinsIn` pins each linked contract's current
version; stale pins block the requirement, per `requirements/rules.ts:staleContractPinsOf`), and
`pinnedVersion` on each of 10 ecosystem links (`ecosystem/link-service.ts:updateLink`, one record
each). Only then could ISS-3 build.

Evidence: catalog-fe master pass from 14:01 ("REQ-1 is blocked on re-pinning the 10 links from
3.0.0 to 3.1.1 ... updating the interface builtAgainst, re-pinning REQ-1, and shifting all 10 links
to 3.1.1").

### Why it costs

Twelve writes for one fact the differ already measured (`classification: non-breaking`). The
notice tells the consumer nothing is owed and the stale-pin standing says the opposite, so the two
disagree until the consumer writes. A link carries `fieldsUsed`, `callSites` and the sha it was
refreshed at, so moving a pin is a claim that the code was checked against the new version; done by
hand ten times, it is either ten checks or ten unexamined edits, and nothing tells which.

### Options

- **A. One act, `adopt`, on the consumption.** `POST /api/projects/:id/interface/adopt` with
  `{ contract, version }`, allowed only where the version is `non-breaking` against the pinned one and
  every link's `fieldsUsed` is still present in it. Core writes the interface revision, moves each
  link's `pinnedVersion` and returns the requirement(s) now stale for a person to re-pin (the re-pin
  stays a `requirements.approve` act, since it is a baseline). Refuses by name any link whose fields
  the version dropped (`ADOPT_FIELD_MISSING`).
- **B. A suggestion.** On approval of a non-breaking version, core files a `contract_adopt` suggestion
  per consumer; accepting it runs A. The master or a person accepts it. One more suggestion kind
  and a feed row per consumer per version, including the ones nobody cares about.
- **C. Pins follow the approved version.** A consumption with `builtAgainst: "current"` resolves at
  read. No write at all, but the pin stops being a record of what the code was built against, which is
  what `pin-rules.ts:pinRefusals` and the breaking-version feedback depend on.

### Recommendation

A, with B left until a second consumer shows the master forgetting it. C is refused: it removes the
fact the breaking-change route needs. The re-pin of the requirement is not folded in; it is a
baseline, and a baseline is signed.

### What the design text would say

feedback-triage `breaking`: "A non-breaking version only notifies; the consumer may adopt it in one
act, which moves its interface consumption and its links to that version where every field a link
uses is still in it, and names each requirement left stale for a re-pin." core-components
`dom-ecosystem`: "...consumptions and channels, and the adopt that moves a consumer to an additive
version."

## Honest costs

- **Taking all three touches the payload and the accept effect of two suggestion kinds** and adds one
  interface door, so the contracts package, the openapi file and the guides change together; the
  proposals are independent and can land one at a time.
- **Leaving them costs round-trips, not correctness.** Each gap refuses by name where it refuses at
  all; the unsafe one is gap 1 for a master that promotes before adding the wait, and nothing
  measures that today.
- **Gap 3's `adopt` carries a judgement the differ cannot make.** `non-breaking` is measured on the
  contract; whether a consumer's behaviour is unchanged by an added field is not, which is why the
  field check refuses by link and the requirement re-pin stays a person's act.
