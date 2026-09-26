# A read-only token can write through /mcp

**Status:** open, undecided. Found on ISS-1175 (2026-09-26) while writing the pages that tell a
person which scopes to tick for their assistant. Not fixed there, because the fix is a behaviour
change for live tokens whose extent nobody has measured.

## The mechanism

The Tokens tab offers three scopes and describes them as *what this token may do*; its form ticks
`read` alone by default (`web-v2/src/features/settings/components/tokens-tab.tsx`).

On the REST data plane the scope holds: `middleware/pat-rest-surface.ts` refuses a method the
token's scopes do not cover. On `/mcp` it does not. `mcp/request-class.ts:classifyMcpEnvelope`
already sorts every JSON-RPC envelope into `read` or `write`, failing closed to `write`, but the
only reader of that answer is the rate limiter in `middleware/require-pat.ts:authenticatePat`.
No gate compares it with `principal.scopes`. Outside `assertPrincipalIsAdmin` (the `admin` scope)
and a handful of tools that check `write` themselves (`forge-release-batch`, `forge-projects`),
a token holding only `read` can create issues, comment and change fields through `/mcp`.

## Why it was not closed on ISS-1175

The gate itself is one comparison in `requirePat`: a `write`-class request from a token without
`write` answers 403, naming the scope. What is not known is who it breaks. Every token a person
created with the default form holds `read` only, and any assistant using one to file issues today
starts being refused the moment the gate lands. `CLAUDE.md` asks for a wrong use that is already
load-bearing in the field to become a priced amnesty rather than a silent break, and whether this
one is load-bearing is a production measurement:

- active personal access tokens whose `scopes` lack `write`, and
- of those, how many appear in `mcp_audit_log` (`token_id`, with `tool` and `action`) against a
  write-class call in the last 30 days.

Zero on the second line means the gate lands as-is. Anything else means the gate lands with a
named, dated amnesty for those tokens, and their owners are told.

## What the connect-an-assistant pages say meanwhile

They tell the reader to tick **read** and **write**, and they say what each is for. They promise
nothing about a token holding `read` alone, so they stay true whichever way this is decided.

## Honest costs

- **Leaving it open** keeps a token's scope a promise `/mcp` does not keep: a person who chose
  `read` so an assistant could only look things up has handed it write access, and nothing tells
  them.
- **Landing the gate** refuses every write-class call from a read-only token at once. Any
  assistant that has been filing issues on one stops, and its owner has to create a new token with
  `write` ticked before it works again.
- **The request classifier becomes an authorisation input.** It fails closed to `write`, so a read
  it does not recognise would be refused to a read-only token; today that misclassification costs a
  rate budget, afterwards it costs a refusal.
