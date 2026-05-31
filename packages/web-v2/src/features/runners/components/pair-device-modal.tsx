"use client";

// Pair-a-device flow: pick a project, mint a 5-min pairing code
// (`POST /api/projects/:id/devices/pairing-codes`), and show it for the agent
// CLI to redeem. Rendered in a SlideOver from the kit.
import { useEffect, useState } from "react";
import { Button, Field, MonoTag, Select, SlideOver, type SelectOption } from "@/design";
import { useMintPairingCode } from "../hooks";

export function PairDeviceModal({
  open,
  onClose,
  projects,
}: {
  open: boolean;
  onClose: () => void;
  projects: { id: string; name: string }[];
}) {
  const [projectId, setProjectId] = useState("");
  const mint = useMintPairingCode();

  // Reset state whenever the modal re-opens, and default to the first project.
  useEffect(() => {
    if (open) {
      mint.reset();
      setProjectId(projects[0]?.id ?? "");
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const options: SelectOption[] = projects.map((p) => ({ value: p.id, label: p.name }));
  const code = mint.data?.code;
  const expiresAt = mint.data?.expiresAt;

  return (
    <SlideOver open={open} onClose={onClose} title="Pair a device" width={440}>
      <div className="space-y-5 p-5">
        <p className="fg-body-sm">
          Mint a short-lived pairing code, then run{" "}
          <MonoTag>forge pair &lt;code&gt;</MonoTag> on the device you want to connect. The code
          expires in 5 minutes.
        </p>

        <Field label="Project" hint="The device will be paired into this project's runner pool.">
          <Select
            options={options}
            value={projectId}
            onChange={setProjectId}
            placeholder="Select a project"
          />
        </Field>

        <Button
          variant="primary"
          icon="plus"
          loading={mint.isPending}
          disabled={!projectId}
          onClick={() => mint.mutate(projectId)}
        >
          Mint pairing code
        </Button>

        {code && (
          <div className="rounded-lg border border-line bg-sunken px-4 py-4 text-center">
            <p className="fg-caption">Pairing code</p>
            <p className="mt-2 font-mono text-2xl font-bold tracking-widest text-fg">{code}</p>
            {expiresAt && (
              <p className="fg-caption mt-2">
                Expires {new Date(expiresAt).toLocaleTimeString()}
              </p>
            )}
          </div>
        )}
      </div>
    </SlideOver>
  );
}
