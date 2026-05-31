"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Banner,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  HelpButton,
  Icon,
  MonoTag,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useApproveDevice } from "../hooks";

/**
 * `/pair` — the browser approval step of the runner device-login flow. The CLI
 * (`forge-runner login`) opens this page with `?code=XXX`; the signed-in user
 * confirms, binding the pending device-login code to their account. After
 * approval the CLI's poll loop receives the device token.
 */
export function PairScreen() {
  const params = useSearchParams();
  const code = params.get("code")?.trim() ?? "";
  const approve = useApproveDevice();
  const [denied, setDenied] = useState(false);

  const approved = approve.data?.approved === true;

  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-4 px-6 py-8">
      <div className="flex items-center justify-between gap-3">
        <h1 className="fg-h2">Approve a device</h1>
        <HelpButton
          summary="A device running `forge-runner login` is asking to pair with your account. Confirm the code matches what the CLI printed, then approve. Approving mints a device-scoped token the runner uses to accept jobs."
          actions={[
            "Approve — bind this pairing code to your account",
            "Deny — ignore the request (the code expires on its own)",
          ]}
        />
      </div>

      {!code ? (
        <Card>
          <CardContent>
            <EmptyState
              title="No pairing code"
              message="Open this page from the link printed by `forge-runner login`, or paste a code into the CLI."
            />
          </CardContent>
        </Card>
      ) : approved ? (
        <Card>
          <CardHeader>
            <CardTitle>Device approved</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-3">
              <Banner tone="success">
                Return to your terminal — the runner will finish pairing automatically.
              </Banner>
              {approve.data?.device && (
                <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-1.5 text-[13px]">
                  <dt className="text-muted">Label</dt>
                  <dd className="text-fg">{approve.data.device.label}</dd>
                  <dt className="text-muted">Platform</dt>
                  <dd className="text-fg">{approve.data.device.platform}</dd>
                  {approve.data.device.hostname && (
                    <>
                      <dt className="text-muted">Hostname</dt>
                      <dd className="text-fg">{approve.data.device.hostname}</dd>
                    </>
                  )}
                </dl>
              )}
            </div>
          </CardContent>
        </Card>
      ) : denied ? (
        <Card>
          <CardContent>
            <EmptyState
              title="Request denied"
              message="The pairing code was not approved. It will expire on its own. You can close this tab."
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Pairing request</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4">
              <p className="fg-body-sm text-muted">
                Confirm this code matches what <MonoTag>forge-runner login</MonoTag> printed in
                your terminal before approving.
              </p>
              <div className="flex items-center justify-center rounded-lg border border-line bg-sunken py-5">
                <span className="font-mono text-2xl font-semibold tracking-[0.25em] text-fg">
                  {code}
                </span>
              </div>

              {approve.isError && <Banner tone="danger">{formatApiError(approve.error)}</Banner>}

              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" icon="x" onClick={() => setDenied(true)}>
                  Deny
                </Button>
                <Button
                  variant="primary"
                  icon="check"
                  loading={approve.isPending}
                  onClick={() => approve.mutate(code)}
                >
                  Approve device
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <p className="fg-body-sm flex items-center gap-1.5 text-subtle">
        <Icon name="lock" size={13} />
        Only approve devices you started yourself. Pairing codes expire 10 minutes after creation.
      </p>
    </div>
  );
}
