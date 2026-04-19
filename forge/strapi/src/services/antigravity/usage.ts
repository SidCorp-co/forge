/**
 * Antigravity Usage/Credits
 *
 * Fetches and parses model usage quotas from Antigravity runner instances.
 */

import type { ModelUsage } from './types';

const DEFAULT_PROXY_URL = 'https://canawan.cleverbee.me/api/remoteai';

function resolveProxyUrl(): string {
    return process.env.ANTIGRAVITY_PROXY_URL || DEFAULT_PROXY_URL;
}

/**
 * Fetch instance-level usage/credits for all models.
 * The /usage endpoint returns HTML with per-model quota bars.
 * No projectId required — this is instance-wide data.
 */
export async function getUsage(projectId: string, baseUrl?: string): Promise<ModelUsage[]> {
    const url = baseUrl || resolveProxyUrl();
    const res = await fetch(`${url}/usage?projectId=${encodeURIComponent(projectId)}`);
    if (!res.ok) {
        throw new Error(`Antigravity usage failed: ${res.status}`);
    }
    const html = await res.text();
    if (!html) {
        throw new Error('Empty response from Antigravity usage');
    }

    return parseUsageFromHtml(html);
}

/**
 * Fetch instance-level usage (legacy — accepts projectId for backward compat).
 */
/** @deprecated Use getUsage(baseUrl) directly. */
export async function getUsageByProject(_projectId: string): Promise<ModelUsage[]> {
    // Usage endpoint only works on direct runner instances, not proxy
    return [];
}

function parseUsageFromHtml(html: string): ModelUsage[] {
    const models: ModelUsage[] = [];
    const creditsHtml = html;

    // Each model block: model name → "Refreshes in ..." → bar segments with widths + colors
    const blockRegex = /font-medium">(.*?)<\/div>.*?opacity-60">(Refreshes in[^<]*)<\/div>.*?class="flex gap-1">(.*?)<\/div>\s*<\/div>\s*<\/div>/gs;

    let match: RegExpExecArray | null;
    while ((match = blockRegex.exec(creditsHtml)) !== null) {
        const model = match[1].trim();
        const refreshLabel = match[2].trim();
        const barsHtml = match[3];

        // Extract width percentages from bar segments
        const widthRegex = /width:\s*([\d.e+-]+)%/g;
        const segments: number[] = [];
        let widthMatch: RegExpExecArray | null;
        while ((widthMatch = widthRegex.exec(barsHtml)) !== null) {
            segments.push(parseFloat(widthMatch[1]));
        }

        // Determine bar color/status from inner bar class
        // bg-foreground = healthy (full remaining), bg-yellow-400 = warning (low remaining)
        const hasYellow = barsHtml.includes('bg-yellow-400');
        const remaining = segments.length > 0
            ? segments.reduce((sum, s) => sum + s, 0) / segments.length
            : 0;

        let status: ModelUsage['status'] = 'full';
        if (remaining < 5) status = 'empty';
        else if (hasYellow) status = 'warning';

        models.push({ model, refreshLabel, segments, remaining, status });
    }

    return models;
}
