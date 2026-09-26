# Twelve transport modules can hold the caller open for as long as the socket stays open

Found while working ISS-1233, which owns the master sweep's two calls and now the heartbeat's.
Left here rather than fixed, because the deadline each remaining call wants is a different number
and several of the files are held by other runs' trees.

## What is measured

`CoreClient::new` in `transport/mod.rs` builds `reqwest::Client::new()`, which carries no timeout,
and the deadline is therefore per call: `transport::CALL_DEADLINE`, applied at the request builder
with `.timeout(…)`. Five modules apply it — `heartbeat`, `master`, `mcp_servers`, `pool`,
`runners`. Counted on 2026-09-26 at `23b0d882f` plus this change, twelve modules issue a request
and apply none:

| module | requests with no deadline |
|---|---|
| `run_sessions` | 7 |
| `skills` | 4 |
| `agent_sessions` | 3 |
| `lifecycle`, `provision`, `questions` | 2 each |
| `admissible`, `events`, `git_credential`, `inbox`, `plugins`, `protections` | 1 each |

Twenty-six calls. Each of them is the fault ISS-1233 was filed over, one route across: a peer that
accepts the connection and never answers holds the caller for as long as the socket stays open,
with nothing recorded and nothing to read afterwards. `runners::list_me` was the one that held the
whole master sweep; the others hold whatever their own caller was doing.

## Why it is not twelve `.timeout(CALL_DEADLINE)` calls

Because fifteen seconds is the sweep's number, not everyone's, and applying it by search-and-replace
would refuse work that is legitimately slower than a sweep:

- `skills` and `plugins` move payloads, and a bundle on a slow link is not a hung peer.
- `provision::pull_pending` already has a body-read deadline of its own on ISS-1206's branch, which
  is a different bound from the request deadline and would have to be reconciled rather than
  stacked.
- `run_sessions` carries seven calls on the job lifecycle, where a deadline that fires turns a
  running job's bookkeeping into a lost one — the failure this would trade for the hang is worse
  than the hang for at least some of them.

## What the mechanism is, not the symptom

The deliverable is that a `CoreClient` cannot issue a request with no deadline at all: a default on
the client, which `reqwest::ClientBuilder::timeout` already offers, with the long routes naming
their own longer one rather than naming none. That is one writer of the bound, the shape
`CALL_DEADLINE` already has for the five modules that use it, and it makes the guard question
answerable the way `no_transport_module_formats_a_status_or_a_body_into_its_own_message` made the
refusal question answerable — a new route inherits the deadline instead of being remembered.

## Honest costs

- **Every long route has to be found and given its own number before the default goes in**, or the
  default ships as a regression on whichever of the twenty-six is slowest. That search is the work,
  and it is the reason this is a proposal rather than a patch.
- **A deadline that fires is a new failure mode on paths that never had one.** `run_sessions` is the
  sharp end: the calls it makes are how a job's state reaches core, and a refused write there is a
  job whose record and whose reality have parted, which `VISION: state-never-lies` is about.
- **Leaving it costs what ISS-1233 measured.** A held call is silent: no log line, no record, and a
  heartbeat still going out saying the box is fine. The sweep half of that is fixed; twelve modules
  of it are not.
