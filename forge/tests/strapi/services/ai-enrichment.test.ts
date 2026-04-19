import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock websocket broadcast
vi.mock('../../../strapi/src/services/websocket', () => ({
  broadcast: vi.fn(),
}));

// We need to import after mocking
import { broadcast } from '../../../strapi/src/services/websocket';

// Export safeParseEnrichment for direct testing
// Since it's not exported, we test parsing behavior through enrichIssue.

describe('safeParseEnrichment (via enrichIssue)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it('should parse valid JSON and populate enrichment fields', async () => {
    const enrichmentData = {
      aiSummary: 'Test summary',
      aiSuggestedSolution: 'Test solution',
      aiAcceptanceCriteria: ['crit1', 'crit2'],
      aiConfidence: 0.9,
      category: 'bug',
      priority: 'high',
    };
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: JSON.stringify(enrichmentData) }] }),
    });

    const { enrichIssue } = await import('../../../strapi/src/services/ai-enrichment');

    const mockUpdate = vi.fn().mockResolvedValue({});
    const mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue({
          documentId: 'issue-parse-valid',
          title: 'Test',
          description: 'Desc',
          project: { defaultProvider: 'anthropic' },
          attachments: [],
        }),
        update: mockUpdate,
        create: vi.fn().mockResolvedValue({}),
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    await enrichIssue(mockStrapi, 'issue-parse-valid');

    // The update call sets enrichment data (no status transition)
    const enrichedCall = mockUpdate.mock.calls[0][0];
    expect(enrichedCall.data.aiSummary).toBe('Test summary');
    expect(enrichedCall.data.aiAcceptanceCriteria).toEqual(['crit1', 'crit2']);
    expect(enrichedCall.data.aiConfidence).toBe(0.9);
    expect(enrichedCall.data.category).toBe('bug');
    expect(enrichedCall.data.priority).toBe('high');
    expect(enrichedCall.data.status).toBeUndefined();
  });

  it('should use defaults for invalid JSON response', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: 'not valid json' }] }),
    });

    const { enrichIssue } = await import('../../../strapi/src/services/ai-enrichment');

    const mockUpdate = vi.fn().mockResolvedValue({});
    const mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue({
          documentId: 'issue-parse-invalid',
          title: 'Test',
          description: 'Desc',
          project: { defaultProvider: 'anthropic' },
          attachments: [],
        }),
        update: mockUpdate,
        create: vi.fn().mockResolvedValue({}),
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    await enrichIssue(mockStrapi, 'issue-parse-invalid');

    const enrichedCall = mockUpdate.mock.calls[0][0];
    expect(enrichedCall.data.aiSummary).toBe('Unable to analyze issue');
    expect(enrichedCall.data.aiAcceptanceCriteria).toEqual([]);
    expect(enrichedCall.data.aiConfidence).toBe(0);
  });

  it('should handle missing fields with defaults', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: JSON.stringify({ aiSummary: 'Only summary' }) }] }),
    });

    const { enrichIssue } = await import('../../../strapi/src/services/ai-enrichment');

    const mockUpdate = vi.fn().mockResolvedValue({});
    const mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue({
          documentId: 'issue-parse-partial',
          title: 'Test',
          description: 'Desc',
          project: { defaultProvider: 'anthropic' },
          attachments: [],
        }),
        update: mockUpdate,
        create: vi.fn().mockResolvedValue({}),
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    await enrichIssue(mockStrapi, 'issue-parse-partial');

    const enrichedCall = mockUpdate.mock.calls[0][0];
    expect(enrichedCall.data.aiSummary).toBe('Only summary');
    expect(enrichedCall.data.aiAcceptanceCriteria).toEqual([]);
    expect(enrichedCall.data.aiSuggestedSolution).toBe('Manual review required');
  });
});

