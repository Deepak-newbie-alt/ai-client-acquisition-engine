export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

/**
 * Calls the backend through the same-origin /api proxy. State-changing
 * requests carry the CSRF header the API requires for cookie sessions.
 */
export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["x-ace-csrf"] = "1";

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: "same-origin",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as (T & ErrorBody) | null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error?.code ?? `HTTP_${res.status}`,
      data?.error?.message ?? (res.status >= 500 ? "The server could not complete the request" : res.statusText),
      data?.error?.details,
    );
  }
  return data as T;
}

export const usd = (micros: string | number | null | undefined) =>
  micros == null ? "-" : `$${(Number(micros) / 1_000_000).toFixed(micros && Number(micros) < 10_000 ? 4 : 2)}`;

export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "-");

/** Only http(s) URLs are ever rendered as links. */
export const safeHref = (url: string) => (/^https?:\/\//i.test(url) ? url : undefined);
