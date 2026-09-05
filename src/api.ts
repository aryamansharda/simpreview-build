type JSONValue = Record<string, unknown>;

export class PrestoAPIError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PrestoAPIError';
  }
}

export async function api<T extends JSONValue>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body) headers.set('content-type', 'application/json');
  const response = await fetch(url, { ...init, headers });
  const body = await response.json().catch(() => ({})) as T & {
    error?: { code?: string; message?: string; details?: Record<string, unknown> };
  };
  if (!response.ok) {
    throw new PrestoAPIError(
      body.error?.code || 'presto_api_error',
      body.error?.message || `Presto API returned ${response.status}.`,
      response.status,
      body.error?.details,
    );
  }
  return body;
}
