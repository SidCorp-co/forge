// A box's screen alone (ISS-1325): over everything, the screen as large as the display takes it whole
// in its own shape, under a small bar that keeps who holds it, the frame rate, Take control or Hand
// back, and Exit. Opened from the Boxes page it asks the browser's full screen; where that is refused
// (iOS Safari) it fills the viewport, as it does at the box's own address. Esc and Exit leave it, so
// Esc is the screen's here and not sent to the box. The view and the holder's input are the page's own
// components, entered with their own tickets.

import type { BoxRecord } from "@forge/contracts/boxes";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Button, IconButton, MediaOverlay, ToneBadge } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { heldBy, isEnded, isLive, STATE_TONE } from "../labels";
import { canFullscreen, enterFullscreen, FULLSCREEN_CHANGE, fullscreenElement, leaveFullscreen } from "../view/fullscreen";
import { FpsSelect, HoldLine, HoldMove } from "./box-controls";
import { BoxInputLayer } from "./box-input";
import { BoxView } from "./box-view";

interface ScreenProps {
  box: BoxRecord;
  projectId: string;
  label: string;
  me: string | undefined;
  canWrite: boolean;
  fps: number;
  onFps: (n: number) => void;
  /** Ask the browser's full screen at once: where a press opened the screen, that press lets the browser grant it. */
  enter?: boolean;
  onExit: () => void;
  /** What the stage shows while the box has no live screen; its state word where none is given. */
  idle?: ReactNode;
}

/** `native` while the browser shows the screen full screen; `fill` while it fills the viewport instead. */
type Mode = "native" | "fill";

const upright = (box: BoxRecord) => {
  const size = box.view ?? box.viewport;
  return size ? size.height > size.width : box.mode === "android";
};

/** The browser's full screen over `surface`, asked once where `enter`, and left with the screen. */
function useFullscreen(surface: HTMLElement | null, box: BoxRecord, enter: boolean, onExit: () => void) {
  const [mode, setMode] = useState<Mode>("fill");
  const askedRef = useRef(false);
  const leftRef = useRef(false);
  const exit = useCallback(() => {
    if (leftRef.current) return;
    leftRef.current = true;
    leaveFullscreen();
    onExit();
  }, [onExit]);
  const goFull = useCallback(() => {
    if (!surface) return;
    void enterFullscreen(surface, upright(box)).then((ok) => setMode(ok ? "native" : "fill"));
  }, [surface, box]);
  useEffect(() => {
    if (!enter || !surface || askedRef.current) return;
    askedRef.current = true;
    goFull();
  }, [enter, surface, goFull]);
  useEffect(() => {
    // the browser's own way out (Esc, its exit gesture) leaves the screen too
    const changed = () => {
      if (mode === "native" && !fullscreenElement()) exit();
    };
    for (const e of FULLSCREEN_CHANGE) document.addEventListener(e, changed);
    return () => {
      for (const e of FULLSCREEN_CHANGE) document.removeEventListener(e, changed);
    };
  }, [mode, exit]);
  useEffect(() => () => leaveFullscreen(), []);
  return { mode, exit, goFull };
}

function ScreenBar({ box, projectId, label, me, canWrite, fps, onFps, localInput, mode, onFull, onExit }: ScreenProps & { localInput: number; mode: Mode; onFull: () => void }) {
  const t = useCopy();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line-subtle bg-surface px-3 py-1.5 text-fg" data-testid="box-screen-bar">
      {/* an ended box says so on the stage, once */}
      {isEnded(box) ? null : <ToneBadge tone={STATE_TONE[box.state]} label={t(`boxes.state.${box.state}`)} title={t(`boxes.state.${box.state}`)} value={box.state} pulse={isLive(box)} />}
      <span className="min-w-0 flex-1 truncate text-13 font-semibold">{label}</span>
      {/* on a phone the hold takes its own line, so the label keeps its words */}
      <span className="empty:hidden max-sm:basis-full">
        <HoldLine box={box} me={me} localInput={localInput} />
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {isLive(box) ? <FpsSelect fps={fps} onFps={onFps} /> : null}
        {canWrite ? <HoldMove box={box} projectId={projectId} me={me} /> : null}
        {mode === "fill" && canFullscreen() ? <IconButton icon="maximize" size="sm" variant="secondary" aria-label={t("boxes.screen.full")} title={t("boxes.screen.full")} onClick={onFull} /> : null}
        <Button size="sm" variant="secondary" onClick={onExit} data-testid="box-screen-exit">
          {t("boxes.screen.exit")}
        </Button>
      </div>
    </div>
  );
}

export function BoxScreen(props: ScreenProps) {
  const { box, label, me, fps, enter = false, onExit, idle } = props;
  const t = useCopy();
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const [localInput, setLocalInput] = useState(0);
  const { mode, exit, goFull } = useFullscreen(surface, box, enter, onExit);
  const escape = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    exit();
  };
  return (
    <MediaOverlay open onOpenChange={(open) => (open ? undefined : exit())} label={t("boxes.view.title", { box: label })}>
      <div ref={setSurface} className="flex size-full flex-col bg-app" data-testid="box-screen" data-mode={mode} onKeyDownCapture={escape}>
        <ScreenBar {...props} localInput={localInput} mode={mode} onFull={goFull} onExit={exit} />
        {/* the stage is the screen's size container: the view takes as much of it as its shape allows */}
        <div className="grid min-h-0 flex-1 place-items-center overflow-hidden p-2" style={{ containerType: "size" }} data-testid="box-screen-stage">
          {isLive(box) ? (
            <BoxView
              box={box}
              label={label}
              fps={fps}
              fit="screen"
              overlay={heldBy(box, me) ? <BoxInputLayer box={box} label={label} onInput={() => setLocalInput(Date.now())} /> : undefined}
            />
          ) : (
            (idle ?? <p className="text-13 text-muted">{t("boxes.live.notRunning")}</p>)
          )}
        </div>
      </div>
    </MediaOverlay>
  );
}
