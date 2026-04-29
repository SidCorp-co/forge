# ADR 0016 — Defer glib 0.20 upgrade; accept transitive 0.18 with zero-exposure dismissal

**Status:** Accepted (2026-04-29)
**Related:** [GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g) (`glib::VariantStrIter` unsoundness), [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)

## Context

GitHub Dependabot flagged `glib v0.18.5` in `packages/dev/src-tauri/Cargo.lock` as vulnerable. The advisory:

- Range: `>= 0.15.0, < 0.20.0` — our pin is squarely inside.
- Surface: `VariantStrIter::impl_get` passes `&p` (immutable ref) where the C function `g_variant_get_child` mutates the pointer in-place. Recent rustc optimisations may discard those writes, leading to NULL-pointer dereferences when iterating GVariant string lists.
- Fix: `glib >= 0.20.0`.

`glib` reaches us transitively via Tauri 2.10's Linux webview stack:

```
forge-beta
  └─ tauri 2.10.3
       └─ tao + wry
            └─ webkit2gtk 2.0.2  (Linux webview backend)
                 └─ gtk 0.18.2 (host widget for the WebKit surface)
                      └─ gdk 0.18.2, glib 0.18.5, cairo-rs 0.18, pango 0.18  (transitive)
```

A direct `cargo update -p glib --precise 0.20` is not viable — the gtk-rs ecosystem (`gtk`, `gdk`, `cairo-rs`, `pango`, `webkit2gtk`) is locked to the 0.18 line by Tauri's pinned dependencies. Bumping `glib` alone breaks the API contract that `gtk 0.18` macros encode (subclassing types changed shape between 0.18 → 0.20).

## Decision

**Defer the glib upgrade.** Stay on the gtk-rs 0.18 line until Tauri's upstream stack moves. Dismiss the Dependabot alert as `tolerable_risk` with concrete zero-exposure evidence rather than papering it over.

### Why dismissing is correct here, not just convenient

A grep across the entire dependency surface for the vulnerable iterator shows zero callers:

| Crate | `VariantStrIter` references |
|---|---|
| Forge `packages/dev/src-tauri/src/` | 0 |
| `tauri 2.10.2`, `tauri 2.10.3` | 0 |
| `wry` (latest) | 0 |
| `webkit2gtk 2.0.2` | 0 |
| `gtk 0.18.2` | 0 |
| `gdk 0.18.2` | 0 |
| `glib 0.18.5` itself | 3 (the implementation files; no caller) |

The vulnerable code is dead weight in our binary. Forge does not iterate GVariant string lists; nothing in Tauri's Linux backend does either. The exploit path requires application code to call `VariantStrIter::next` on attacker-controlled data — that surface does not exist in our build.

This argument is auditable: re-running the grep on a future Cargo.lock will show whether anything new in the chain starts to call `VariantStrIter`.

### Why not patch override

`[patch.crates-io]` forcing `glib = "0.20"` was considered. Estimated outcome: compile failure ≈95% because `gtk 0.18`'s `glib::wrapper!` macros expect 0.18 trait shapes (`ObjectExt`, `IsA`, etc.). Not worth the build break for a vulnerability we already proved unreachable.

### Why not switch backend

Tauri 2.x's only Linux webview is webkit2gtk via the gtk-rs 0.18 stack. There is no `tao`/`wry` backend that bypasses gtk on Linux. Switching backends is outside the scope of a security patch.

## Consequences

### Positive

- No build breakage, no Tauri major-version chase, no risky `[patch.crates-io]` experiment.
- Dismissal is evidence-based, not "trust me" — anyone can re-run the grep.

### Negative

- The alert stays in the Dependabot dashboard as `dismissed (tolerable_risk)`, not `fixed`. Visible to anyone auditing the security tab.
- A future contributor who genuinely starts using `glib::Variant`-shaped APIs (e.g., to talk to D-Bus via gio) reintroduces exposure without any automatic re-flag. Mitigated by the re-evaluation conditions below.

### Conditions to re-evaluate

Any of the following triggers a fresh look at this decision:

1. **Tauri bumps gtk-rs to 0.20+** — track:
   - Tauri main: [`crates/tauri/Cargo.toml`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/Cargo.toml) — currently pins `gtk = { version = "0.18" }`.
   - wry main: [`Cargo.toml`](https://github.com/tauri-apps/wry/blob/dev/Cargo.toml) — currently pins `gtk = "0.18"`, `webkit2gtk = "=2.0.2"`.
   - muda: [issue #259](https://github.com/tauri-apps/muda/issues/259) (gtk-4 migration, open since 2024-12, no recent activity).

2. **glib 0.18 gets a backport patch** for `VariantStrIter` — would close the alert at the current pin without an ecosystem move. Watch: [gtk-rs/gtk-rs-core releases](https://github.com/gtk-rs/gtk-rs-core/releases) for any `glib-0.18.*` patch tag.

3. **Forge code starts using GVariant** — the grep above starts returning matches. The `pre-push` hook should grow a guard for this; not adding it today because the surface is currently zero.

4. **A higher-severity advisory in the same chain** (gtk/gdk/webkit2gtk) — would force a Tauri bump regardless and would solve glib as a side effect.

## Notes

- The dismissal comment on alert #236 carries a one-line summary of this evidence; this ADR is the long form.
- `rand 0.7.3 + 0.8.5` (alert #243) was dismissed under similar reasoning — build-time-only via `phf_generator → kuchikiki → tauri-utils`, no runtime exposure of the soundness pattern. Not worth its own ADR.
- This is the second deferral pattern documented in this repo (after [ADR 0009](0009-mobile-app-paused-for-v0x.md) pausing the mobile app). The shape is consistent: name the trigger conditions explicitly so deferrals don't quietly become permanent.
