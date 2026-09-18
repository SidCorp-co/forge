# Human Routing

**Getting the next decision to a human who can make it.** Today Forge routes by **assignment and
pull**; routing by expertise and authority is stated intent, not built.

```mermaid
flowchart LR
  subgraph BUILT["Built today"]
    S[pipeline stops<br/>waiting · needs_info · reopen<br/>reason required] --> AT[GET /me/attention<br/>6 buckets, self-clearing]
    DR[agent-filed draft<br/>no assignee, no notification] --> AT
    ASG[issues.assigneeId<br/>one user] --> AT
    N[notifications<br/>@mentions] --> AT
    AT --> HUM([human decides]) --> BACK[status advances]
  end
  subgraph NOT["Not built — VISION direction"]
    K{what kind of<br/>decision?} -.-> B[business owner]
    K -.-> A[architect]
    K -.-> D[developer]
    K -.-> SEC[security owner]
  end
```

## Built today

| Concern | Where it lives |
|---|---|
| Assignment — exactly one user per issue | `schema.ts:issues` (`assigneeId`), `schema.ts:tasks` (`assigneeId`) |
| Authority — flat roles, two scopes | `schema.ts:orgMemberRoles`, `schema.ts:projectMemberRoles`, `core/src/lib/authz.ts:effectiveProjectRole` |
| The pull surface | `core/src/me/attention-routes.ts` (response + mapping), `core/src/me/attention-buckets.ts` (the bucket queries) |
| Stop-and-ask | `schema.ts:waitingKinds`, `issues.reason`, status `needs_info` |
| A structured question, and answering it from chat | `core/src/questions/`, `core/src/integrations/rocketchat/question-delivery.ts` |
| Asking a room about its own past | `core/src/conversations/transcript-index.ts` cuts the retained transcript into bounded source-linked passages and `assistant/conversation-index-drain.ts` keeps them caught up on a tick; `transcript-search.ts` is the one retrieval door and takes `assistant/conversation-access.ts:readableConversation` as its first act, so a caller outside the room's scope is refused by name rather than served a narrowed set; `transcript-search-tool.ts` is the one bounded tool a turn reaches it through |
| Mentions and delivery | `core/src/notifications/` — `deliver.ts` decides whether anybody is told; `kinds.ts` says what a type IS |
| UI | web `features/attention/`, `notifications/`, `operator/` |

### The six attention buckets

`GET /me/attention` is the routing surface that exists. Every bucket derives from **live** state, so
it self-clears. `mentions` is the one bucket keyed on a read state, and it is deliberate: a mention
is a `signal`, an event that happened, and the only question a human can answer about it is whether
they have seen it. Every other bucket asks whether the thing is still true — which is the same
distinction `notifications` itself now makes in the schema (below), after asking it with one boolean
for a year.

Ownership resolves two ways. `needsReview` is **assignee-only**; the buckets that carry a question or
a proposal use `ownedForAnswer` — assignee, or the **creator** while nobody is assigned — because an
agent-filed issue has no assignee and MCP `forge_issues` cannot set one.

| Bucket | Fires on | Owner rule |
|---|---|---|
| `needsReview` | issues in `developed` or `reopen` | assignee |
| `awaitingInput` | issues in `waiting` or `needs_info` — **not** `on_hold`, which is a pause somebody chose rather than a question somebody is owed (ISS-970) | `ownedForAnswer` |
| `mentions` | `@mention` notifications with no `read_at` on the caller's delivery | mentioned user |
| `failedJobs` | jobs the caller triggered that failed in 7 days — excluding superseded retry attempts and jobs whose issue already reached `closed`/`released` | job creator |
| `pendingSkillUpdates` | reconcile runs at the human decision gate, for projects the caller admins | project admin |
| `unseenDrafts` | `draft` issues an **agent** filed (`created_via` set and not `web`) that no human has commented on — priority-ordered, capped, with `unseenDraftsTotal` reporting the unclipped count | assignee; unassigned falls back to creator **or project admin** |

`unseenDrafts` exists because `draft` is inert by design: no job is ever enqueued for it and
`NOTIFY_ON_STATUS` carries no `draft`, and that hook fires on `transition` rather than create — so
before this bucket an agent-filed draft was reachable from no surface at all. A comment on a non-device
credential (`author_device_id IS NULL`) is the receipt that clears it. An agent holding a person's
PAT clears it **as that person** — identity follows the token and nothing per-comment says
otherwise (`comments.is_ai` did, and disagreed with the token on 3,172 of 23,414 rows; it was
dropped 2026-09-04). That is an **approximation** of the durable seen-receipt tracked in ISS-791,
not that receipt: it cannot tell "never read" from "read and parked without replying", nor a person
from an agent on their credential. Both close with agent identity, not with a stored flag.

