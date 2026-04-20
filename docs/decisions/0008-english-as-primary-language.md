# ADR 0008 — English as the primary language for public docs

- **Status:** Accepted
- **Date:** 2026-04-19

## Context

The project was developed at SidCorp, a Vietnamese company. Early internal documentation was in Vietnamese, which matched how the team thought and communicated.

Going public, the target audience is the global developer community on GitHub, HackerNews, and Reddit. The lingua franca for OSS is English — specifically, technical English written by and for engineers.

A mixed-language docs tree or Vietnamese-first docs would be a measurable adoption barrier for external contributors.

## Decision

- **All public-facing artifacts are English:** README, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, CHANGELOG, `docs/`, commit messages, PR descriptions, issue templates, error messages, UI copy.
- **Vietnamese is acceptable only in internal-alpha channels:** internal Slack, private planning docs, verbal discussion within SidCorp. Never in the public repo.
- **Brand name stays "Jarvis Agents"** — two words, title case. See [BRAND.md](../BRAND.md).

## Rationale

- **Global contributor base requires English** — most OSS contributors outside Vietnam cannot contribute to a Vietnamese codebase.
- **OSS conventions are English** — conventional commits, GitHub issue templates, RFC processes — the shared vocabulary is English.
- **Technical precision lives in English** — most canonical references (MDN, Postgres docs, Rust book, RFC 7230) are English-first. Translating them into Vietnamese adds a step without adding precision.
- **Separating public/internal cleanly** — Vietnamese stays in channels where audience is known; English is for anywhere the audience is general.

## Alternatives considered

1. **Bilingual docs (Vietnamese + English side-by-side)** — rejected: doubles maintenance effort; drift is inevitable. Worse, any reviewer has to cross-check two versions.
2. **Vietnamese primary, English translation** — rejected: reverses the adoption barrier for non-Vietnamese speakers without adding value for Vietnamese ones (who all read English fluently at professional levels).
3. **English primary, Vietnamese translations for users** — possible later as a community translation effort, not a v0.x maintainer responsibility.

## Consequences

### Positive
- Contributor pool unlocked globally
- Alignment with OSS norms
- Every SidCorp engineer needs professional English for reviews — reinforces team capability

### Negative
- Internal team writes more English than before (minor — the team already operates in English for code)
- Cannot leverage Vietnamese community as early adopters with Vietnamese-first marketing (acceptable trade-off)

## Enforcement

- Code review: any Vietnamese in a public-facing file is a PR-blocking comment
- Automated check (future): CI-time grep for common Vietnamese diacritic words in `docs/`, `README.md`, `CHANGELOG.md`, PR titles
- Commit messages: enforced by commitlint + PR title check (Conventional Commits in English)

## Related

- Detailed voice rules: [BRAND.md](../BRAND.md)
- Translation policy: defer to v0.3+ (community-driven, not maintainer work)