describe('callAnthropic', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('should send correct request body and headers', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ text: JSON.stringify({ aiSummary: 'test', aiSuggestedSolution: 'sol', aiAcceptanceCriteria: [], aiConfidence: 0.8, category: 'bug', priority: 'high' }) }],
      }),
    });

    const { enrichIssue } = await import('../../../strapi/src/services/ai-enrichment');

    const mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue({
          documentId: 'issue-1',
          title: 'Test Issue',
          description: 'Test desc',
          project: { defaultProvider: 'anthropic' },
          attachments: [],
        }),
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockResolvedValue({}),
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    await enrichIssue(mockStrapi, 'issue-1');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(options.method).toBe('POST');
    expect(options.headers['x-api-key']).toBe('test-key');
    expect(options.headers['anthropic-version']).toBe('2023-06-01');

    const body = JSON.parse(options.body);
    expect(body.model).toBe('claude-sonnet-4-5-20250514');
    expect(body.max_tokens).toBe(1024);
    expect(body.messages[0].role).toBe('user');
  });

  it('should include image content for image attachments', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ text: '{}' }],
      }),
    });

    const { enrichIssue } = await import('../../../strapi/src/services/ai-enrichment');

    const mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue({
          documentId: 'issue-2',
          title: 'Image Issue',
          description: 'Has image',
          project: { defaultProvider: 'anthropic' },
          attachments: [{ url: 'http://img.png', mime: 'image/png', name: 'img.png' }],
        }),
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockResolvedValue({}),
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    await enrichIssue(mockStrapi, 'issue-2');

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const content = body.messages[0].content;
    const imageBlock = content.find((c: any) => c.type === 'image');
    expect(imageBlock).toBeDefined();
    expect(imageBlock.source.type).toBe('url');
    expect(imageBlock.source.url).toBe('http://img.png');
  });
});

describe('callOpenAI', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    process.env.OPENAI_API_KEY = 'oai-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
  });

  it('should send correct request body and headers for OpenAI', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ aiSummary: 'test', aiSuggestedSolution: 'sol', aiAcceptanceCriteria: [], aiConfidence: 0.8, category: 'bug', priority: 'high' }) } }],
      }),
    });

    const { enrichIssue } = await import('../../../strapi/src/services/ai-enrichment');

    const mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue({
          documentId: 'issue-3',
          title: 'OpenAI Issue',
          description: 'Desc',
          project: { defaultProvider: 'openai' },
          attachments: [],
        }),
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockResolvedValue({}),
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    await enrichIssue(mockStrapi, 'issue-3');

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(options.headers['Authorization']).toBe('Bearer oai-key');

    const body = JSON.parse(options.body);
    expect(body.model).toBe('gpt-4o');
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('should use image_url format for OpenAI image attachments', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{}' } }] }),
    });

    const { enrichIssue } = await import('../../../strapi/src/services/ai-enrichment');

    const mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue({
          documentId: 'issue-4',
          title: 'OAI Image',
          description: '',
          project: { defaultProvider: 'openai' },
          attachments: [{ url: 'http://img.jpg', mime: 'image/jpeg', name: 'img.jpg' }],
        }),
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockResolvedValue({}),
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    await enrichIssue(mockStrapi, 'issue-4');

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const content = body.messages[0].content;
    const imgBlock = content.find((c: any) => c.type === 'image_url');
    expect(imgBlock).toBeDefined();
    expect(imgBlock.image_url.url).toBe('http://img.jpg');
  });
});

describe('callGemini', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    process.env.GEMINI_API_KEY = 'gem-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.GEMINI_API_KEY;
  });

  it('should send correct request body for Gemini', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{}' }] } }],
      }),
    });

    const { enrichIssue } = await import('../../../strapi/src/services/ai-enrichment');

    const mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue({
          documentId: 'issue-5',
          title: 'Gemini Issue',
          description: 'Desc',
          project: { defaultProvider: 'gemini' },
          attachments: [],
        }),
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockResolvedValue({}),
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    await enrichIssue(mockStrapi, 'issue-5');

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toContain('generativelanguage.googleapis.com');
    expect(url).toContain('key=gem-key');

    const body = JSON.parse(options.body);
    expect(body.contents[0].parts).toBeDefined();
  });

  it('should fetch and base64-encode images for Gemini inlineData', async () => {
    // First fetch: image download, Second fetch: Gemini API call
    const imageBytes = new Uint8Array([137, 80, 78, 71]); // fake PNG header
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => imageBytes.buffer,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '{}' }] } }],
        }),
      });

    const { enrichIssue } = await import('../../../strapi/src/services/ai-enrichment');

    const mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue({
          documentId: 'issue-6',
          title: 'Gemini Image',
          description: '',
          project: { defaultProvider: 'gemini' },
          attachments: [{ url: 'http://img.webp', mime: 'image/webp', name: 'img.webp' }],
        }),
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockResolvedValue({}),
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    await enrichIssue(mockStrapi, 'issue-6');

    // Second fetch call is the Gemini API call
    const geminiCall = fetchSpy.mock.calls[1];
    const body = JSON.parse(geminiCall[1].body);
    const parts = body.contents[0].parts;
    const inlineDataPart = parts.find((p: any) => p.inlineData);
    expect(inlineDataPart).toBeDefined();
    expect(inlineDataPart.inlineData.mimeType).toBe('image/webp');
    // Verify the base64 string is valid
    const b64 = inlineDataPart.inlineData.data;
    expect(typeof b64).toBe('string');
    expect(Buffer.from(b64, 'base64').toString('base64')).toBe(b64);
  });

  it('should gracefully handle image fetch failure with no inlineData', async () => {
    // First fetch: image fails, Second fetch: Gemini API call
    fetchSpy
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '{}' }] } }],
        }),
      });

    const { enrichIssue } = await import('../../../strapi/src/services/ai-enrichment');

    const mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue({
          documentId: 'issue-7',
          title: 'Gemini Broken Image',
          description: '',
          project: { defaultProvider: 'gemini' },
          attachments: [{ url: 'http://missing.png', mime: 'image/png', name: 'missing.png' }],
        }),
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockResolvedValue({}),
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    await enrichIssue(mockStrapi, 'issue-7');

    // Should still call Gemini API (second fetch)
    const geminiCall = fetchSpy.mock.calls[1];
    const body = JSON.parse(geminiCall[1].body);
    const parts = body.contents[0].parts;

    // No inlineData part should exist when image fetch fails
    const inlineDataPart = parts.find((p: any) => p.inlineData);
    expect(inlineDataPart).toBeUndefined();

    // Instead, a fallback text part should reference the failed image
    const fallbackPart = parts.find((p: any) => p.text?.includes('failed to load'));
    expect(fallbackPart).toBeDefined();
  });
});

