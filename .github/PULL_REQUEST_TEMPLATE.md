<!-- Thanks for contributing! Fill the sections below so review moves fast. -->

## Summary

<!-- 1–3 sentences: what changed, why -->

## Declarations

<!-- These decide how the change is handled. A wrong answer here is a defect, not a formality. -->

- [ ] screen change — a person can see a difference
- [ ] schema coupling — a migration rides with this (read the migration-order rule in CONTRIBUTING.md)
- [ ] deploy coupling — this must land before or after something else to be safe
- [ ] user-facing outcome — a CHANGELOG entry is owed

<!-- The release version is NOT decided here: it is allocated when a release is cut, and a pull
     request does not bump anything. See docs/adr/0001-a-release-version-is-a-counter.md -->

## Related issue

Closes #

## Test plan

<!-- Concrete checklist of what you tested. Do not write "tested it works". -->

- [ ] Unit tests pass locally
- [ ] Integration tests pass locally
- [ ] Manual scenario: ...

## Checklist

- [ ] Code follows the project style guide
- [ ] Self-reviewed the diff
- [ ] Updated docs where relevant
- [ ] Added a [CHANGELOG.md](../CHANGELOG.md) entry for meaningful changes
- [ ] Commit messages follow Conventional Commits

## What this replaces

<!-- The requirement, the old logic this supersedes, and the cleanup that removes it. Code shipping
     beside what it replaced leaves two live paths. Write "nothing" if it replaces nothing. -->

## Screenshots / demo

<!-- For UI changes -->
