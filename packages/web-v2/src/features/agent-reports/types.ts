import type {
  AgentReportKind,
  AgentReportSeverity,
  AgentReportTarget,
  AgentReportView,
} from "@forge/contracts/agent-reports";

export type { AgentReportFeedbackLink, AgentReportKind, AgentReportSeverity, AgentReportTarget } from "@forge/contracts/agent-reports";

export type AgentReport = AgentReportView;

export interface AgentReportFilters {
  kind?: AgentReportKind;
  severity?: AgentReportSeverity;
  target?: AgentReportTarget;
}
