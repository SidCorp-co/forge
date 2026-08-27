# Bundled autonomous skills

Source of truth for the skill set embedded in the `forge-runner` binary. `build.rs` walks this
directory and `include_str!`s every `.md` under it, so the inventory is `ls -d */` — adding a
directory is the entire change, and a file added here cannot be missing at runtime.

These serve the **autonomous** pipeline mode. The staged pipeline's skills are unrelated and live in
[`packages/core/skills/`](../../core/skills/), seeded into the `skills` table on server start; both
sets exist in this repo at once, on purpose. Design:
[`docs/proposals/agent-driven-pipeline.md`](../../../docs/proposals/agent-driven-pipeline.md).

Being embedded is what makes a skill change and the code it depends on land in the same PR — the
property the previous channel (a separate marketplace repo) could not offer.

## Frontmatter

| Key | Meaning |
|---|---|
| `name` | must equal the directory name |
| `description` | the routing key — Claude reads only this and `name` until the skill is invoked, so write the triggers into it |
| `survives_kill_switch` | `true` ⇒ `[skills] bundled_disabled` does not switch this one off |
| `user_invocable` | `false` for pipeline skills; they are driven, not typed |

## Kill switch

`~/.config/forge-runner/config.toml`:

```toml
[skills]
bundled_disabled = true                    # stop the whole set
bundled_overrides = { forge-plan = false } # or just one; wins over the line above either way
```

The switch exists so a bad skill release is stopped from config instead of by cutting a new binary.
`forge-drive` and `forge-review` declare `survives_kill_switch` because a pipeline that loses its
driver or its independent review is not degraded, it is unsafe.

## Extraction

At daemon start into `~/.local/share/forge-runner/bundled-skills/<runner version>/`, then
`seed_into` copies the set into each `drive` job's worktree (`runner/claude_code.rs`). Only a
`drive` job gets it: `packages/core/src/skills/lock.ts` refuses a project skill that would shadow a
bundled name, which is what makes seeding at job start safe here when it was not for the staged
lanes.
