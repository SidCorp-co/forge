# Architecture Decision Records (ADRs)

Append-only log of significant technical decisions. Each ADR captures:

- **Context** — the problem at the time
- **Decision** — what was chosen
- **Rationale** — why, plus alternatives considered
- **Consequences** — what this makes easy / hard afterwards

ADRs are **never edited after acceptance**. If a decision is reversed, write a new ADR that supersedes the old one.

## Index

| # | Title | Status | Date |
|---|-------|--------|------|

## Status values

- **Proposed** — under discussion, not yet committed
- **Accepted** — in force
- **Superseded by N** — replaced by ADR #N
- **Deprecated** — no longer recommended, but not replaced

## How to write a new ADR

1. Copy the template format from any existing ADR
2. Number it sequentially
3. Use a short title: `NNNN-kebab-case-title.md`
4. Commit with message: `docs(adr): NNNN <title>`
5. Link it in this index (next = 0020)

RFCs that affect API/architecture/cross-team surfaces go through [rfcs/](../rfcs/) first. When an RFC is accepted, summarize as an ADR here. Long-form design lives in the RFC; the ADR is the short decision record.
