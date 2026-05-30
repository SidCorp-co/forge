"use client";

import { Fragment, useEffect, useRef } from "react";

/* A rigged, living Forge mascot. The PNG carries the helmet / flame horns / gem;
   an SVG layer reconstructs the white face-screen + eyes so they can blink and
   look around (driven by `progress`); two clipped PNG copies flicker the flames.
   Geometry is in the PNG's native 180×180 space, scaled to `size`. */

const MASCOT_SRC = "/forge-mark-180.png";
const STAGE_RING = ["#8A6BD1", "#2D5BD6", "#1F8FB0", "#F15A2B", "#E8920C", "#1F9D6B", "#5A616E"];
const LX = 61, RX = 119, EY = 112;

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export interface ForgeMascotProps {
  size?: number;
  mode?: "blink" | "track" | "both";
  /** 0..1 — drives eye target + the active ring stage. */
  progress?: number;
  flicker?: boolean;
  ring?: boolean;
}

export function ForgeMascot({
  size = 220, mode = "blink", progress = 0.35, flicker = true, ring = true,
}: ForgeMascotProps) {
  const lRef = useRef<SVGGElement>(null);
  const rRef = useRef<SVGGElement>(null);
  const live = useRef({ mode, progress });
  live.current = { mode, progress };

  useEffect(() => {
    if (reducedMotion()) {
      applyEye(lRef.current, LX, 0, 0, 1);
      applyEye(rRef.current, RX, 0, 0, 1);
      return;
    }
    let raf = 0;
    let running = true;
    let cx = 0, cy = 0;
    let blinkUntil = 0, blinkStart = 0;
    let nextBlink = performance.now() + 900;
    const BLINK_MS = 150;

    const scheduleNext = (now: number) => {
      const m = live.current.mode;
      const min = m === "track" ? 4200 : 2400;
      const max = m === "track" ? 9000 : 5600;
      nextBlink = now + min + Math.random() * (max - min);
    };

    const frame = (now: number) => {
      if (!running) return;
      const { mode: m, progress: p } = live.current;
      let tx = 0, ty = 0;
      if (m === "track" || m === "both") {
        const ang = ((-90 + p * 360) * Math.PI) / 180;
        tx = Math.cos(ang) * 4.2;
        ty = Math.sin(ang) * 3.2;
      }
      cx += (tx - cx) * 0.14;
      cy += (ty - cy) * 0.14;

      let sy = 1;
      if (now >= nextBlink && now > blinkUntil) {
        blinkStart = now;
        blinkUntil = now + BLINK_MS;
        scheduleNext(now);
      }
      if (now < blinkUntil) {
        const pr = (now - blinkStart) / BLINK_MS;
        const tri = 1 - Math.abs(pr * 2 - 1);
        sy = 1 - 0.92 * tri;
      }
      applyEye(lRef.current, LX, cx, cy, sy);
      applyEye(rRef.current, RX, cx, cy, sy);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, []);

  const ringR = size * 0.52;
  const activeIdx = Math.round(progress * (STAGE_RING.length - 1));
  const leftHorn = "inset(4% 63.3% 46.5% 6.5%)";
  const rightHorn = "inset(4% 6.5% 46.5% 63.3%)";

  return (
    <div style={{ position: "relative", width: size, height: size }}>
      {ring &&
        STAGE_RING.map((c, i) => {
          const ang = ((-90 + i * (360 / STAGE_RING.length)) * Math.PI) / 180;
          const on = i === activeIdx;
          return (
            <span
              key={i}
              style={{
                position: "absolute", left: "50%", top: "50%",
                width: on ? 13 : 10, height: on ? 13 : 10,
                marginLeft: on ? -6.5 : -5, marginTop: on ? -6.5 : -5,
                borderRadius: 999, background: c,
                transform: `translate(${Math.cos(ang) * ringR}px, ${Math.sin(ang) * ringR}px)`,
                opacity: on ? 1 : 0.26,
                boxShadow: on ? `0 0 0 5px ${c}1f` : "none",
                transition: "opacity .35s ease, width .25s ease, height .25s ease",
              }}
            />
          );
        })}

      <div
        style={{
          position: "absolute", inset: "-12%", borderRadius: "50%", pointerEvents: "none",
          background: "radial-gradient(circle, rgba(241,90,43,0.16), rgba(241,90,43,0) 62%)",
          animation: "fm-glow 2.6s ease-in-out infinite",
        }}
      />

      <div className="fm-breathe" style={{ position: "absolute", inset: 0 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={MASCOT_SRC} width={size} height={size} alt="Forge" draggable={false} style={{ position: "absolute", inset: 0, display: "block" }} />

        {flicker && (
          <Fragment>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={MASCOT_SRC} width={size} height={size} alt="" draggable={false} className="fm-flameA" style={{ position: "absolute", inset: 0, clipPath: leftHorn, mixBlendMode: "screen", pointerEvents: "none" }} />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={MASCOT_SRC} width={size} height={size} alt="" draggable={false} className="fm-flameB" style={{ position: "absolute", inset: 0, clipPath: rightHorn, mixBlendMode: "screen", pointerEvents: "none" }} />
          </Fragment>
        )}

        <svg viewBox="0 0 180 180" width={size} height={size} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
          <defs>
            <linearGradient id="fm-eye" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#2E6CF1" />
              <stop offset="1" stopColor="#0A39BE" />
            </linearGradient>
            <filter id="fm-soft" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="3" />
            </filter>
            <mask id="fm-facemask">
              <rect x="38" y="82" width="104" height="62" rx="22" fill="#fff" filter="url(#fm-soft)" />
            </mask>
          </defs>
          <g mask="url(#fm-facemask)">
            <rect x="34" y="78" width="112" height="70" rx="26" fill="#FFFFFF" />
            <ellipse cx="90" cy="116" rx="46" ry="30" fill="#E6EBF6" opacity="0.7" />
            <ellipse cx="90" cy="92" rx="30" ry="13" fill="#CED8EC" opacity="0.55" />
          </g>
          <path d="M80 137 q10 7 20 0" fill="none" stroke="#C7D0E2" strokeWidth="2.2" strokeLinecap="round" opacity="0.8" />
          <g ref={lRef}>
            <Eye ex={LX} />
          </g>
          <g ref={rRef}>
            <Eye ex={RX} />
          </g>
        </svg>
      </div>
    </div>
  );
}

function applyEye(g: SVGGElement | null, ex: number, dx: number, dy: number, sy: number) {
  if (!g) return;
  g.setAttribute(
    "transform",
    `translate(${dx.toFixed(2)} ${dy.toFixed(2)}) translate(${ex} ${EY}) scale(1 ${sy.toFixed(3)}) translate(${-ex} ${-EY})`,
  );
}

function Eye({ ex }: { ex: number }) {
  return (
    <g>
      <rect x={ex - 11} y={EY - 18.5} width="22" height="37" rx="10" fill="#06318C" />
      <rect x={ex - 9} y={EY - 16.5} width="18" height="33" rx="8.5" fill="url(#fm-eye)" />
      <ellipse cx={ex} cy={EY + 5} rx="7" ry="9" fill="#4E88F4" opacity="0.85" />
      <ellipse cx={ex} cy={EY - 7} rx="6" ry="5" fill="#2E6BEE" opacity="0.5" />
      <circle cx={ex - 3.6} cy={EY - 8} r="3" fill="#fff" />
      <circle cx={ex - 0.4} cy={EY - 3.4} r="1.5" fill="#fff" />
      <circle cx={ex + 3.6} cy={EY + 7} r="1.7" fill="#fff" opacity="0.85" />
    </g>
  );
}

export { STAGE_RING };
