import type { ForgeTool } from '../../tools';
import { createEmployeesTool } from './employees';
import { createLeaveTool } from './leave';
import { createAttendanceTool } from './attendance';
import { createPayrollTool } from './payroll';
import { createRecruitmentTool } from './recruitment';
import { createOrganizationTool } from './organization';
import { createPerformanceTool } from './performance';

export function createHrmTools(): ForgeTool[] {
  return [
    createEmployeesTool(),
    createLeaveTool(),
    createAttendanceTool(),
    createPayrollTool(),
    createRecruitmentTool(),
    createOrganizationTool(),
    createPerformanceTool(),
  ];
}
