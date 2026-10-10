// The composition root of the product copy: every copy file, imported statically so the key type is
// exact. A new copy file is one line here. Every copy file lives beside this one under `copy/`, one
// per feature (`copy/<feature>.json`) and one per shared area, so lib never reaches into a feature.

import agentAccountsCopy from "./copy/agent-accounts.json";
import agentsCopy from "./copy/agents.json";
import attachmentsCopy from "./copy/attachments.json";
import attentionCopy from "./copy/attention.json";
import authCopy from "./copy/auth.json";
import automationCopy from "./copy/automation.json";
import chatCopy from "./copy/chat.json";
import checklistsCopy from "./copy/checklists.json";
import commentsCopy from "./copy/comments.json";
import contractsCopy from "./copy/contracts.json";
import conversationsCopy from "./copy/conversations.json";
import ecosystemCopy from "./copy/ecosystem.json";
import feedbackCopy from "./copy/feedback.json";
import forecastCopy from "./copy/forecast.json";
import intakeCopy from "./copy/intake.json";
import integrationsCopy from "./copy/integrations.json";
import issuesCopy from "./copy/issues.json";
import memoryCopy from "./copy/memory.json";
import modulesCopy from "./copy/modules.json";
import needsYouCopy from "./copy/needs-you.json";
import onboardingCopy from "./copy/onboarding.json";
import operatorCopy from "./copy/operator.json";
import orgsCopy from "./copy/orgs.json";
import overviewCopy from "./copy/overview.json";
import pairingCopy from "./copy/pairing.json";
import pipelineCopy from "./copy/pipeline.json";
import previewsCopy from "./copy/previews.json";
import projectDashboardCopy from "./copy/project-dashboard.json";
import projectHomeCopy from "./copy/project-home.json";
import projectSettingsCopy from "./copy/project-settings.json";
import projectStatusCopy from "./copy/project-status.json";
import projectsCopy from "./copy/projects.json";
import questionsCopy from "./copy/questions.json";
import releasesCopy from "./copy/releases.json";
import requirementsCopy from "./copy/requirements.json";
import runnersCopy from "./copy/runners.json";
import sessionCopy from "./copy/session.json";
import sessionsCopy from "./copy/sessions.json";
import settingsCopy from "./copy/settings.json";
import sharesCopy from "./copy/shares.json";
import shellCopy from "./copy/shell.json";
import toursCopy from "./copy/tours.json";
import visualBlocksCopy from "./copy/visual-blocks.json";
import whatsNewCopy from "./copy/whats-new.json";
import workflowsCopy from "./copy/workflows.json";
import commonCopy from "./copy/common.json";
import labelCopy from "./copy/label.json";
import listCopy from "./copy/list.json";
import standingCopy from "./copy/standing.json";
import timeCopy from "./copy/time.json";
import writtenCopy from "./copy/written.json";

/**
 * Every copy file by its path under `src/`: each feature's own (`lib/i18n/copy/<feature>.json`) and
 * shared chrome's (`lib/i18n/copy/<area>.json`), each mapping a language to a flat map of keys. A
 * key's file is named by its prefix (`scripts/split-product-copy.mjs:PREFIX_HOMES`).
 */
export const COPY_FILES = {
  "lib/i18n/copy/agent-accounts.json": agentAccountsCopy,
  "lib/i18n/copy/agents.json": agentsCopy,
  "lib/i18n/copy/attachments.json": attachmentsCopy,
  "lib/i18n/copy/attention.json": attentionCopy,
  "lib/i18n/copy/auth.json": authCopy,
  "lib/i18n/copy/automation.json": automationCopy,
  "lib/i18n/copy/chat.json": chatCopy,
  "lib/i18n/copy/checklists.json": checklistsCopy,
  "lib/i18n/copy/comments.json": commentsCopy,
  "lib/i18n/copy/contracts.json": contractsCopy,
  "lib/i18n/copy/conversations.json": conversationsCopy,
  "lib/i18n/copy/ecosystem.json": ecosystemCopy,
  "lib/i18n/copy/feedback.json": feedbackCopy,
  "lib/i18n/copy/forecast.json": forecastCopy,
  "lib/i18n/copy/intake.json": intakeCopy,
  "lib/i18n/copy/integrations.json": integrationsCopy,
  "lib/i18n/copy/issues.json": issuesCopy,
  "lib/i18n/copy/memory.json": memoryCopy,
  "lib/i18n/copy/modules.json": modulesCopy,
  "lib/i18n/copy/needs-you.json": needsYouCopy,
  "lib/i18n/copy/onboarding.json": onboardingCopy,
  "lib/i18n/copy/operator.json": operatorCopy,
  "lib/i18n/copy/orgs.json": orgsCopy,
  "lib/i18n/copy/overview.json": overviewCopy,
  "lib/i18n/copy/pairing.json": pairingCopy,
  "lib/i18n/copy/pipeline.json": pipelineCopy,
  "lib/i18n/copy/previews.json": previewsCopy,
  "lib/i18n/copy/project-dashboard.json": projectDashboardCopy,
  "lib/i18n/copy/project-home.json": projectHomeCopy,
  "lib/i18n/copy/project-settings.json": projectSettingsCopy,
  "lib/i18n/copy/project-status.json": projectStatusCopy,
  "lib/i18n/copy/projects.json": projectsCopy,
  "lib/i18n/copy/questions.json": questionsCopy,
  "lib/i18n/copy/releases.json": releasesCopy,
  "lib/i18n/copy/requirements.json": requirementsCopy,
  "lib/i18n/copy/runners.json": runnersCopy,
  "lib/i18n/copy/session.json": sessionCopy,
  "lib/i18n/copy/sessions.json": sessionsCopy,
  "lib/i18n/copy/settings.json": settingsCopy,
  "lib/i18n/copy/shares.json": sharesCopy,
  "lib/i18n/copy/shell.json": shellCopy,
  "lib/i18n/copy/tours.json": toursCopy,
  "lib/i18n/copy/visual-blocks.json": visualBlocksCopy,
  "lib/i18n/copy/whats-new.json": whatsNewCopy,
  "lib/i18n/copy/workflows.json": workflowsCopy,
  "lib/i18n/copy/common.json": commonCopy,
  "lib/i18n/copy/label.json": labelCopy,
  "lib/i18n/copy/list.json": listCopy,
  "lib/i18n/copy/standing.json": standingCopy,
  "lib/i18n/copy/time.json": timeCopy,
  "lib/i18n/copy/written.json": writtenCopy,
};
