import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { AppError } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";

/** Client errors raised by express middleware (body parser, static files). */
const isHttpClientError = (err: unknown): err is { status: number; type?: unknown } =>
  typeof err === "object" && err !== null && "status" in err && typeof err.status === "number" && err.status >= 400 && err.status < 500;

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, _next) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
      return;
    }
    if (isHttpClientError(err)) {
      // Body-parser errors carry a type; their messages may echo input, so none are passed on.
      res
        .status(err.status)
        .json(
          err.type
            ? { error: { code: "INVALID_BODY", message: "Request body could not be read" } }
            : { error: { code: err.status === 404 ? "NOT_FOUND" : "BAD_REQUEST", message: "Request could not be handled" } },
        );
      return;
    }
    logger.error({ err, method: req.method, path: req.path }, "unhandled error");
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  };
}
