import type { KnowledgeIndex } from "@/lib/types";

export interface NodeObj {
  id: string;
  label: string;
  type: "center" | "domain" | "resource";
  color: string;
  size: number;
  domain?: string;
  fx?: number;
  fy?: number;
  hidden?: boolean;
}

export interface LinkObj {
  source: string;
  target: string;
  color: string;
  hidden?: boolean;
}

export type GraphLayout = "force" | "radial" | "mindmap";

export const COLORS = [
  "#f97316","#ef4444","#a855f7","#3b82f6","#06b6d4","#10b981","#84cc16",
  "#f59e0b","#ec4899","#8b5cf6","#0ea5e9","#14b8a6","#22c55e","#eab308",
  "#f43f5e","#7c3aed","#2563eb","#0891b2","#059669","#ca8a04","#d946ef",
];

export function buildGraph(
  index: KnowledgeIndex,
  layout: GraphLayout,
  width: number,
  height: number,
  collapsed: Set<string>,
) {
  const nodes: NodeObj[] = [];
  const links: LinkObj[] = [];
  const projectLabel = typeof index.project === "string" ? index.project.split(/[:.–—]/)[0].trim().slice(0, 20) : "Project";
  const domains = index.domains ?? {};
  const domainNames = Object.keys(domains);

  nodes.push({ id: "__center", label: projectLabel, type: "center", color: "#4b5563", size: 28, fx: 0, fy: 0 });

  if (layout === "radial") {
    const dR = Math.min(width, height) * 0.22;
    const rR = Math.min(width, height) * 0.40;
    domainNames.forEach((domain, i) => {
      const angle = (2 * Math.PI * i / domainNames.length) - Math.PI / 2;
      const color = COLORS[i % COLORS.length];
      const resources = domains[domain];
      const isCollapsed = collapsed.has(domain);
      nodes.push({ id: `d:${domain}`, label: domain, type: "domain", color, size: 10 + resources.length * 1.2, fx: Math.cos(angle) * dR, fy: Math.sin(angle) * dR });
      links.push({ source: "__center", target: `d:${domain}`, color });
      if (!isCollapsed) {
        const spread = Math.min(0.4, (2 * Math.PI / domainNames.length) * 0.85);
        resources.forEach((res, j) => {
          const ra = angle - spread / 2 + (spread * j / Math.max(resources.length - 1, 1));
          const jr = rR + (j % 2 ? 12 : 0);
          nodes.push({ id: `r:${domain}/${res}`, label: res, type: "resource", color, size: 4, domain, fx: Math.cos(ra) * jr, fy: Math.sin(ra) * jr });
          links.push({ source: `d:${domain}`, target: `r:${domain}/${res}`, color });
        });
      }
    });
  } else if (layout === "mindmap") {
    const half = Math.ceil(domainNames.length / 2);
    const leftDomains = domainNames.slice(0, half);
    const rightDomains = domainNames.slice(half);

    const layoutSide = (list: string[], side: "left" | "right", startIdx: number) => {
      const dir = side === "right" ? 1 : -1;
      let totalSlots = 0;
      list.forEach(d => {
        totalSlots += collapsed.has(d) ? 1 : Math.max(domains[d].length, 1);
        totalSlots += 0.5;
      });
      const slotH = Math.min(22, (height * 0.9) / Math.max(totalSlots, 1));
      let curY = -totalSlots * slotH / 2;

      list.forEach((domain, i) => {
        const gi = startIdx + i;
        const color = COLORS[gi % COLORS.length];
        const resources = domains[domain];
        const isCollapsed = collapsed.has(domain);
        const resCount = isCollapsed ? 0 : resources.length;
        const blockH = Math.max(resCount, 1) * slotH;
        const domainY = curY + blockH / 2;
        const dx = dir * 200;

        nodes.push({ id: `d:${domain}`, label: domain, type: "domain", color, size: 10 + resources.length * 1.2, fx: dx, fy: domainY });
        links.push({ source: "__center", target: `d:${domain}`, color });

        if (!isCollapsed) {
          const resX = dx + dir * 160;
          resources.forEach((res, j) => {
            const ry = curY + j * slotH;
            nodes.push({ id: `r:${domain}/${res}`, label: res, type: "resource", color, size: 4, domain, fx: resX, fy: ry });
            links.push({ source: `d:${domain}`, target: `r:${domain}/${res}`, color });
          });
        }

        curY += blockH + slotH * 0.5;
      });
    };

    layoutSide(leftDomains, "left", 0);
    layoutSide(rightDomains, "right", half);
  } else {
    domainNames.forEach((domain, i) => {
      const color = COLORS[i % COLORS.length];
      const resources = domains[domain];
      const isCollapsed = collapsed.has(domain);
      nodes.push({ id: `d:${domain}`, label: domain, type: "domain", color, size: 10 + resources.length * 1.2 });
      links.push({ source: "__center", target: `d:${domain}`, color });
      if (!isCollapsed) {
        resources.forEach((res) => {
          nodes.push({ id: `r:${domain}/${res}`, label: res, type: "resource", color, size: 4, domain });
          links.push({ source: `d:${domain}`, target: `r:${domain}/${res}`, color });
        });
      }
    });
  }

  return { nodes, links };
}
