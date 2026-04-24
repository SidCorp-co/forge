# Complexity Rules

Complexity classification matters because `forge-plan` uses it to decide whether to auto-approve the implementation plan or require human review. Getting this wrong has real costs:
- **Too complex** → unnecessary human gate, slows the pipeline
- **Too simple** → under-planned, risks missing important cross-cutting concerns

Since triage runs without codebase access, classify based on the issue description, acceptance criteria, and your knowledge of typical software patterns.

## Simple

Single file or component change, isolated with no cross-file dependencies.

**Signals:** typo fix, style change, config update, null check, constant change, adding a field to a form when the schema already supports it.

**Auto-approve:** Yes — forge-plan will auto-approve simple plans.

## Medium

2-5 files affected, within a single package. May need a new utility, hook, or component, but follows existing patterns.

**Signals:** new filter/sort option, new UI component using existing design system, new field in API response (schema exists), component refactor, new validation rule, error handling additions.

**Auto-approve:** Yes — forge-plan will auto-approve medium plans.

## Complex

Cross-package changes, new APIs, schema changes, or architectural decisions.

**Signals:** mentions multiple packages (strapi + web), new content types, new endpoints, "migration", "real-time", "authentication flow", "integration", affects 6+ files, new third-party dependency.

**Auto-approve:** No — complex plans require human review before implementation.

## Assessment Heuristics (Without Codebase)

1. **Description scope** — how many areas/features are mentioned?
2. **Acceptance criteria count** — many criteria usually correlate with complexity
3. **Keywords** — "schema", "migration", "new API", "cross-platform" signal complex
4. **Package mentions** — multiple packages = almost certainly complex
5. **When in doubt, classify as Medium** — forge-plan can upgrade to Complex after reading the actual codebase, but starting too high adds unnecessary friction
