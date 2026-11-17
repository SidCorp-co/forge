// "Open a box to test by hand" (ISS-1276 c7), and the issue page's Reproduce: a person opens a box
// they hold from the start (`asPerson`), in the mode they pick, a browser one at the address they give.
// Core decides where it runs and whether it waits; a refusal is shown in core's words.

import { BOX_MODES, type BoxMode, type BoxRecord } from "@forge/contracts/boxes";
import { useState } from "react";
import { Button, Input, NativeSelect } from "@/design";
import { RefusedLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useOpenBox } from "../hooks";

interface OpenProps {
  projectId: string;
  issueId?: string;
  /** The button's words: the page's "Open a box to test by hand", or the issue's Reproduce. */
  label: string;
  onOpened: (box: BoxRecord) => void;
}

export function BoxOpen({ projectId, issueId, label, onOpened }: OpenProps) {
  const t = useCopy();
  const open = useOpenBox(projectId);
  const [mode, setMode] = useState<BoxMode>("browser");
  const [url, setUrl] = useState("");
  const submit = () =>
    open.mutate(
      { mode, asPerson: true, ...(issueId ? { issueId } : {}), ...(mode === "browser" && url.trim() ? { url: url.trim() } : {}) },
      { onSuccess: onOpened },
    );
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      data-testid="box-open"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="w-32 flex-none">
        <NativeSelect
          aria-label={t("boxes.open.mode")}
          className="py-1.5 text-13"
          value={mode}
          onChange={(e) => setMode(e.target.value as BoxMode)}
          options={BOX_MODES.map((m) => ({ value: m, label: t(`boxes.mode.${m}`) }))}
        />
      </div>
      {mode === "browser" ? (
        <Input aria-label={t("boxes.open.url")} placeholder="https://" type="url" className="w-56 max-w-full py-1.5 text-13" value={url} onChange={(e) => setUrl(e.target.value)} />
      ) : null}
      <Button type="submit" size="sm" variant="primary" icon="plus" loading={open.isPending}>
        {label}
      </Button>
      <RefusedLine label={t("boxes.open.failed")} error={open.error} className="basis-full text-12 text-danger-11" />
    </form>
  );
}
