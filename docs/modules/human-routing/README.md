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
| Mentions and delivery | `core/src/notifications/` |
| UI | web `features/attention/`, `notifications/`, `operator/` |

### The six attention buckets

`GET /me/attention` is the routing surface that exists. Every bucket derives from **live** state, so
it self-clears — never from a read/unread flag, which became a mute switch once already.

Ownership resolves two ways. `needsReview` is **assignee-only**; the buckets that carry a question or
a proposal use `ownedForAnswer` — assignee, or the **creator** while nobody is assigned — because an
agent-filed issue has no assignee and MCP `forge_issues` cannot set one.

| Bucket | Fires on | Owner rule |
|---|---|---|
| `needsReview` | issues in `developed` or `reopen` | assignee |
| `awaitingInput` | issues in `waiting`, `needs_info` or `on_hold` | `ownedForAnswer` |
| `mentions` | unread `@mention` notifications | mentioned user |
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

## Not built

| Missing | Consequence today |
|---|---|
| Teams, candidate groups, claim | work goes to one named assignee or to nobody |
| Expertise / capability model | nothing can pick *which* human suits a decision |
| Decision-kind taxonomy | `waitingKinds` has exactly two values — `needs_decision`, `needs_resource`. There is no business / architecture / technical-risk / security split |
| Availability | a stop can land on someone who is away, and nothing notices |
| Escalation ladder | a stop that nobody answers stays stopped; only the attention pull surfaces it |

`VISION: route-judgment-not-bottlenecks` is the commitment; VISION §5 records that this is
"Direction, not yet reached". Do not describe the four-way routing above as if it ships.
