import type {
  AgentReportKind,
  AgentReportSeverity,
  AgentReportTarget,
  AgentReportTriage,
  AgentReportView,
} from "@forge/contracts/agent-reports";

export type {
  AgentReportFeedbackLink,
  AgentReportKind,
  AgentReportSeverity,
  AgentReportTarget,
  AgentReportTriage,
} from "@forge/contracts/agent-reports";

export type AgentReport = AgentReportView;

export interface AgentReportFilters {
  kind?: AgentReportKind;
  severity?: AgentReportSeverity;
  target?: AgentReportTarget;
  triage?: AgentReportTriage;
}
