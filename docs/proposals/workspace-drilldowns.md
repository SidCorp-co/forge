# The five workspace figures that cannot open their records

The workspace dashboard (ISS-988) holds every figure to one rule: a number that stands for a set of
records opens that set. Five figures on it do not, and are drawn as context — no focus, no cursor,
no affordance claiming otherwise. This is the record of what each would need, so the omission is a
decision somebody can act on rather than a gap somebody rediscovers.

Each is a **date-windowed aggregate**. The obstacle is the same in all five: no client-reachable
route selects records by the window the figure was drawn over.

| Figure | What it counts | What it would need |
|---|---|---|
| A heartbeat day | issue-kind pipeline runs started on one UTC day | `GET /api/projects/:id/pipeline-runs` takes neither a date window nor an org scope — it is fenced to one project id and to no time range |
| A flow week | issues created, finished, and reopened in one ISO week | `GET /api/projects/:id/issues` takes `status` but no created-between or transitioned-between window |
| A run-failure lane | `pipeline_runs` of one `kind` in the trailing 90 days | the same run list, plus a `kind` filter it does not have |
| A session-failure reason | failed agent sessions grouped by `failure_reason` | no client-reachable list selects agent sessions by failure reason |
| A job-type flow node | jobs of one type in the trailing 90 days | no client-reachable list selects jobs by type and window |

## What would close it

One org-scoped record list per shape, each taking the window the figure was drawn over — a runs
list with `from`/`to`, `kind` and org scope; an issues list with a created-between window; a
sessions list with a `failureReason` filter; a jobs list with `type` and a window. Each is a read
the dashboard already has the aggregate for and only lacks the rows behind.

That work is a second surface, and ISS-988 puts one out of scope by name: the per-project dashboard
at `/projects/[slug]` is its own pass. These five belong with it, because both want the same thing —
record lists selected by a window rather than by a project id alone.

## Why they are not simply linked to the nearest list

A door that opens *approximately* the right records is worse than none. A heartbeat day linked to
the project's unfiltered run list answers a question the reader did not ask, while looking like it
answered theirs. The rule the dashboard holds — a figure is a door only when a list of its records
can be shown truthfully — is what keeps the other twenty or so figures trustworthy, and it is
cheaper to leave five figures plainly undoorable than to make every door on the surface a guess.

## Honest costs

Priced against adopting the record lists, not against the five undoorable figures — those are
already shipped and already drawn without a door.

| Cost | Who pays it, and when |
|---|---|
| Four new org-scoped list routes, each with its own fence | Every one of them fans out across projects, so each needs the reasoning `/api/me/pulse` already carries: no PAT surface, scoped to what the caller can see. Paid at design time by whoever writes them, and paid again by whoever reviews the fence. |
| A date window is a new query axis on three tables | `pipeline_runs`, `issues` and `agent_sessions` are all indexed for the reads they serve now. A created-between or started-between filter over an org's whole set is a different access shape, and whether it needs an index is a question only a measurement answers. Paid by whoever ships it, or paid by the first operator whose dashboard click takes eight seconds. |
| Twenty figures' worth of doors become a contract | Once five more figures open lists, the rule "a figure is a door when its records can be shown truthfully" stops being cheap to hold: every future figure arrives owing a record list. Paid by every later change to this surface. |
| The per-project dashboard wants the same routes and is not scoped here | ISS-988 names `/projects/[slug]` as its own pass. Building these lists for the workspace surface alone risks a second set shaped for one project, which is the fan-out this endpoint was created to remove. Paid as duplicated routes if the two passes are sequenced badly. |
| Doing nothing has a small, quiet bill | Five figures stay context rather than navigation. A reader who wants the records behind a bad week goes to the project and filters by hand. No alarm, no owner — it costs a few minutes each time somebody asks "which ones?" |