**Why it does not stop at the creator.** MCP `forge_issues create` stamps `createdById` with the
account that paired the runner, and on a real deployment the person who opens the UI signs in as a
different org admin. Measured on forge-beta 2026-08-30: a creator-only rule returned 428 drafts to
the paired account nobody signs into and **0** to the org admin who does. So an unassigned draft
also reaches whoever administers the project — the resolver `pendingSkillUpdates` already uses for a
triage gate. Assignment still wins: an assigned draft reaches only its assignee.

**Scope, stated plainly:** every bucket here is CALLER-scoped, not project-scoped. One org admin's
`unseenDrafts` spans every project they administer (428 over 16 projects when this shipped), which
is why the cap is 20, the order is priority-then-recency, and the screen collapses the group above
five rows while the count stays honest.

The bucket criteria are documented in one place — the header comment on
`me/attention-buckets.ts` — and it must stay in sync with the `WHERE` clauses below it.

### Three record kinds, and the count a human reads

`notifications` is the SYSTEM's record of a fact: no `user_id`, no `read`. `notification_deliveries`
is one person's copy on one channel, and `read_at` lives there and nowhere else. Every type declares
its kind and tier once, in `packages/contracts/src/notifications.ts`, mirrored for core's runtime by
`notifications/kinds.ts` (contracts is type-only in core's image — ISS-510) and by the
`notifications.kind` column; a lockstep test fails on any disagreement between the three.

| Kind | States | Closed by |
|---|---|---|
| `signal` | `emitted`, `expired` | nothing — an event cannot stop having happened, so it never counts as open. A CHECK constraint forbids it a resolution key |
| `condition` | `pending`, `firing`, `inhibited`, `resolved` | `auto-resolve.ts:resolveNotifications` and the sweeper pass `pipeline/reevaluate-conditions.ts`. **No HTTP route reaches it** |
| `task` | `open`, `acknowledged`, `done`, `dismissed` | `POST /api/notifications/:id/done` or `/dismiss` |

`GET /api/notifications/open-count` is what the bell, the favicon dot and the document title read: the
number of DISTINCT records still true for the caller. Opening one does not change it; resolving one
member of a grouped delivery lowers it by one. The route it replaced, `unread-count`, is gone rather
than redefined.

Four primitives stand between a record and a person, each borrowed whole from an alerting system that
already settled it, and all four live in `notifications/deliver.ts`: dedup on `resolution_key`
(PagerDuty), a pending duration before a periodic detector's condition is delivered at all
(Prometheus `for`), inhibition of a child by a firing root (`INHIBIT_RULES` in contracts), and a
bounded expiring silence a reader sets for themselves (`notification_silences`). Grouping is the
fifth: records sharing a `groupKey` reach one recipient as one delivery that names their cause and
how many it holds.

All five are evaluated per RECIPIENT, inside `deliver.ts:deliverTo`, and that is load-bearing in two
directions. A silence matches its own author (`created_by`) and nobody else's deliveries — one
operator saying "stop telling me for an hour" is not a switch that quiets the deployment. And every
path that delivers goes through the same loop: a first delivery, a pending record's promotion, a
firing record re-emitted, and `deliverExisting` for the one producer that writes its record inside a
transaction. A reader gated out at the first sighting is therefore told when the gate lifts, for as
long as the condition is still true.

Grouping quiets the bell AND the channel that interrupts. The record that founds a delivery carries
`announce: true` on its `notificationCreated` event; the records that join it carry `announce:
false`, and `features/notifications/use-notification-delivery.ts` fires the toast, the sound and the
browser notification only for the first. Fifteen conditions from one sweep are one bell row and one
interruption. The bell still refreshes on every event.

`notifications/emission-switch.ts` is the operator's blunt instrument beside them — deployment-wide,
in code, visible in a diff. It currently suppresses nothing.

## Not built

| Missing | Consequence today |
|---|---|
| Teams, candidate groups, claim | work goes to one named assignee or to nobody |
| Expertise / capability model | nothing can pick *which* human suits a decision |
| Decision-kind taxonomy | `waitingKinds` has exactly two values — `needs_decision`, `needs_resource`. There is no business / architecture / technical-risk / security split |
| Availability | a stop can land on someone who is away, and nothing notices |
| Escalation ladder | a stop that nobody answers stays stopped. A structured question is posted once to the project's bound chat room and is answerable there; nothing chases it after that, and a project with no bound room has only the attention pull |

`VISION: route-judgment-not-bottlenecks` is the commitment; VISION §5 records that this is
"Direction, not yet reached". Do not describe the four-way routing above as if it ships.
