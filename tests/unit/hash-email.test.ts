import { describe, expect, it } from "vitest";
import { emailDomain, isValidEmail, normalizeEmail } from "../../src/lib/email.js";
import { outreachContentHash, sha256Hex, textContentHash } from "../../src/lib/hash.js";

describe("normalizeEmail", () => {
  it("trims and lowercases without rewriting the mailbox", () => {
    expect(normalizeEmail("  Jane.Doe+Sales@Example.COM ")).toBe("jane.doe+sales@example.com");
  });

  it("validates and extracts the domain", () => {
    expect(isValidEmail("ops@example.com")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("a@b@example.com")).toBe(false);
    expect(emailDomain("Ops@Sub.Example.com")).toBe("sub.example.com");
    expect(() => emailDomain("nope")).toThrow();
  });
});

describe("textContentHash", () => {
  it("matches syndicated copies that differ only in whitespace and case", () => {
    const original = "Scheduling technicians\n\ntakes   our team hours every week.";
    const copy = "  scheduling technicians takes our team HOURS every week. ";
    expect(textContentHash(copy)).toBe(textContentHash(original));
    expect(textContentHash("A different article.")).not.toBe(textContentHash(original));
  });

  it("produces a hex SHA-256", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("outreachContentHash", () => {
  const base = {
    recipientEmail: "owner@example.com",
    subject: "Question about dispatch scheduling",
    body: "Hi,\nI noticed your job posts mention manual scheduling.\n",
  };
  const hash = outreachContentHash(base);

  it("is stable across recipient case and line-ending style", () => {
    expect(
      outreachContentHash({ ...base, recipientEmail: " Owner@Example.com", body: base.body.replace(/\n/g, "\r\n") }),
    ).toBe(hash);
  });

  it.each([
    ["recipient", { recipientEmail: "other@example.com" }],
    ["subject", { subject: base.subject + "?" }],
    ["subject whitespace", { subject: base.subject + " " }],
    ["body", { body: base.body.replace("manual", "Manual") }],
    ["body trailing content", { body: base.body + "P.S." }],
  ])("changes when the %s changes", (_label, change) => {
    expect(outreachContentHash({ ...base, ...change })).not.toBe(hash);
  });

  it("cannot be forged by moving text between fields", () => {
    expect(outreachContentHash({ ...base, subject: "ab", body: "c" })).not.toBe(
      outreachContentHash({ ...base, subject: "a", body: "bc" }),
    );
  });
});
