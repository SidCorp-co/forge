## Project settings & test credentials

Two tools, two different jobs — mixing them up is the single most common Forge discoverability miss.

- **`forge_projects.get`** — deployment-shaped facts: repo path, base/production branch, `workspaceSetup` (how to bring this repo's workspace to a buildable state), and `environments` — both sides of the deployment: `preview` (`{url, apiUrl, urls[]}`, or null where the project has no preview side), `live` (`{url, apiUrl, commitUrl, commitPath}` — the address a release ships to), `testCredentials` for logging in as a test user, and `limits`, which says what this environment does NOT have. This is the ONLY place test credentials live.
- **`forge_config`** — process-shaped facts: `pipelineConfig` (stage gates, status ladder overrides, and the per-stage model, budget and tool policy), `plugins`, categories. It carries no project PROSE — `projectFacts` and `projectFactsConfig` were retired in ISS-1048 and a call naming either is refused by name; the prose is `forge_knowledge`. It deliberately does **not** return credentials or preview URLs — don't go looking for them there, and don't add them there either.

  {{ALWAYS_INJECT_GUARANTEE_NOTE}} {{ALWAYS_INJECT_ENFORCEMENT_NOTE}}

### Rules
1. Never hardcode a repo path, branch name, or test credential in a skill body, prompt, or comment — always fetch it live. A hardcoded value silently drifts the moment the project's settings change.
2. Never echo a fetched credential past the immediate authentication step (into a commit message, a PR description, or tool output) — treat it as a secret even though it's a test account.
3. When you need to change `forge_config` (e.g. `pipelineConfig.states`), **GET the current config first, then send a complete entry.** These are nested maps — a blind partial write clobbers sibling keys you never read. A knowledge entry is not one of them: `forge_knowledge` writes one slug whole, so there are no siblings to clobber.
4. `environments.preview: null` means this project HAS no preview side — a one-box project saying so, not a setting somebody forgot. Test against `environments.live` and don't invent a staging host. Equally, an empty `environments.live.url` is not permission to guess one: nothing in Forge derives a hostname from another.
5. `workspaceSetup` is the project's own setup procedure — install commands, hook setup, toolchain quirks — and it is prose, not a script anything executes. It is what a stage follows instead of guessing when it lands in a broken checkout. **If it is empty and you worked the procedure out, write it back** with `forge_projects.update` (`workspaceSetup`), recording only steps you ran and saw succeed. Set it while onboarding a project, next to the repo URL — Settings → Runners → Git access in the UI.

### Common mistake this guide exists to prevent
An agent hits a login wall on a preview deploy, can't find credentials in `forge_config`, and either asks a human or gives up. The credentials were one tool call away, on `forge_projects.get`.

The same shape costs tokens rather than a stall: a stage lands in a checkout whose hooks are missing, works out the install procedure from the lockfile, fixes it, and says nothing. The next job on that project pays for the same derivation, and the one after that. `workspaceSetup` exists so that happens once.