// The composition root of the product copy: every copy file, imported statically so the key type is
// exact. A new copy file is one line here; archmap excludes this file by name as it does the other
// composition roots, since reaching every feature's copy is its purpose.

import agentAccountsCopy from "@/features/agent-accounts/copy.json";
import agentsCopy from "@/features/agents/copy.json";
import automationCopy from "@/features/automation/copy.json";
import commentsCopy from "@/features/comments/copy.json";
import contractsCopy from "@/features/contracts/copy.json";
import conversationsCopy from "@/features/conversations/copy.json";
import ecosystemCopy from "@/features/ecosystem/copy.json";
import feedbackCopy from "@/features/feedback/copy.json";
import forecastCopy from "@/features/forecast/copy.json";
import integrationsCopy from "@/features/integrations/copy.json";
import issuesCopy from "@/features/issues/copy.json";
import memoryCopy from "@/features/memory/copy.json";
import modulesCopy from "@/features/modules/copy.json";
import needsYouCopy from "@/features/needs-you/copy.json";
import onboardingCopy from "@/features/onboarding/copy.json";
import orgsCopy from "@/features/orgs/copy.json";
import overviewCopy from "@/features/overview/copy.json";
import pipelineCopy from "@/features/pipeline/copy.json";
import projectDashboardCopy from "@/features/project-dashboard/copy.json";
import projectSettingsCopy from "@/features/project-settings/copy.json";
import projectStatusCopy from "@/features/project-status/copy.json";
import questionsCopy from "@/features/questions/copy.json";
import releasesCopy from "@/features/releases/copy.json";
import requirementsCopy from "@/features/requirements/copy.json";
import runnersCopy from "@/features/runners/copy.json";
import sessionsCopy from "@/features/sessions/copy.json";
import settingsCopy from "@/features/settings/copy.json";
import shellCopy from "@/features/shell/copy.json";
import toursCopy from "@/features/tours/copy.json";
import whatsNewCopy from "@/features/whats-new/copy.json";
import workflowsCopy from "@/features/workflows/copy.json";
import commonCopy from "@/lib/i18n/copy/common.json";
import labelCopy from "@/lib/i18n/copy/label.json";
import listCopy from "@/lib/i18n/copy/list.json";
import standingCopy from "@/lib/i18n/copy/standing.json";
import timeCopy from "@/lib/i18n/copy/time.json";
import writtenCopy from "@/lib/i18n/copy/written.json";

/**
 * Every copy file by its path under `src/`: each feature's own (`features/<domain>/copy.json`) and
 * shared chrome's (`lib/i18n/copy/<area>.json`), each mapping a language to a flat map of keys. A
 * key's file is named by its prefix (`scripts/split-product-copy.mjs:PREFIX_HOMES`).
 */
export const COPY_FILES = {
  "features/agent-accounts/copy.json": agentAccountsCopy,
  "features/agents/copy.json": agentsCopy,
  "features/automation/copy.json": automationCopy,
  "features/comments/copy.json": commentsCopy,
  "features/contracts/copy.json": contractsCopy,
  "features/conversations/copy.json": conversationsCopy,
  "features/ecosystem/copy.json": ecosystemCopy,
  "features/feedback/copy.json": feedbackCopy,
  "features/forecast/copy.json": forecastCopy,
  "features/integrations/copy.json": integrationsCopy,
  "features/issues/copy.json": issuesCopy,
  "features/memory/copy.json": memoryCopy,
  "features/modules/copy.json": modulesCopy,
  "features/needs-you/copy.json": needsYouCopy,
  "features/onboarding/copy.json": onboardingCopy,
  "features/orgs/copy.json": orgsCopy,
  "features/overview/copy.json": overviewCopy,
  "features/pipeline/copy.json": pipelineCopy,
  "features/project-dashboard/copy.json": projectDashboardCopy,
  "features/project-settings/copy.json": projectSettingsCopy,
  "features/project-status/copy.json": projectStatusCopy,
  "features/questions/copy.json": questionsCopy,
  "features/releases/copy.json": releasesCopy,
  "features/requirements/copy.json": requirementsCopy,
  "features/runners/copy.json": runnersCopy,
  "features/sessions/copy.json": sessionsCopy,
  "features/settings/copy.json": settingsCopy,
  "features/shell/copy.json": shellCopy,
  "features/tours/copy.json": toursCopy,
  "features/whats-new/copy.json": whatsNewCopy,
  "features/workflows/copy.json": workflowsCopy,
  "lib/i18n/copy/common.json": commonCopy,
  "lib/i18n/copy/label.json": labelCopy,
  "lib/i18n/copy/list.json": listCopy,
  "lib/i18n/copy/standing.json": standingCopy,
  "lib/i18n/copy/time.json": timeCopy,
  "lib/i18n/copy/written.json": writtenCopy,
};