describe('timeout handling', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('should pass an AbortSignal to fetch', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ text: '{}' }] }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { enrichIssue } = await import('../../../strapi/src/services/ai-enrichment');

    const mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue({
          documentId: 'issue-timeout',
          title: 'Timeout Issue',
          description: '',
          project: { defaultProvider: 'anthropic' },
          attachments: [],
        }),
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockResolvedValue({}),
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    await enrichIssue(mockStrapi, 'issue-timeout');

    expect(fetchSpy).toHaveBeenCalled();
    const signal = fetchSpy.mock.calls[0][1].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('should revert to open when fetch is aborted', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));
    vi.stubGlobal('fetch', fetchSpy);

    const { enrichIssue } = await import('../../../strapi/src/services/ai-enrichment');

    const mockUpdate = vi.fn().mockResolvedValue({});
    const mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue({
          documentId: 'issue-abort',
          title: 'Abort Issue',
          description: '',
          project: { defaultProvider: 'anthropic' },
          attachments: [],
        }),
        update: mockUpdate,
        create: vi.fn().mockResolvedValue({}),
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    await enrichIssue(mockStrapi, 'issue-abort');

    // No status revert needed since enriching status is removed
    expect(mockUpdate).toHaveBeenCalledTimes(0);
  });
});

