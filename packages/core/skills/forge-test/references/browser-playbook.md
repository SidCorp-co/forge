# Browser Playbook

Generic browser interaction patterns for QA testing. These are reusable techniques — NOT app-specific flows.

## Setup

```
1. tabs_context_mcp → get available tabs
2. tabs_create_mcp → create a fresh tab (don't reuse old tabs)
3. Store the tabId for all subsequent calls
```

## Login

```
1. navigate → {testUrl}/login
2. wait 2s
3. find → "Email input field" → triple_click → form_input "{username}"
4. find → "Password input field" → triple_click → form_input "{password}"
5. find → "Sign In button" → left_click
6. wait 3s → screenshot (verify dashboard)
```

Credentials come from `forge_config → get → previewDeploy.testCredentials`.

**Multi-role:** Login as Role A → test → navigate back to /login → Login as Role B → test same feature.

## Verify Element Visibility

**SHOULD be visible:** `find → "{description}"` → found = PASS, not found = FAIL + screenshot.

**Should NOT be visible:** `find → "{description}"` → found = FAIL, not found = PASS. Screenshot either way.

## Form Interaction

```
find → "{field}" → form_input value → find → "{submit}" → left_click → wait 2s → screenshot
```

## Dialog / Modal Handling

```
1. screenshot → capture dialog as evidence
2. find → "Cancel" or "Confirm" button → left_click
3. wait 2s → screenshot
```

## Override Browser Time

For day/time-dependent features:

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

Take at: after login, after navigation, at verification point, after action. Use `computer → zoom` with `region: [x0,y0,x1,y1]` for specific areas.

## General Rules

- Always `wait 2-3s` after navigation for SPA to load
- `triple_click` before `form_input` to clear pre-filled values
- Clock in/out and form submissions affect real data — be careful
- Use `javascript_tool` with async IIFE (no top-level await)
- Don't hardcode app-specific flows here — derive them from the issue plan at test time
