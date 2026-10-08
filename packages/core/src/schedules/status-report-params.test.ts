import { describe, expect, it } from 'vitest';
import { statusReportParamsOf } from './status-report-params.js';

// A schedule that names a report template is refused by name before anything is read: an unknown
// template, a param it does not declare, template params with no template, and a window beside one.

const PROJECT = '00000000-0000-4000-8000-000000000001';
const ONE = '00000000-0000-4000-8000-000000000002';

const refusal = async (params: unknown) => {
  try {
    await statusReportParamsOf(PROJECT, params);
  } catch (err) {
    return (err as { refusals: { code: string; path: string; detail: string }[] }).refusals[0];
  }
  throw new Error('expected a refusal');
};

describe('a status_report schedule that names a template', () => {
  it('refuses an unknown template, naming the ones it has', async () => {
    const r = await refusal({ recipients: [ONE], templateId: 'weekly' });
    expect([r?.code, r?.path]).toEqual(['STATUS_REPORT_REFUSED', '/params/templateId']);
    expect(r?.detail).toContain('no report template "weekly"; templates: progress');
  });

  it('refuses a param the template does not declare', async () => {
    const r = await refusal({
      recipients: [ONE],
      templateId: 'progress',
      templateParams: { stat: 'x' },
    });
    expect(r?.path).toBe('/params/templateParams');
    expect(r?.detail).toContain('takes no param "stat"');
  });

  it('refuses template params with no template, and a window beside a template', async () => {
    expect((await refusal({ recipients: [ONE], templateParams: { a: 1 } }))?.path).toBe(
      '/params/templateParams',
    );
    const days = await refusal({ recipients: [ONE], templateId: 'progress', days: 7 });
    expect([days?.path, days?.detail]).toEqual([
      '/params/days',
      expect.stringContaining('not days'),
    ]);
  });

  it('refuses a template schedule with no recipient after the template is judged', async () => {
    expect((await refusal({ recipients: [], templateId: 'progress' }))?.code).toBe(
      'STATUS_REPORT_NO_RECIPIENTS',
    );
  });
});