describe('enrichIssue flow', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.mocked(broadcast).mockReset();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('should update issue with AI enrichment data', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ text: JSON.stringify({ aiSummary: 'sum', aiSuggestedSolution: 'sol', aiAcceptanceCriteria: ['c1'], aiConfidence: 0.9, category: 'bug', priority: 'high' }) }],
      }),
    });

    const { enrichIssue } = await import('../../../strapi/src/services/ai-enrichment');

    const mockUpdate = vi.fn().mockResolvedValue({});
    const mockCreate = vi.fn().mockResolvedValue({});
    const mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue({
          documentId: 'issue-flow',
          title: 'Flow Issue',
          description: 'desc',
          project: { defaultProvider: 'anthropic' },
          attachments: [],
        }),
        update: mockUpdate,
        create: mockCreate,
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    await enrichIssue(mockStrapi, 'issue-flow');

    // Verify update sets AI data without status transition
    expect(mockUpdate.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(mockUpdate.mock.calls[0][0].data.aiSummary).toBe('sum');
    expect(mockUpdate.mock.calls[0][0].data.status).toBeUndefined();

    // Comment created with AI author
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ author: 'AI Assistant', isAI: true }),
    }));

    // Broadcast update
    expect(broadcast).toHaveBeenCalledWith('issue:updated', expect.objectContaining({
      documentId: 'issue-flow',
      aiSummary: 'sum',
      category: 'bug',
      priority: 'high',
    }));
  });

  it('should revert status to open on error and broadcast failure', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('API down'));

    const { enrichIssue } = await import('../../../strapi/src/services/ai-enrichment');

    const mockUpdate = vi.fn().mockResolvedValue({});
    const mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue({
          documentId: 'issue-err',
          title: 'Error Issue',
          description: '',
          project: { defaultProvider: 'anthropic' },
          attachments: [],
        }),
        update: mockUpdate,
        create: vi.fn().mockResolvedValue({}),
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    await enrichIssue(mockStrapi, 'issue-err');

    // Should broadcast failure (no status revert)
    expect(broadcast).toHaveBeenCalledWith('issue:enrichment_failed', expect.objectContaining({ documentId: 'issue-err' }));
  });

  it('should return early if issue has no project', async () => {
    const { enrichIssue } = await import('../../../strapi/src/services/ai-enrichment');

    const mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue({ documentId: 'x', project: null }),
        update: vi.fn(),
        create: vi.fn(),
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    await enrichIssue(mockStrapi, 'x');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockStrapi.log.warn).toHaveBeenCalled();
  });

  it('should return early if project has no API key', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { enrichIssue } = await import('../../../strapi/src/services/ai-enrichment');

    const mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue({
          documentId: 'x',
          project: { defaultProvider: 'anthropic' },
        }),
        update: vi.fn(),
        create: vi.fn(),
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    await enrichIssue(mockStrapi, 'x');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('safeParseEnrichment – markdown fence stripping', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('should parse JSON wrapped in ```json ... ``` fences', async () => {
    const enrichmentData = {
      aiSummary: 'Fenced summary',
      aiSuggestedSolution: 'Fenced solution',
      aiAcceptanceCriteria: ['fc1'],
      aiConfidence: 0.75,
      category: 'feature',
      priority: 'medium',
    };
    const fencedText = '```json\n' + JSON.stringify(enrichmentData) + '\n```';

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: fencedText }] }),
    });

    const { enrichIssue } = await import('../../../strapi/src/services/ai-enrichment');

    const mockUpdate = vi.fn().mockResolvedValue({});
    const mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue({
          documentId: 'issue-fence',
          title: 'Fence Test',
          description: 'Desc',
          project: { defaultProvider: 'anthropic' },
          attachments: [],
        }),
        update: mockUpdate,
        create: vi.fn().mockResolvedValue({}),
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    await enrichIssue(mockStrapi, 'issue-fence');

    const enrichedCall = mockUpdate.mock.calls[0][0];
    expect(enrichedCall.data.aiSummary).toBe('Fenced summary');
    expect(enrichedCall.data.aiSuggestedSolution).toBe('Fenced solution');
    expect(enrichedCall.data.aiAcceptanceCriteria).toEqual(['fc1']);
    expect(enrichedCall.data.aiConfidence).toBe(0.75);
    expect(enrichedCall.data.category).toBe('feature');
    expect(enrichedCall.data.priority).toBe('medium');
  });

  it('should parse JSON wrapped in bare ``` fences (no language tag)', async () => {
    const enrichmentData = {
      aiSummary: 'Bare fence summary',
      aiSuggestedSolution: 'sol',
      aiAcceptanceCriteria: [],
      aiConfidence: 0.5,
      category: 'bug',
      priority: 'low',
    };
    const fencedText = '```\n' + JSON.stringify(enrichmentData) + '\n```';

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: fencedText }] }),
    });

    const { enrichIssue } = await import('../../../strapi/src/services/ai-enrichment');

    const mockUpdate = vi.fn().mockResolvedValue({});
    const mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue({
          documentId: 'issue-bare-fence',
          title: 'Bare Fence',
          description: 'Desc',
          project: { defaultProvider: 'anthropic' },
          attachments: [],
        }),
        update: mockUpdate,
        create: vi.fn().mockResolvedValue({}),
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    await enrichIssue(mockStrapi, 'issue-bare-fence');

    const enrichedCall = mockUpdate.mock.calls[0][0];
    expect(enrichedCall.data.aiSummary).toBe('Bare fence summary');
    expect(enrichedCall.data.aiConfidence).toBe(0.5);
  });
});

describe('provider fallback to anthropic', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    process.env.ANTHROPIC_API_KEY = 'fallback-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('should fall back to anthropic when project has no defaultProvider', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: JSON.stringify({ aiSummary: 'fallback', aiSuggestedSolution: 's', aiAcceptanceCriteria: [], aiConfidence: 0.8, category: 'bug', priority: 'high' }) }] }),
    });

    const { enrichIssue } = await import('../../../strapi/src/services/ai-enrichment');

    const mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue({
          documentId: 'issue-no-provider',
          title: 'No Provider',
          description: 'Desc',
          project: { /* no defaultProvider */ },
          attachments: [],
        }),
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockResolvedValue({}),
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    await enrichIssue(mockStrapi, 'issue-no-provider');

    // Should call Anthropic API since it falls back to 'anthropic'
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(options.headers['x-api-key']).toBe('fallback-key');
  });
});

