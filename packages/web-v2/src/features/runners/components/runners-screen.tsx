"use client";

import { useState } from "react";
import {
  Banner,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  HealthDot,
  HelpButton,
  Icon,
  Input,
  MonoTag,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/design";
import { useAuth } from "@/providers/auth-provider";
import { formatApiError } from "@/lib/api/error";
import { userRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useDevices, useInitPairing, useRevokeDevice } from "../hooks";
import { deviceHealth, type DeviceRow } from "../types";
import { DeviceDetail } from "./device-detail";

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={copied ? "check" : "link"}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

/** Pairing panel — the CLI command + an optional generated code & verify link. */
function PairPanel() {
  const init = useInitPairing();
  const [label, setLabel] = useState("forge-runner");
  const code = init.data;
  const verifyUrl = code
    ? `${typeof window !== "undefined" ? window.location.origin : ""}${code.verify_url}`
    : "";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pair a device</CardTitle>
        <HelpButton
          summary="Pair a headless runner with your account using a browser-approved device login (like `claude login`). Run the CLI command on the runner machine — it opens this site to approve, then writes a device-scoped token locally."
          actions={[
            "Run `forge-runner login` on the runner host (opens the browser to approve)",
            "Or generate a code here and approve it at /pair",
            "Revoke a device below to cut off its access immediately",
          ]}
        />
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="fg-label">Recommended — run on the runner machine</span>
            <div className="flex items-center justify-between gap-2 rounded-md border border-line bg-sunken px-3 py-2">
              <code className="font-mono text-[13px] text-fg">forge-runner login</code>
              <CopyButton value="forge-runner login" />
            </div>
            <p className="fg-body-sm text-subtle">
              It opens a browser to approve the device, then provisions a device token (and a git
              push credential when the server has it enabled).
            </p>
          </div>

          <div className="border-t border-line-subtle pt-4">
            <span className="fg-label">Or generate a pairing code to approve manually</span>
            <div className="mt-2 flex items-end gap-2">
              <div className="flex-1">
                <Input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Device label"
                  aria-label="Device label"
                />
              </div>
              <Button
                variant="secondary"
                icon="plus"
                loading={init.isPending}
                onClick={() => init.mutate(label.trim() || "forge-runner")}
              >
                Generate code
              </Button>
            </div>

            {code && (
              <div className="mt-3 flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
                <div className="flex items-center justify-center rounded-md border border-line bg-sunken py-3">
                  <span className="font-mono text-xl font-semibold tracking-[0.25em] text-fg">
                    {code.pairing_code}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="fg-body-sm text-muted">Approve at</span>
                  <a
                    href={code.verify_url}
                    className="truncate font-mono text-[12.5px] text-accent hover:underline"
                  >
                    {verifyUrl || code.verify_url}
                  </a>
                  <CopyButton value={verifyUrl || code.verify_url} />
                </div>
                <p className="fg-body-sm text-subtle">
                  Open the link (or scan it) on the device, approve, then the runner&apos;s poll
                  loop receives the token. Expires{" "}
                  {new Date(code.expires_at).toLocaleTimeString()}.
                </p>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function RunnersScreen() {
  const { user } = useAuth();
  // Live pending→approved + revoke ride the owner's user room.
  useRoom(user?.id ? userRoom(user.id) : null);
  const devices = useDevices();
  const revoke = useRevokeDevice();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const rows: DeviceRow[] = devices.data ?? [];
  // Re-derive from the live list so rename/status updates reflect in the open panel.
  const detailDevice = rows.find((d) => d.id === detailId) ?? null;

  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-5 px-6 py-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="fg-h2">Runners &amp; devices</h1>
          <p className="fg-body-sm text-muted">
            Paired devices that can run pipeline jobs. Status updates live.
          </p>
        </div>
        <HelpButton
          summary="Each device is a machine running the forge-runner agent. Pair new devices with a browser-approved login, watch their online status live, and revoke access when a device is retired."
          actions={[
            "Pair a device — start the browser-approve login flow",
            "Revoke — cut off a device's token and unbind its runners",
          ]}
          docPath="docs/guides/runners.md"
        />
      </div>

      <PairPanel />

      <Card>
        <CardHeader>
          <CardTitle>Devices</CardTitle>
        </CardHeader>
        <CardContent>
          {devices.isLoading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : devices.isError ? (
            <ErrorState message={formatApiError(devices.error)} onRetry={() => devices.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No devices yet"
              message="Pair your first runner with the command above to start accepting jobs."
              mascot={false}
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Device</TH>
                  <TH>Status</TH>
                  <TH>Platform</TH>
                  <TH>Git push</TH>
                  <TH>Last seen</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((d) => {
                  const revoked = d.status === "revoked";
                  return (
                    <TR key={d.id}>
                      <TD>
                        <div className="flex flex-col">
                          <span className="font-semibold text-fg">{d.name}</span>
                          {d.agentVersion && (
                            <span className="fg-body-sm text-subtle">
                              v{d.agentVersion}
                              {d.agentOutdated && (
                                <span
                                  className="ml-1.5 inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-900/40"
                                  title={
                                    d.latestAgentVersion
                                      ? `Update pending — latest is v${d.latestAgentVersion}`
                                      : "Update pending"
                                  }
                                >
                                  update pending
                                </span>
                              )}
                            </span>
                          )}
                        </div>
                      </TD>
                      <TD>
                        <HealthDot health={deviceHealth(d.status)} />
                      </TD>
                      <TD>
                        <MonoTag>{d.platform}</MonoTag>
                      </TD>
                      <TD>
                        {d.gitCredentialRef ? (
                          <span className="inline-flex items-center gap-1.5 text-[13px] text-fg">
                            <Icon name="check" size={14} className="text-[color:var(--green-600)]" />
                            provisioned
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-[13px] text-subtle">
                            <Icon name="dot" size={14} />
                            none
                          </span>
                        )}
                      </TD>
                      <TD>
                        <span className="text-muted">{relativeTime(d.lastSeenAt)}</span>
                      </TD>
                      <TD className="text-right">
                        {confirmId === d.id ? (
                          <span className="inline-flex items-center gap-2">
                            <Button
                              variant="danger"
                              size="sm"
                              icon="trash"
                              loading={revoke.isPending}
                              onClick={() => {
                                revoke.mutate(d.id);
                                setConfirmId(null);
                              }}
                            >
                              Confirm
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setConfirmId(null)}>
                              Cancel
                            </Button>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              icon="settings"
                              onClick={() => setDetailId(d.id)}
                            >
                              Manage
                            </Button>
                            {!revoked && (
                              <Button
                                variant="ghost"
                                size="sm"
                                icon="trash"
                                onClick={() => setConfirmId(d.id)}
                              >
                                Revoke
                              </Button>
                            )}
                          </span>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Banner tone="info">
        Revoking requires a recent sign-in. If revoke fails with an auth error, re-authenticate in
        Settings and try again.
      </Banner>

      <DeviceDetail device={detailDevice} onClose={() => setDetailId(null)} />
    </div>
  );
}
