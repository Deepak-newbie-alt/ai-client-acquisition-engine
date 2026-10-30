import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, serializeError } from "../../src/lib/logger.js";

function capture() {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { logger: createLogger("info", sink), text: () => lines.join("") };
}

describe("logger", () => {
  it("redacts credentials in request headers and well-known fields", () => {
    const { logger, text } = capture();
    logger.info(
      {
        req: { headers: { authorization: "Bearer ace_st_secret1", cookie: "ace_session=secret2" } },
        provider: { apiKey: "secret3", clientSecret: "secret4", refreshToken: "secret5" },
        user: { password: "secret6" },
      },
      "request",
    );
    const out = text();
    for (const secret of ["secret1", "secret2", "secret3", "secret4", "secret5", "secret6"]) expect(out).not.toContain(secret);
    expect(out).toContain("[redacted]");
  });

  it("logs only an error's identity, never attached request config", () => {
    const cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET", config: { headers: { Authorization: "Bearer ya29.token" } } });
    const err = Object.assign(new Error("send failed", { cause }), { status: 502, response: { data: "secret body" } });
    const { logger, text } = capture();
    logger.error({ err }, "failed");
    const out = text();
    expect(out).toContain("send failed");
    expect(out).toContain("socket hang up");
    expect(out).toContain("ECONNRESET");
    expect(out).not.toContain("ya29.token");
    expect(out).not.toContain("secret body");
  });

  it("bounds cause chains", () => {
    const loop = new Error("loop");
    (loop as { cause?: unknown }).cause = loop;
    expect(JSON.stringify(serializeError(loop))).toContain("loop");
  });
});
