import { pino, type DestinationStream, type Logger } from "pino";

export type { Logger };

const MAX_CAUSE_DEPTH = 3;

/**
 * Logs only an error's identity, never its other properties: SDK and HTTP
 * client errors often carry the request config, including auth headers.
 */
export function serializeError(err: unknown, depth = 0): unknown {
  if (!(err instanceof Error)) return typeof err === "string" ? err : { type: typeof err };
  const out: Record<string, unknown> = { type: err.name, message: err.message, stack: err.stack };
  for (const key of ["code", "status", "outcome"] as const) {
    const value = (err as unknown as Record<string, unknown>)[key];
    if (typeof value === "string" || typeof value === "number") out[key] = value;
  }
  if (err.cause !== undefined && depth < MAX_CAUSE_DEPTH) out.cause = serializeError(err.cause, depth + 1);
  return out;
}

export function createLogger(level: string, destination?: DestinationStream): Logger {
  const options = {
    level,
    serializers: { err: serializeError },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers['set-cookie']",
        "*.password",
        "*.token",
        "*.apiKey",
        "*.secret",
        "*.clientSecret",
        "*.refreshToken",
        "*.authorization",
        "*.headers.authorization",
        "*.headers['x-api-key']",
      ],
      censor: "[redacted]",
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
