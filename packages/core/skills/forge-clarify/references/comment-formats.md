# Clarify comment formats

Pick the template matching the outcome. Always include the **Confidence** line (see the skill's confidence gate) and, for features, the restated **Intent**. Write in English regardless of the issue language.

## Bug — Reproduced

```markdown
**Clarify** — Reproduced: <one-line summary>
**Confidence:** <≈85%+>

**Environment:** <URL / surface tested>
**Reproduced:** Yes

**Steps Verified:**
1. <step> → ✅ <observation>
2. <step> → ❌ <error/unexpected behavior>

**Root Cause Hypothesis:** <what the code-level issue likely is>
**Evidence:** <screenshots / API response / data row>
```

→ Status: `clarified`

## Bug — Cannot Reproduce

```markdown
**Clarify** — Could not reproduce: <one-line summary>
**Confidence:** <0–100%>

**Environment:** <URL / surface tested>
**Reproduced:** No

**Attempted:**
1. <step> → <what happened instead>

**Questions (each with my best guess):**
- <specific question about environment / data / user role / timing> — my assumption: <guess>
```

→ Status: `needs_info`

## Feature — Clear

```markdown
**Clarify** — UX validated: <one-line summary>
**Confidence:** <≈85%+>

**Intent (restated):**
- Outcome: <…> · User/role: <…> · Why now: <…>
- Success: <…> · Constraint: <…> · Out of scope: <…>

**Current State:** <what exists now>
**Desired State:** <what should change, from issue description>
**Existing Patterns:** <similar UI/API patterns already in the app the change should match>
**UX surface to build:** <expected empty / loading / error states the QA gate will check>
**Evidence:** <screenshots / API baseline of current state>
```

→ Status: `clarified`

## Feature — Ambiguous

```markdown
**Clarify** — UX ambiguous: <one-line summary>
**Confidence:** <below bar>

**Intent (restated, with gaps):**
- Outcome: <…> · User/role: <…?> · Success: <…?> · Constraint: <…> · Out of scope: <…>

**Current State:** <what exists now>
**Ambiguities (each with my best guess):**
- <specific question about desired behavior/appearance> — my assumption: <guess>
```

→ Status: `needs_info`

## Auto-Skip (Simple)

```markdown
**Clarify** — Auto-clarified (Simple issue, no verification needed)
```
