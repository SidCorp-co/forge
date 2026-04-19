# Contributing to jarvis-agents

Thanks for your interest. The project is in alpha — every piece of feedback is valuable.

## Before you start

- Read the [Code of Conduct](CODE_OF_CONDUCT.md).
- Search existing issues before opening a new one.
- For large features: open a **discussion** or a `proposal` issue before writing code.

## Contribution workflow

1. Fork the repo and create a branch from `main`: `feat/xyz` or `fix/xyz`.
2. Write code + tests. CI must pass locally before pushing.
3. Commit using [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat: add X` — new feature
   - `fix: Y` — bug fix
   - `docs: Z` — docs only
   - `refactor:`, `test:`, `chore:`, `perf:`
4. Open a PR and fill out the template.
5. A maintainer reviews within 3 business days.

## Coding standards

- Lint + format must pass in CI.
- Test coverage should not regress.
- Breaking changes: document them in the PR description and update CHANGELOG.

## Reporting bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml). At minimum:

- Version in use
- Steps to reproduce
- Expected vs. actual behavior

## Proposing features

Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.yml). Describe the **problem** first, not the solution — maintainers may suggest a better approach.

## Security

**Do not open public issues** for security vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

By submitting code, you agree to contribute under [Apache-2.0](LICENSE).
