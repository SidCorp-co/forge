export interface WidgetSession {
  documentId: string;
  title: string;
  updatedAt: string;
}

export class WidgetAPI {
  constructor(private apiUrl: string, private apiKey: string) {}

  private get headers(): Record<string, string> {
    return { 'X-Forge-API-Key': this.apiKey, 'Content-Type': 'application/json' };
  }

  async sendChat(
    message: string,
    sessionId?: string,
    requestId?: string,
    hubToken?: string,
    hubContext?: object
  ): Promise<{ data: { sessionId: string; streaming?: boolean; reply?: string; toolCalls?: any[] } }> {
    const res = await fetch(`${this.apiUrl}/api/chat`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ message, sessionId, requestId, hubToken, hubContext }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async listSessions(hubToken?: string): Promise<WidgetSession[]> {
    let url = `${this.apiUrl}/api/chat-sessions?sort=updatedAt:desc&pagination[pageSize]=20&fields[0]=title&fields[1]=updatedAt`;
    if (hubToken) url += `&hubToken=${encodeURIComponent(hubToken)}`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.data || []).map((s: any) => ({
      documentId: s.documentId,
      title: s.title || 'Untitled',
      updatedAt: s.updatedAt,
    }));
  }

  async getSession(sessionId: string): Promise<{ messages: any[] } | null> {
    const res = await fetch(
      `${this.apiUrl}/api/chat-sessions/${sessionId}`,
      { headers: this.headers },
    );
    if (!res.ok) return null;
    const json = await res.json();
    return json.data || null;
  }
}
