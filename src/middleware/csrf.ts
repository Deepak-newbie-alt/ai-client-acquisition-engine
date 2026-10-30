import type { RequestHandler } from "express";
import { AppError } from "../lib/errors.js";

export const CSRF_HEADER = "x-ace-csrf";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Cookie-authenticated (or anonymous, e.g. login) state-changing requests must
 * carry a custom header, which a cross-site page cannot set without a CORS
 * preflight the API never approves. A mismatched Origin is also refused.
 * Bearer-token requests are exempt: browsers never attach them automatically.
 */
export function csrfProtection(appOrigin: string): RequestHandler {
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method) || req.authMethod === "bearer") return next();
    const origin = req.get("origin");
    if (req.get(CSRF_HEADER) !== "1" || (origin !== undefined && origin !== appOrigin)) {
      throw new AppError(403, "CSRF_CHECK_FAILED", "Missing or invalid CSRF protection");
    }
    next();
  };
}
