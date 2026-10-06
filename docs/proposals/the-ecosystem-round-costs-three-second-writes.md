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
