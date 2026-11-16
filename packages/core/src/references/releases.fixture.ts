// Real release notes the follow pass filed wrongly or rightly on forge-dev (ISS-1252, the pass of
// 2026-11-16 and the one after it), the first part of each as published, and forge's open items they
// were read against. The orca and Claude Code notes share words with REQ-89 and ISS-1070 (chat, check,
// load, shell, wait) and help neither; coolify v4.7.0 cancels older queued webhook deploys, which
// ISS-1082 asks for in part.

import type { OpenItem } from './match.js';

export const RELEASE_NOTES = {
  orca: {
    name: '1.4.255',
    url: 'https://github.com/stablyai/orca/releases/tag/v1.4.255',
    body: '## Faster session search, agents on your phone & smoother chat switching ✨\n\nWe shipped two releases in quick succession: 1.4.254 yesterday and 1.4.255 today. See the [1.4.254 release notes](https://github.com/stablyai/orca/releases/tag/v1.4.254) for Git Graph, chat forks, on-device phone dictation, more resilient mobile work, and pairing and trust improvements.\n\nA little less waiting, a little more flow. This update makes large session histories easier to search, brings your agents together on your phone, and smooths out the everyday work of switching accounts, models and workspaces.\n\n- ⚡ **Find past work without slowing down:** Session History searches run off the app’s main thread, keep results visible while you type, and show your last list immediately after a restart while it refreshes. Search also works on SSH and remote-server hosts.\n- 📱 **Your agents, together on your phone:** A new Agents tab lists agents across your connected desktops. Mark them read or clear them from the list, with activity status supplied by the desktop. Saved task lists and host labels appear sooner when you reopen the app.\n- 💬 **Keep your chat moving:** Switching Codex accounts moves your open Codex c',
  },
  claudeCode: {
    name: 'v2.1.323',
    url: 'https://github.com/anthropics/claude-code/releases/tag/v2.1.323',
    body: "## What's changed\n\n- Added Code Mode, an experimental opt-in in which Claude writes JavaScript to call its tools; see https://code.claude.com/docs/en/code-mode to turn it on, or to turn it off for an organization\n- Added `engines[\"claude-code\"]` to `plugin.json`: plugins outside their stated Claude Code version range are not installed, updated or loaded, and install and update pick the newest version that fits\n- Added type checking of a plugin's TypeScript hooks module to `claude plugin validate`; each finding is a warning, and `--strict` fails on it\n- Added to `claude plugin validate` the `$` nouns a mod's `engine.create` hook adds, withholds or replaces\n- Added support for `CLAUDE_CODE_AUTO_MODE_MODEL` in managed settings for Claude Desktop sessions on third-party providers (takes effect once Claude Desktop includes this version)\n- Added an options menu (stop, switch to usage credits, upgrade) when a model needs usage credits that are turned off or used up\n- Added a progress heartbeat every 30 seconds while hooks run long in `claude -p` and SDK sessions, so a host such as Claude Desktop won't end the turn as hung (once it includes this version)\n- Added `.docx` support to Artifact",
  },
  coolify: {
    name: 'v4.7.0',
    url: 'https://github.com/coollabsio/coolify/releases/tag/v4.7.0',
    body: '## Breaking Changes\n\n- Cancelled the older queued webhook deployments of an application by default when a newer push arrives, so only the latest commit is built ([#10921](https://github.com/coollabsio/coolify/discussions/10921), [#7678](https://github.com/coollabsio/coolify/discussions/7678))\n  - It works per application, pull request and server\n  - `Advanced` > `Deployment` and `is_auto_cancel_queued_deployments_enabled` in the applications API turn it off\n  - Manual, API, restart and rollback deployments are never cancelled\n  - An opt-in setting, `is_auto_cancel_building_deployments_enabled` in the API, also stops an older webhook deployment that is still building, a deployment that started to replace containers always finishes\n  - `cancel_previous` (`none`, `queued` or `building`) on `/api/v1/deploy` and the MCP `deploy` tool cancels the older webhook, API and MCP deployments, the default is `none`\n- Limited the cloud provider token API to team admins and owners\n  - Other members get `403`\n- Moved the Resend sender to the new `resend_from_address` and `resend_from_name` fields, API clients must use the new fields\n  - A migration copies the current values\n\n## Security\n\n- Applied ',
  },
} as const;

/** Forge's open items as the follow pass read them, by their live titles. */
export const FORGE_OPEN_ITEMS: OpenItem[] = [
  {
    kind: 'requirement',
    id: 'r-89',
    ref: 'REQ-89',
    title:
      'Memory and knowledge are curated: one current, typed, scoped entry per subject, re-checked when the system changes',
    areas: [],
  },
  {
    kind: 'issue',
    id: 'i-1070',
    ref: 'ISS-1070',
    title:
      'The app shell loads attention, releases and needs-you on every route, so each screen waits 4–12 s',
    areas: ['web'],
  },
  {
    kind: 'issue',
    id: 'i-1082',
    ref: 'ISS-1082',
    title:
      'forge-dev deploys as a docker-compose Coolify app, which Coolify recreates rather than rolls, so every push to dev takes the API down for the rollout',
    areas: ['release-deploy'],
  },
];
