// Consistent fetch utility for API calls with error handling
export async function fetchJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, init);
  await assertOk(res, `Request failed: ${url}`);
  return parseJsonResponse<T>(res);
}
export class ApiError extends Error {
  public readonly status: number;
  public readonly body?: string;
  constructor(message: string, status: number, body?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export async function parseJsonResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(
      `Invalid JSON response (HTTP ${res.status}): ${text.slice(0, 120)}`,
      res.status,
      text,
    );
  }
}

export async function assertOk(
  res: Response,
  fallbackMsg: string,
): Promise<void> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = fallbackMsg;
    try {
      const body = JSON.parse(text);
      if (body?.error) detail = body.error;
    } catch {
      if (text) {
        detail = `${fallbackMsg} (HTTP ${res.status}: ${text.slice(0, 120)})`;
      } else {
        detail = `${fallbackMsg} (HTTP ${res.status})`;
      }
    }
    throw new Error(detail);
  }
}
