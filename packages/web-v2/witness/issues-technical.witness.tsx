// The Issues list with its Technical chip on (ISS-1001), witnessed at phone and desktop width in both
// themes over adminhub-api's technical backlog as the approved mockup read it on 2026-11-05: only the
// issues an agent filed under a technical kind, grouped by module with "No module" last, each module
// counted by kind; a person's bug and an agent's feature stay out. Titles are the mockup's.
//
//   pnpm --filter web-v2 witness witness/issues-technical.witness.tsx --out <dir>

import type { IssueStandingRow } from "@forge/contracts/issue-standing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { IssuesBoard } from "@/features/issues/components/issues-board";
import { RULE, say, waitingOn } from "@/test/said";
import "./entry";
import { InRouter } from "./router";

const P = "0b6b6a63-5d0e-4b2a-9a7f-3f3c2f1d9e21";
const NOW = Date.parse("2026-11-05T09:00:00.000Z");
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

function issue(n: number, title: string, category: string, byAgent: boolean, module: string | null, days: number): IssueStandingRow {
  const r = {
    id: `i${n}`,
    key: `ISS-${n}`,
    title,
    writtenLang: "vi",
    status: "draft",
    priority: "medium",
    category,
    complexity: "s",
    assigneeId: null,
    createdById: "u1",
    byAgent,
    createdAt: ago(days),
    updatedAt: ago(days),
    standing: {
      state: "draft",
      step: null,
      stepStartedAt: null,
      moves: [],
      tone: "ready",
      attentionGroup: "queued",
      waitingOn: waitingOn("master", { who: say("standing.who.nobody"), act: say("standing.act.none"), rule: RULE }),
      criteria: { total: 0, met: 0, failing: 0, skipped: 0 },
      requirement: null,
      module: module ? { id: `m-${module}`, path: module } : null,
      feedback: [],
      blockedBy: [],
      blocks: [],
      lease: null,
      inFlight: false,
      branch: null,
      headSha: null,
      owner: null,
      wave: null,
      touchedAt: ago(days),
      withheld: null,
    },
  };
  return r as unknown as IssueStandingRow;
}

const ROWS = [
  issue(128, "Tạo/sửa tài khoản paygate không kiểm account_type ngoài SYSTEM và SANDBOX", "bug", true, "Paygate", 5),
  issue(124, "Log thẻ và tài khoản paygate chỉ hiện một cột cho mỗi dòng audit", "bug", true, "Paygate", 5),
  issue(119, "Import tài khoản paygate để trống cột Status thì mọi dòng lỗi", "bug", true, "Paygate", 5),
  issue(117, "Paygate export chậm khi quá 5.000 dòng", "performance", true, "Paygate", 5),
  issue(116, "Paygate service lặp lại kiểm tra quyền ở ba chỗ", "debt", true, "Paygate", 5),
  issue(177, "Route Catalog cho product type, design, mockup chỉ nhận DEFAULT_TOKEN", "security", true, "Catalog & tích hợp", 0),
  issue(170, "Thiếu CATALOG_API_TOKEN làm design import failed và không tự thử lại", "bug", true, "Catalog & tích hợp", 0),
  issue(132, "supplier-option-mappings: POST/PUT/DELETE trỏ vào controller không có hàm", "bug", true, "Catalog & tích hợp", 5),
  issue(130, "Khoá unique và giới hạn tốc độ của Verify order thiếu index", "performance", true, "Đơn hàng", 5),
  issue(140, "Response của /orders không có kiểu trong hợp đồng", "contract", true, "Đơn hàng", 3),
  issue(150, "Cron dọn file tạm không còn dùng", "debt", true, null, 4),
  // not technical items: a person's report and an agent's feature
  issue(160, "Thêm bộ lọc theo nhà cung cấp", "feature", true, "Đơn hàng", 2),
  issue(161, "Khách báo đơn hiện sai tiền", "bug", false, "Đơn hàng", 1),
];

window.fetch = async () => new Promise<Response>(() => {});
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
client.setQueryData(["issues", "standing", P, "open"], { issues: ROWS, counts: { open: ROWS.length, closed: 0, all: ROWS.length, blocked: 0, blocking: 0 }, returned: ROWS.length, limit: 500, releaseApproval: false });
createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at="/projects/adminhub-api/issues" pattern="/projects/$slug/issues">
    <QueryClientProvider client={client}>
      <div className="min-h-screen bg-app">
        <IssuesBoard scope={{ projectId: P, slug: "adminhub-api" }} mode="attention" />
      </div>
    </QueryClientProvider>
  </InRouter>,
);

const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const settle = () => new Promise((r) => setTimeout(r, 200));

async function reads(t: "light" | "dark"): Promise<string[]> {
  const chip = document.querySelector<HTMLButtonElement>("[data-testid=quick-technical]");
  if (!chip) return ["the list draws no Technical chip"];
  if (chip.getAttribute("aria-pressed") !== "true") chip.click();
  theme(t);
  await settle();
  const wrong: string[] = [];
  const groups = [...document.querySelectorAll("[data-testid=list-group] [data-testid=group-label]")].map((g) => g.textContent);
  if (groups.join("|") !== "Catalog & tích hợp|Đơn hàng|Paygate|No module") wrong.push(`the groups read ${groups.join(", ")}`);
  const shown = document.querySelectorAll("[data-testid=list-row]").length;
  if (shown !== 11) wrong.push(`${shown} rows are shown, not the 11 technical items`);
  if (!document.querySelector("[data-testid=list-group]")?.textContent?.includes("Bug 2")) wrong.push("the first module does not count its bugs");
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
  return wrong;
}

window.__witness = {
  cases: [
    { name: "phone", width: 420 },
    { name: "desktop", width: 1440 },
  ],
  ready: () => document.querySelector("[data-testid=quick-technical]") !== null && document.querySelector("[data-testid=list-row]") !== null,
  stages: [
    { name: "light", run: () => reads("light") },
    { name: "dark", run: () => reads("dark") },
  ],
};
