"use client";

import { useState } from "react";
import { formatRelativeTime } from "@/lib/utils/format";
import {
  Button,
  PageSection,
  PageSectionBody,
  PageSectionHeader,
  PageSectionTitle,
  EmptyState,
  ErrorState,
  HealthDot,
  HelpButton,
  Icon,
  EnumBadge,
  PageContainer,
  PageTitle,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/design";
import { useAuth } from "@/providers/auth-provider";
import { useActiveOrg } from "@/features/orgs/active-org";
import { formatApiError } from "@/lib/api/error";
import { userRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useDevices, useOrgDevices, useSetDeviceDisabled } from "../hooks";
import { RevokeDeviceControl } from "./revoke-device-control";
import {
  deviceBinariesRead,
  deviceBuildChip,
  deviceHealth,
  deviceVersionLabel,
  type DeviceRow,
  type OrgDeviceRow,
} from "../types";
import {
  assignmentBridgeLine,
  type DeviceCount,
  type DeviceScope,
  emptyState,
  populationLine,
  rowActionNote,
  SCOPES,
  scopeCountLabel,
  scopeName,
  UNKNOWN_COUNT,
} from "../scope";
import { BuildChip, DeviceDetail } from "./device-detail";
import { TopBarActions } from "@/design/primitives/top-bar-slot";

export function CopyButton({ value }: { value: string }) {
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

/** Pairing panel — the CLI command the runner machine runs; it prints the code approved at /pair. */
function PairPanel() {
  return (
    <PageSection>
      <PageSectionHeader>
        <PageSectionTitle>Pair a device</PageSectionTitle>
        <HelpButton
          summary="Pair a headless runner with your account using a browser-approved device login (like `claude login`). Run the CLI command on the runner machine — it prints a code to approve here, then writes a device-scoped token locally."
          actions={[
            "Run `forge-runner setup` on the runner host (it prints the approval URL)",
            "Revoke a device below to cut off its access immediately",
          ]}
        />
      </PageSectionHeader>
      <PageSectionBody>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="fg-label">Run on the runner machine</span>
            <div className="flex items-center justify-between gap-2 rounded-md border border-line bg-sunken px-3 py-2">
              <code className="font-mono text-13 text-fg">forge-runner setup</code>
              <CopyButton value="forge-runner setup" />
            </div>
            <p className="fg-body-sm text-subtle">
              It checks the machine can run a job, prints an approval URL, waits for you to assign
              it a project, gets a checkout, installs the background service, and ends on a
              verdict. `forge-runner login` does the pairing step alone.
            </p>
          </div>
        </div>
      </PageSectionBody>
    </PageSection>
  );
}

/** Both populations and both counts, visible at once, so a zero in one of them reads as a fact. */
function ScopeTabs({
  scope,
  counts,
  onChange,
}: {
  scope: DeviceScope;
  counts: Record<DeviceScope, DeviceCount>;
  onChange: (next: DeviceScope) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-line bg-sunken p-0.5">
      {SCOPES.map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={scope === s}
          onClick={() => onChange(s)}
          className={
            scope === s
              ? "rounded px-3 py-1 text-13 font-medium text-fg bg-surface shadow-sm"
              : "rounded px-3 py-1 text-13 text-muted hover:text-fg"
          }
        >
          {scopeName(s)} · {scopeCountLabel(counts[s])}
        </button>
      ))}
    </div>
  );
}

/**
 * The device's name, its version line, and — on the org list — whose box it is
 * and which of this org's projects it serves. A runner IS one (device, project)
 * binding, so the bindings have to be on the row or the org's runners are not
 * reachable from the device list at all (ISS-1162).
 */
function DeviceNameCell({ device }: { device: DeviceRow | OrgDeviceRow }) {
  const chip = deviceBuildChip(device);
  const projects = "projectNames" in device ? device.projectNames : null;
  const missing = "binaries" in device ? deviceBinariesRead(device.binaries).missing : [];
  return (
    <div className="flex flex-col">
      <span className="font-semibold text-fg">
        {device.name}
        {device.ownedByMe ? null : (
          <span className="ml-1.5 inline-flex items-center rounded px-1.5 py-0.5 text-11 font-medium text-muted bg-sunken">
            paired by another member
          </span>
        )}
      </span>
      {/* Always a version line: a device that has reported nothing says so,
          because a blank one reads as a device with nothing to say (ISS-1119). */}
      <span className="fg-body-sm text-subtle">
        {deviceVersionLabel(device.agentVersion)}
        {chip ? <BuildChip chip={chip} className="ml-1.5 " /> : null}
      </span>
      {projects && projects.length > 0 ? (
        <span className="fg-body-sm text-subtle">Serves {projects.join(", ")}</span>
      ) : null}
      {missing.length > 0 ? (
        <span className="fg-body-sm text-amber-700 dark:text-amber-300">
          Panes cannot resolve {missing.map((m) => m.name).join(", ")}
        </span>
      ) : null}
    </div>
  );
}

