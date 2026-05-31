"use client";

// Pair-a-device panel (ISS-305 browser-approve device login). Shows the
// recommended `forge-runner login` CLI command plus an optional manually-minted
// pairing code + verify link (`POST /api/devices/login/init`). Composes from
// @/design; preserved verbatim from ISS-305 so the device-login surface is not
// clobbered by the ISS-296 runner-cards reconciliation.
import { useState } from "react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  HelpButton,
  Input,
} from "@/design";
import { useInitPairing } from "../hooks";

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
export function PairPanel() {
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
