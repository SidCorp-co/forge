import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Timeline, type TimelineStep } from '@/components/ui/timeline';

void React;

const baseSteps: TimelineStep[] = [
  { key: 'triage', label: 'triage', status: 'completed', clickable: true },
  {
    key: 'code',
    label: 'code',
    status: 'running',
    startedAt: '2026-05-12T00:00:00.000Z',
    clickable: false,
  },
  { key: 'review', label: 'review', status: 'pending', clickable: false },
  { key: 'fix', label: 'fix', status: 'failed', clickable: true },
  { key: 'release', label: 'release', status: 'skipped', clickable: false },
];

describe('Timeline', () => {
  it('renders one item per step', () => {
    render(<Timeline steps={baseSteps} />);
    expect(screen.getAllByText(/triage|code|review|fix|release/)).toHaveLength(
      baseSteps.length,
    );
  });

  it('marks the current step with aria-current="step"', () => {
    render(<Timeline steps={baseSteps} currentKey="code" />);
    const current = screen.getByLabelText(/Pipeline step code/);
    expect(current.getAttribute('aria-current')).toBe('step');
  });

  it('fires onStepClick only for clickable steps', () => {
    const onStepClick = vi.fn();
    render(<Timeline steps={baseSteps} onStepClick={onStepClick} />);
    // Clickable step → button
    fireEvent.click(screen.getByLabelText(/Pipeline step triage/));
    expect(onStepClick).toHaveBeenCalledWith('triage');
    // Non-clickable step → div, no firing
    onStepClick.mockClear();
    fireEvent.click(screen.getByLabelText(/Pipeline step review/));
    expect(onStepClick).not.toHaveBeenCalled();
  });

  it('renders skipped steps with line-through styling', () => {
    render(<Timeline steps={baseSteps} />);
    const skipped = screen.getByLabelText(/Pipeline step release/);
    expect(skipped.className).toContain('line-through');
  });
});
