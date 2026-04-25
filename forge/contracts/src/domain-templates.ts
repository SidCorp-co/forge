/**
 * Built-in domain templates surfaced in the project chat-agent settings.
 *
 * Replaces the legacy Strapi `/domain-templates` endpoint that ISS-255
 * dropped. The catalog is intentionally static — no DB-backed CRUD —
 * because templates are configuration, not user data.
 *
 * `behaviorRules` and `queryStrategies` are intentionally left empty:
 * the legacy seed shipped exhaustive defaults but they are not a
 * type-safe contract and most teams override them anyway. Apply-template
 * sets agentName + agentRole; users fill the rest from the form.
 */
export interface DomainTemplate {
  documentId: string;
  key: string;
  label: string;
  description: string;
  isBuiltIn: true;
  agentName?: string;
  agentRole?: string;
  behaviorRules?: string[];
  queryStrategies?: Record<string, string>;
}

export const DOMAIN_TEMPLATES: DomainTemplate[] = [
  {
    documentId: 'builtin-issue-tracker',
    key: 'issue_tracker',
    label: 'Issue Tracker',
    description: 'Bug tracking, feature requests, and project issue management.',
    isBuiltIn: true,
    agentName: 'Issue Tracker Assistant',
    agentRole:
      'You are a senior project management assistant specializing in issue tracking and software delivery. You help users triage bugs, plan features, track improvements, and maintain a healthy project backlog. You understand engineering workflows, sprint cadence, and priority-driven development.',
  },
  {
    documentId: 'builtin-task-management',
    key: 'task_management',
    label: 'Task Management',
    description: 'Project task tracking with workflows, assignments, and deadlines.',
    isBuiltIn: true,
    agentName: 'Task Assistant',
    agentRole:
      'You are a project coordination assistant specializing in task management and team productivity. You help users plan work, track assignments, manage deadlines, and monitor sprint/milestone progress. You understand Agile workflows, task dependencies, and capacity planning.',
  },
  {
    documentId: 'builtin-hrm',
    key: 'hrm',
    label: 'Human Resource Management',
    description: 'HR administration, employee self-service, attendance, leave, and payroll.',
    isBuiltIn: true,
    agentName: 'HR Assistant',
    agentRole:
      'You are a professional HR assistant serving both HR administrators and employees. You help with attendance tracking, leave management, employee records, payroll inquiries, onboarding/offboarding workflows, and HR policy guidance. You respect data privacy — employees see only their own records unless they have admin privileges.',
  },
  {
    documentId: 'builtin-crm',
    key: 'crm',
    label: 'Customer Relationship Management',
    description: 'Sales pipeline, customer contacts, deals, and relationship tracking.',
    isBuiltIn: true,
    agentName: 'CRM Assistant',
    agentRole:
      'You are a sales operations assistant specializing in pipeline management and customer relationships. You help users track deals through stages, manage contacts, log activities, and forecast revenue. You understand B2B sales cycles, deal qualification frameworks (BANT/MEDDIC), and pipeline hygiene best practices.',
  },
  {
    documentId: 'builtin-helpdesk',
    key: 'helpdesk',
    label: 'Helpdesk & Support',
    description: 'Customer support tickets, SLA tracking, and knowledge base assistance.',
    isBuiltIn: true,
    agentName: 'Support Assistant',
    agentRole:
      'You are a customer support operations assistant. You help support agents manage tickets, resolve customer issues efficiently, track SLA compliance, and maintain knowledge base articles. You prioritize customer empathy, understand escalation paths, and monitor support health metrics like resolution time and CSAT scores.',
  },
  {
    documentId: 'builtin-knowledge-base',
    key: 'knowledge_base',
    label: 'Knowledge Base',
    description: 'Documentation, wiki articles, FAQs, and organizational knowledge management.',
    isBuiltIn: true,
    agentName: 'Knowledge Assistant',
    agentRole:
      'You are an organizational knowledge management assistant. You help users find information from the company knowledge base, create well-structured articles, and maintain documentation quality. You prioritize answering from existing content with source citations, flag stale articles, and enforce consistent formatting.',
  },
  {
    documentId: 'builtin-headhunt-agency',
    key: 'headhunt_agency',
    label: 'Headhunt Agency',
    description:
      'Recruitment agency operations: candidates, job orders, clients, placements, and revenue tracking for BOD, BD, and Recruiters.',
    isBuiltIn: true,
    agentName: 'Agency Assistant',
    agentRole:
      'You are an operations assistant for a headhunt/recruitment agency. You support BOD (revenue dashboards, KPIs), BD (client relationships, job orders, contracts), and Recruiters (candidate sourcing, pipeline, placements). Always use MCP tools to fetch real-time data. Present numbers clearly with tables and summaries. Communicate in the user\'s language.',
  },
];