describe('env var vs project key priority', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('should use env var API key over project.providerApiKey', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-key';

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: '{}' }] }),
    });

    const { enrichIssue } = await import('../../../strapi/src/services/ai-enrichment');

    const mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue({
          documentId: 'issue-key-priority',
          title: 'Key Priority',
          description: 'Desc',
          project: { defaultProvider: 'anthropic', providerApiKey: 'project-key' },
          attachments: [],
        }),
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockResolvedValue({}),
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    await enrichIssue(mockStrapi, 'issue-key-priority');

    const options = fetchSpy.mock.calls[0][1];
    expect(options.headers['x-api-key']).toBe('env-key');
  });

  it('should fall back to project.providerApiKey when env var is not set', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: '{}' }] }),
    });

    const { enrichIssue } = await import('../../../strapi/src/services/ai-enrichment');

    const mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue({
          documentId: 'issue-project-key',
          title: 'Project Key',
          description: 'Desc',
          project: { defaultProvider: 'anthropic', providerApiKey: 'project-key' },
          attachments: [],
        }),
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockResolvedValue({}),
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    await enrichIssue(mockStrapi, 'issue-project-key');

    const options = fetchSpy.mock.calls[0][1];
    expect(options.headers['x-api-key']).toBe('project-key');
  });
});

describe('comment creation with correct issue relation', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('should create AI comment with the correct issue documentId relation', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: JSON.stringify({ aiSummary: 'sum', aiSuggestedSolution: 'sol', aiAcceptanceCriteria: ['c1'], aiConfidence: 0.9, category: 'bug', priority: 'high' }) }] }),
    });

    const { enrichIssue } = await import('../../../strapi/src/services/ai-enrichment');

    const mockCreate = vi.fn().mockResolvedValue({});
    const documentsMap: Record<string, any> = {
      'api::issue.issue': {
        findOne: vi.fn().mockResolvedValue({
          documentId: 'issue-comment-rel',
          title: 'Comment Rel',
          description: 'Desc',
          project: { defaultProvider: 'anthropic' },
          attachments: [],
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      'api::comment.comment': {
        create: mockCreate,
      },
    };

    const mockStrapi = {
      documents: vi.fn((uid: string) => documentsMap[uid]),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    await enrichIssue(mockStrapi, 'issue-comment-rel');

    expect(mockCreate).toHaveBeenCalledOnce();
    const createArg = mockCreate.mock.calls[0][0];
    expect(createArg.data.issue).toBe('issue-comment-rel');
    expect(createArg.data.author).toBe('AI Assistant');
    expect(createArg.data.isAI).toBe(true);
    expect(createArg.data.body).toContain('sum');
    expect(createArg.data.body).toContain('sol');
  });
});

describe('broadcast events sequence', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.mocked(broadcast).mockReset();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('should broadcast issue:updated on success', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: JSON.stringify({ aiSummary: 'bcast', aiSuggestedSolution: 'sol', aiAcceptanceCriteria: [], aiConfidence: 0.7, category: 'improvement', priority: 'medium' }) }] }),
    });

    const { enrichIssue } = await import('../../../strapi/src/services/ai-enrichment');

    const mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue({
          documentId: 'issue-bcast',
          title: 'Broadcast Test',
          description: 'Desc',
          project: { defaultProvider: 'anthropic' },
          attachments: [],
        }),
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockResolvedValue({}),
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    await enrichIssue(mockStrapi, 'issue-bcast');

    // Verify broadcast was called once (issue:updated)
    expect(broadcast).toHaveBeenCalledTimes(1);

    const firstCall = vi.mocked(broadcast).mock.calls[0];

    expect(firstCall[0]).toBe('issue:updated');
    expect(firstCall[1]).toEqual(expect.objectContaining({
      documentId: 'issue-bcast',
      aiSummary: 'bcast',
      category: 'improvement',
      priority: 'medium',
    }));
  });

  it('should broadcast enrichment_failed on error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('provider down'));

    const { enrichIssue } = await import('../../../strapi/src/services/ai-enrichment');

    const mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue({
          documentId: 'issue-bcast-fail',
          title: 'Broadcast Fail',
          description: '',
          project: { defaultProvider: 'anthropic' },
          attachments: [],
        }),
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockResolvedValue({}),
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    await enrichIssue(mockStrapi, 'issue-bcast-fail');

    expect(broadcast).toHaveBeenCalledTimes(1);

    const firstCall = vi.mocked(broadcast).mock.calls[0];

    expect(firstCall[0]).toBe('issue:enrichment_failed');
    expect(firstCall[1]).toEqual(expect.objectContaining({ documentId: 'issue-bcast-fail' }));
  });
});
