// A screen recording or shot in the frame of the device it was taken on (ISS-1308, mockup MK-13): a
// desktop frame at 16:10 and a phone frame at 9:19.5, a play mark with the clip's length over a
// clip's still, and the layout that sets a phone frame beside a desktop one. Presentational: the
// feature draws the picture inside and decides what a press opens.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export type DeviceFrameKind = "desktop" | "phone" | "thumb";

const FRAME: Record<DeviceFrameKind, string> = {
  desktop: "aspect-[16/10] rounded-md",
  phone: "aspect-[9/19.5] rounded-md border-2 border-line-strong",
  thumb: "aspect-[16/10] rounded-sm",
};

/** A frame of one device's shape, its picture filling it from the top; pressable where it opens something. */
export function DeviceFrame({ kind, label, onPress, children, testId, dataKind }: {
  kind: DeviceFrameKind;
  /** What assistive tech reads for the press. */
  label?: string;
  onPress?: () => void;
  children: ReactNode;
  testId?: string;
  dataKind?: string;
}) {
  const shape = cn("group relative block w-full overflow-hidden bg-sunken", FRAME[kind]);
  if (!onPress)
    return (
      <div className={shape} data-testid={testId} data-kind={dataKind}>
        {children}
      </div>
    );
  return (
    <button type="button" onClick={onPress} aria-label={label} className={shape} data-testid={testId} data-kind={dataKind}>
      {children}
    </button>
  );
}

/** The play mark a clip carries over its still: a round play glyph and the words after it (its length). */
export function PlayMark({ children, small }: { children?: ReactNode; small?: boolean }) {
  return (
    <span
      className={cn(
        "pointer-events-none absolute bottom-2.5 left-2.5 inline-flex items-center gap-1.5 rounded-pill bg-(--scrim-media) font-medium text-white",
        small ? "py-0.5 pl-0.5 pr-1.5 text-11" : "py-1 pl-1 pr-2.5 text-12",
      )}
      data-testid="visual-play"
    >
      <i aria-hidden className={cn("inline-flex items-center justify-center rounded-full bg-white", small ? "size-4" : "size-5")}>
        <i className="ml-0.5 border-y-[5px] border-l-[8px] border-y-transparent border-l-black" />
      </i>
      {children}
    </span>
  );
}

/** A desktop frame with a phone frame beside it, the phone column narrower at phone width. */
export function DeviceFrames({ desktop, phone }: { desktop: ReactNode; phone?: ReactNode }) {
  return (
    <div className={cn("grid items-start gap-2.5", phone ? "grid-cols-[minmax(0,1fr)_7.5rem] max-sm:grid-cols-[minmax(0,1fr)_5rem]" : "grid-cols-1")}>
      {desktop}
      {phone ?? null}
    </div>
  );
}

/** A phone frame shown alone, at a phone's width. */
export function PhoneStage({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-56">{children}</div>;
}

/** A thumbnail's slot in a compact row: a fixed small width. */
export function ThumbSlot({ children }: { children: ReactNode }) {
  return <div className="w-18 flex-none">{children}</div>;
}
