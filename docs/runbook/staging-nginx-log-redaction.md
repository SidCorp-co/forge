# Staging nginx — redact `?token=` from access log

ISS-286. The `/ws` upgrade now reads its bearer JWT from
`Sec-WebSocket-Protocol: forge.bearer.<jwt>`. The legacy `?token=<jwt>`
query path is still accepted while `wsLegacyTokenAuth=true` so older
clients keep working during the soak window. Until the legacy path is
removed, the staging nginx access log MUST scrub the `token` query
param so the JWT never lands on disk.

## What to change

On `root@165.22.96.128`, edit the nginx vhost serving
`stg-jarvis-a2.thejunix.com`:

```nginx
# inside the relevant `server { ... }` block — applied per request before
# the access_log directive evaluates $request / $request_uri.
set $clean_request_uri $request_uri;
if ($clean_request_uri ~ "^(.*[?&])token=[^&]*(.*)$") {
  set $clean_request_uri "$1token=REDACTED$2";
}

log_format forge_redacted '$remote_addr - $remote_user [$time_local] '
                         '"$request_method $clean_request_uri $server_protocol" '
                         '$status $body_bytes_sent "$http_referer" '
                         '"$http_user_agent"';

access_log /var/log/nginx/forge-stg-access.log forge_redacted;
```

Reload: `nginx -t && systemctl reload nginx`.

## Verify

```bash
# Trigger a connect that uses the legacy path:
curl -sI "https://stg-jarvis-a2.thejunix.com/ws?token=hunter2" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Version: 13" || true

# Tail the log and confirm the value is masked:
tail -1 /var/log/nginx/forge-stg-access.log
# expected: ... "GET /ws?token=REDACTED HTTP/1.1" 401 ...
```

## Rollback / removal

After `wsLegacyTokenAuth=false` ships and the query-token branch is
removed from `forge/core/src/ws/server.ts`, this redaction is no longer
strictly required (no client should be sending `?token=`). Keep it
anyway as defense-in-depth.
