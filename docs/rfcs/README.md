# RFCs

Request for Comments — long-form design proposals for significant changes. Each RFC goes through a Final Comment Period before acceptance.

## Index

_No active RFCs._ Write the next one as `0001-kebab-case-title.md` (numbering restarts at 0001 — the previous archive was retired as outdated).

## When an RFC is required

Per [../../CONTRIBUTING.md](../../CONTRIBUTING.md), an RFC is required for:

- New public API surface (REST endpoint, MCP tool, WebSocket event)
- Architecture changes (new service, schema migration, new client form factor)
- Any breaking change
- New pipeline stage or state machine change
- Device-agent protocol changes
- New principal class (team, shared device)

## Process

1. Write the RFC in this folder, numbered sequentially (`NNNN-kebab-case-title.md`)
2. Open a PR with the RFC content
3. Request review from the owning team
4. Respond to feedback; keep revising
5. When ≥5 business days of open discussion have elapsed AND all owning-team members have commented, post the Motion-for-FCP comment
6. Final Comment Period is 10 calendar days
7. At FCP end: disposition is merge / close / postpone.

## Template

Use the [Rust RFC template](https://github.com/rust-lang/rfcs/blob/master/0000-template.md).

Required sections:

- Summary
- Motivation
- Guide-level explanation
- Reference-level explanation
- Drawbacks
- Rationale and alternatives
- Prior art
- Unresolved questions

## After acceptance

- The RFC remains in this folder as the canonical long-form design
- Implementation work tracks in a separate issue