export function RunnersScreen() {
  const { user } = useAuth();
  // Live pending→approved + revoke ride the owner's user room.
  useRoom(user?.id ? userRoom(user.id) : null);
  const { activeOrgId } = useActiveOrg();
  // ISS-1162 — two populations, read separately and counted on screen together.
  // `useDevices()` takes no org argument on purpose: a just-paired device has no
  // runner row, so under an org filter it appeared on no screen in the app.
  const mine = useDevices();
  const org = useOrgDevices(activeOrgId);
  const [scope, setScope] = useState<DeviceScope>("mine");
  const toggleDisabled = useSetDeviceDisabled();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  // A query that has not answered is UNKNOWN, never zero: rendering an unanswered
  // count as 0 is the misreading this whole screen change exists to remove.
  const counts: Record<DeviceScope, DeviceCount> = {
    mine: mine.isSuccess ? mine.data.length : UNKNOWN_COUNT,
    org: org.isSuccess ? org.data.length : UNKNOWN_COUNT,
  };
  const assignments: DeviceCount = org.isSuccess
    ? org.data.reduce((n, d) => n + d.runnerCount, 0)
    : UNKNOWN_COUNT;
  const bridge = scope === "org" ? assignmentBridgeLine(counts.org, assignments) : null;

  const active = scope === "mine" ? mine : org;
  const rows: Array<DeviceRow | OrgDeviceRow> = active.data ?? [];
  // Read off the owner list, not the visible one: Manage is offered in the own
  // scope alone, and re-deriving here keeps rename and status live in the panel.
  const detailDevice = mine.data?.find((d) => d.id === detailId) ?? null;
  const empty = emptyState(scope, counts);

  return (
    <PageContainer className="flex flex-col gap-5">
      <PageTitle hint="Paired devices that can run pipeline jobs. Status updates live.">
          Runners &amp; devices
      </PageTitle>
      <TopBarActions>
        <HelpButton
          summary="Each device is a machine running the forge-runner agent. Pair new devices with a browser-approved login, watch their online status live, turn a device off to park it, or revoke access when a device is retired."
          actions={[
            "Mine — every device you paired, whether or not it serves a project",
            "Organisation — every device assigned to a project you can see here, whoever paired it",
            "Turn off, revoke and rename are the device owner's alone",
          ]}
          docPath="pair-a-runner"
        />
      </TopBarActions>

      <PairPanel />

      <PageSection>
        <PageSectionHeader>
          <PageSectionTitle>Devices</PageSectionTitle>
          <ScopeTabs scope={scope} counts={counts} onChange={setScope} />
        </PageSectionHeader>
        <PageSectionBody>
          <p className="mb-3 fg-body-sm text-muted">
            {populationLine(scope)}
            {bridge ? ` ${bridge}` : null}
          </p>
          {active.isError ? (
            <ErrorState message={formatApiError(active.error)} onRetry={() => active.refetch()} />
          ) : /* Not `isLoading`: with no active org yet the org query is disabled,
                which is pending and NOT loading, and an empty-state sentence
                reached that way claims a population nothing asked for. */
          !active.isSuccess ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState title={empty.title} message={empty.message} mascot={false} />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Device</TH>
                  <TH>Status</TH>
                  <TH>Platform</TH>
                  <TH>Last seen</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((d) => {
                  const revoked = d.status === "revoked";
                  const disabled = !!d.disabledAt;
                  const actionNote = rowActionNote(scope, d.ownedByMe);
                  return (
                    <TR key={d.id}>
                      <TD>
                        <DeviceNameCell device={d} />
                      </TD>
                      <TD>
                        {disabled ? (
                          <span
                            className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-12 font-medium text-muted bg-sunken"
                            title="Turned off — ignored by every project until turned back on"
                          >
                            <Icon name="pause" size={12} />
                            Off
                          </span>
                        ) : (
                          <HealthDot health={deviceHealth(d.status)} />
                        )}
                      </TD>
                      <TD>
                        <EnumBadge family="platform" value={d.platform} />
                      </TD>
                      <TD>
                        <span className="text-muted">{formatRelativeTime(d.lastSeenAt, { emptyLabel: "never" })}</span>
                      </TD>
                      <TD className="text-right">
                        {actionNote !== null ? (
                          <span className="fg-body-sm text-subtle">{actionNote}</span>
                        ) : confirmId === d.id ? (
                          <RevokeDeviceControl
                            deviceId={d.id}
                            deviceName={d.name}
                            onDone={() => setConfirmId(null)}
                          />
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
                              <>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  icon={disabled ? "play" : "pause"}
                                  loading={toggleDisabled.isPending && togglingId === d.id}
                                  title={
                                    disabled
                                      ? "Turn on — let every project dispatch to this device again"
                                      : "Turn off — ignore this device across every project (reversible, keeps it paired)"
                                  }
                                  onClick={() => {
                                    setTogglingId(d.id);
                                    toggleDisabled.mutate({ id: d.id, disabled: !disabled });
                                  }}
                                >
                                  {disabled ? "Turn on" : "Turn off"}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  icon="trash"
                                  onClick={() => setConfirmId(d.id)}
                                >
                                  Revoke
                                </Button>
                              </>
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
        </PageSectionBody>
      </PageSection>

      <DeviceDetail device={detailDevice} onClose={() => setDetailId(null)} />
    </PageContainer>
  );
}
