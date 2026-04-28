# e2e-internal — maintainer-only specs

Playwright specs that don't run in the public CI (`e2e` job) because they need
maintainer-only state: a paired desktop runner, an admin user, or a deployed
staging environment with a populated DB.

## Specs

| File | Needs |
|---|---|
| `agent-chat-reply.spec.ts` | A paired desktop runner connected to core; assertions stream chat replies through the device |
| `light-mode-contrast.spec.ts` | The deployed staging build (default targets `https://stg-jarvis-a2.thejunix.com`); WCAG contrast assertions on the chat module |
| `pipeline-self-healing.spec.ts` | Admin user + at least one `pipeline_failed` issue in the DB; tests the manual-recover endpoint and the admin observability surface |

## Run locally (override defaults via env)

```bash
E2E_WEB_URL=https://my-staging.example.com \
E2E_ADMIN_EMAIL=admin@example.com \
E2E_ADMIN_PASSWORD=… \
pnpm --filter web e2e:internal
```

## Why split out

Public OSS contributors don't have access to the maintainer's staging or a
paired runner; running these specs against a clean local stack would always
fail. Keeping them out of `forge/web/e2e/` means `pnpm --filter web e2e` (the
default that CI runs) stays green for everyone.
