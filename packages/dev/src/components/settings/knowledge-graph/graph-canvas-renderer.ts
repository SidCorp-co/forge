import type { NodeObj, LinkObj, GraphLayout } from "./graph-builder";
import type { KnowledgeIndex } from "@/lib/types";

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

export function createNodeCanvasObject(
  layout: GraphLayout,
  isMindmap: boolean,
  collapsed: Set<string>,
  domains: Record<string, string[]>,
) {
  return (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const n = node as NodeObj;
    const x = node.x ?? 0;
    const y = node.y ?? 0;

    if (n.type === "center") {
      if (isMindmap) {
        const fontSize = 12;
        ctx.font = `bold ${fontSize}px system-ui`;
        const tw = ctx.measureText(n.label).width;
        const pw = tw + 24, ph = 32, r = ph / 2;
        roundRect(ctx, x - pw / 2, y - ph / 2, pw, ph, r);
        ctx.fillStyle = "#3b82f6";
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(n.label, x, y);
      } else {
        const r = n.size;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (Math.PI / 3) * i - Math.PI / 6;
          i === 0 ? ctx.moveTo(x + r * Math.cos(a), y + r * Math.sin(a)) : ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
        }
        ctx.closePath();
        ctx.fillStyle = "#f3f4f6";
        ctx.fill();
        ctx.strokeStyle = "#9ca3af";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = "#1f2937";
        ctx.font = "bold 10px system-ui";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(n.label, x, y);
      }
    } else if (n.type === "domain") {
      const isCol = collapsed.has(n.label);
      const resCount = (domains)[n.label]?.length ?? 0;
      const fontSize = isMindmap ? 10 : Math.max(8, 11 / Math.sqrt(globalScale));
      ctx.font = `bold ${fontSize}px system-ui`;
      const badge = isCol ? ` +${resCount}` : "";
      const displayLabel = n.label + badge;
      const tw = ctx.measureText(displayLabel).width;
      const pw = tw + 20, ph = fontSize + 12, r = isMindmap ? ph / 2 : 6;
      roundRect(ctx, x - pw / 2, y - ph / 2, pw, ph, r);
      if (isMindmap) {
        ctx.fillStyle = n.color;
        ctx.fill();
      } else {
        ctx.fillStyle = n.color + "33";
        ctx.fill();
        ctx.strokeStyle = n.color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.fillStyle = isMindmap ? "#fff" : "#1f2937";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(displayLabel, x, y);

      if (isMindmap || layout === "radial") {
        const ix = x + pw / 2 - 8;
        const iy = y;
        ctx.fillStyle = isMindmap ? "#fff9" : "#6b728099";
        ctx.font = `bold ${fontSize - 1}px system-ui`;
        ctx.textAlign = "center";
        ctx.fillText(isCol ? "+" : "−", ix, iy);
      }
    } else {
      if (isMindmap) {
        const fontSize = 8;
        ctx.font = `${fontSize}px system-ui`;
        const tw = ctx.measureText(n.label).width;
        const pw = tw + 12, ph = fontSize + 8, r = ph / 2;
        roundRect(ctx, x - pw / 2, y - ph / 2, pw, ph, r);
        ctx.fillStyle = n.color + "22";
        ctx.fill();
        ctx.strokeStyle = n.color + "55";
        ctx.lineWidth = 0.8;
        ctx.stroke();
        ctx.fillStyle = "#374151";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(n.label, x, y);
      } else {
        ctx.beginPath();
        ctx.arc(x, y, n.size, 0, 2 * Math.PI);
        ctx.fillStyle = n.color;
        ctx.globalAlpha = 0.7;
        ctx.fill();
        ctx.globalAlpha = 1;
        if (layout !== "force" || globalScale > 1.5) {
          ctx.fillStyle = "#4b5563";
          const fs = layout === "force" ? 7 / Math.sqrt(globalScale) : 7;
          ctx.font = `${fs}px system-ui`;
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(n.label, x + n.size + 3, y);
        }
      }
    }
  };
}

export function createLinkCanvasObject(isMindmap: boolean) {
  return (link: any, ctx: CanvasRenderingContext2D) => {
    const l = link as any;
    const sx = l.source.x, sy = l.source.y, tx = l.target.x, ty = l.target.y;
    const color = (l as LinkObj).color;

    if (isMindmap) {
      const midX = sx + (tx - sx) * 0.5;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.bezierCurveTo(midX, sy, midX, ty, tx, ty);
      ctx.strokeStyle = color + "66";
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(tx, ty);
      ctx.strokeStyle = color + "44";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  };
}
