interface AnkiConnectResponse {
  result: unknown;
  error: string | null;
}

export class AnkiClient {
  constructor(private baseUrl = 'http://127.0.0.1:8765') {}

  async invoke(action: string, params: Record<string, unknown> = {}): Promise<any> {
    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, version: 6, params }),
    });
    const body = (await res.json()) as AnkiConnectResponse;
    if (body.error) throw new Error(`AnkiConnect ${action}: ${body.error}`);
    return body.result;
  }

  async isUp(): Promise<boolean> {
    try {
      const version = await this.invoke('version');
      return typeof version === 'number';
    } catch {
      return false; // Anki closed / connection refused — treated as "down", never thrown
    }
  }
}
