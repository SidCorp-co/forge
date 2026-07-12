# Pass-B quality checklist (UI/UX & accessibility)

Run over **each screen the issue adds or modifies** — not the whole app. Every box is a potential FAIL row. The bar is "would a user accept this", not "does the element render". Match the app's existing patterns; when unsure, copy what comparable screens already do rather than inventing.

## Expectation-first — run this BEFORE ticking the dimensions

1. **Persona & goal** — from the acceptance criteria, who is using this screen and what job are they trying to finish?
2. **Predict before observing** — for each step of the flow (entry / action / result / error / empty), write down what that persona expects to see or be able to do BEFORE you look at the actual screen.
3. **Walk & compare** — drive the flow, then compare what you saw against the prediction. Every mismatch is a candidate finding.
4. **Adversarial pass** — ask "what's one thing this persona would also want here that isn't covered by the acceptance criteria?" (undo, confirmation, a way back, feedback that the action worked).
5. **Frame each finding** as `Expectation → Observation → user impact → severity → concrete fix` — not just "this looks off".

Then run the dimensions below as the lens for where to look. Judge each against what the persona expects, not mere presence.

**1. Functional integrity**
- No console errors during the flow; no broken/overlapping/clipped layout; no missing styles or blank sections.

**2. Responsive** (re-run the flow at each width)
- Narrow ~375px: single column, no horizontal scroll, primary actions reachable.
- Medium ~768px and wide ~1280px+: layout adapts, content uses space sensibly, lines readable.
- Tap/click targets not tiny or overlapping on narrow.

**3. States** (exercise, don't assume)
- Empty: meaningful empty state (message + next action), not a blank box or lone spinner.
- Loading: visible indication, no frozen page, minimal layout shift when data lands.
- Error: human message + a way to recover (retry/dismiss), never a silent failure or raw stack.
- Form validation: inline, near the field, at/before submit — not only a generic toast.

**4. Accessibility (WCAG 2.1 AA, scoped to the change)**
- Keyboard: every new interactive element reachable via Tab and operable with Enter/Space; logical, visible focus.
- Focus management: dialogs/menus trap focus on open and restore it on close.
- Labels: icon-only buttons have an accessible name; every input has a label.
- Status regions announced (`role="status"`/`aria-live`); contrast ~4.5:1 (3:1 large); state never by colour alone.

**5. Role / tenant correctness** (if the project has roles/tenants)
- Re-check each affected screen as each role in scope: controls a role may not use are hidden/disabled, not merely unenforced.
- No other tenant's/user's data appears anywhere on the screen (lists, dropdowns, counts, autocomplete).

**6. Design consistency (anti-"generic placeholder")**
- Spacing/typography/colour use existing scale/tokens — no ad-hoc values or one-off styles.
- New components match comparable existing ones; heading hierarchy not skipped/faked.
- No unintended "AI default" tells: stray purple/indigo gradients, oversized uniform padding, heavy layered shadows, generic hero blocks unrelated to content.

For each problem, add a report row tagged `UX`/`A11y`/`Responsive` with the **specific** observation (what, where, which width/state/role) so forge-fix can act without rediscovering it; attach a screenshot of visual failures. Summarise clean dimensions in one line in the Verification section — don't pad the table with green rows for untouched surfaces.
