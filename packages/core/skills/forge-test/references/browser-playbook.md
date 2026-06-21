# Browser Playbook

Generic browser interaction patterns for QA testing. These are reusable techniques — NOT app-specific flows.

All steps below describe plain actions (navigate, click, fill a field, screenshot). Perform each one **using the available browser tools** — whatever browser-automation MCP the runner exposes (auto-detected; usually surfaced as `browser_*`). Do not hardcode a provider. If no browser MCP is available, fall back to curl/WebFetch HTML checks (see `test-approach.md`).

## Setup

```
1. list the open tabs using the available browser tools
2. open a fresh tab (don't reuse old tabs)
3. work in that tab for all subsequent steps
```

## Login

```
1. navigate → {testUrl}/login
2. wait 2s
3. fill the "Email" field with "{username}" (clear any pre-filled value first)
4. fill the "Password" field with "{password}" (clear any pre-filled value first)
5. click the "Sign In" button
6. wait 3s → screenshot (verify dashboard)
```

Credentials come from `forge_config → get → previewDeploy.testCredentials`.

**Multi-role:** Login as Role A → test → navigate back to /login → Login as Role B → test same feature.

## Verify Element Visibility

**SHOULD be visible:** locate "{description}" → found = PASS, not found = FAIL + screenshot.

**Should NOT be visible:** locate "{description}" → found = FAIL, not found = PASS. Screenshot either way.

## Form Interaction

```
fill "{field}" with value → click "{submit}" → wait 2s → screenshot
```

## Dialog / Modal Handling

```
1. screenshot → capture dialog as evidence
2. click "Cancel" or "Confirm" button
3. wait 2s → screenshot
```

## Override Browser Time

For day/time-dependent features, evaluate this in the page (if your browser tools support running JS in the page):

```javascript
const __RealDate = window._RealDate || Date;
window._RealDate = __RealDate;
const __fakeTime = new __RealDate('2026-03-14T16:35:00').getTime();
const FakeDate = new Proxy(__RealDate, {
  construct(target, args) {
    if (args.length === 0) return new target(__fakeTime);
    return new target(...args);
  },
  apply(target, thisArg, args) {
    if (args.length === 0) return new target(__fakeTime).toString();
    return target.apply(thisArg, args);
  },
  get(target, prop) {
    if (prop === 'now') return () => __fakeTime;
    if (prop === 'prototype') return target.prototype;
    return target[prop];
  }
});
window.Date = FakeDate;
```

Override BEFORE triggering the action. Reload page to restore real time.

## Inspect Deployed JS

```javascript
(async () => {
  const scripts = Array.from(document.querySelectorAll('script[src]')).map(s => s.src);
  for (const src of scripts) {
    const text = await (await fetch(src)).text();
    if (text.includes('TARGET')) return src.split('/').pop();
  }
  return 'not found';
})()
```

Keep return values small — large outputs get blocked.

## Screenshots

Take at: after login, after navigation, at verification point, after action. Zoom into a specific region when the browser tools support it, to capture small areas clearly.

## General Rules

- Always `wait 2-3s` after navigation for SPA to load
- Clear pre-filled values before typing into a field
- Clock in/out and form submissions affect real data — be careful
- When running JS in the page, use an async IIFE (no top-level await)
- Don't hardcode app-specific flows here — derive them from the issue plan at test time
