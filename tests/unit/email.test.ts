import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { classifyGmailError, GmailEmailProvider, type GmailApi } from "../../src/integrations/email/gmail.js";
import { withRecipientAllowlist } from "../../src/integrations/email/index.js";
import { buildMimeMessage } from "../../src/integrations/email/mime.js";
import { MockEmailProvider } from "../../src/integrations/email/mock.js";
import { EmailSendError, type OutgoingEmail } from "../../src/integrations/email/types.js";
import {
  bodySchema,
  checkGeneratedDraft,
  isOptOut,
  OPT_OUT_LINE,
  templateDraft,
  withFooter,
  type DraftFacts,
} from "../../src/modules/outreach/content.js";

const email: OutgoingEmail = {
  from: { name: "Dana Smith", address: "dana@sender.example.com" },
  to: "owner@example.com",
  subject: "Question about scheduling",
  body: "Hi,\nHow do you schedule jobs today?\n",
  rfcMessageId: "<abc-123@sender.example.com>",
  listUnsubscribe: "<mailto:dana@sender.example.com?subject=unsubscribe>",
};

const decodeBody = (mime: string) => Buffer.from(mime.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").toString("utf8");

describe("buildMimeMessage", () => {
  it("builds a plain-text message with the pre-generated Message-ID", () => {
    const mime = buildMimeMessage(email, new Date("2026-10-30T10:00:00Z"));
    const headers = mime.split("\r\n\r\n")[0]!.split("\r\n");
    expect(headers).toEqual([
      'From: "Dana Smith" <dana@sender.example.com>',
      "To: owner@example.com",
      "Subject: Question about scheduling",
      "Date: Fri, 30 Oct 2026 10:00:00 GMT",
      "Message-ID: <abc-123@sender.example.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "List-Unsubscribe: <mailto:dana@sender.example.com?subject=unsubscribe>",
    ]);
    expect(decodeBody(mime)).toBe("Hi,\r\nHow do you schedule jobs today?\r\n");
  });

  it("encodes non-ASCII subjects and names", () => {
    const mime = buildMimeMessage({ ...email, subject: "Planung für Techniker", from: { name: "Zoë", address: "z@sender.example.com" } });
    expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from("Planung für Techniker").toString("base64")}?=`);
    expect(mime).toContain(`From: =?UTF-8?B?${Buffer.from("Zoë").toString("base64")}?= <z@sender.example.com>`);
  });

  it.each([
    ["subject", { subject: "Hi\r\nBcc: everyone@example.com" }],
    ["recipient", { to: "owner@example.com\r\nBcc: x@example.com" }],
    ["sender name", { from: { name: "A\nB", address: "a@example.com" } }],
  ])("refuses header injection through the %s", (_label, change) => {
    expect(() => buildMimeMessage({ ...email, ...change })).toThrow(/Unsafe characters/);
  });
});

describe("classifyGmailError", () => {
  it.each([
    [{ status: 400 }, "FAILURE", "REJECTED"],
    [{ response: { status: 403 } }, "FAILURE", "AUTH"],
    [{ status: 401 }, "FAILURE", "AUTH"],
    [{ status: 429 }, "FAILURE", "RATE_LIMITED"],
    [{ status: 408 }, "UNKNOWN", "SERVER_ERROR"],
    [{ status: 500 }, "UNKNOWN", "SERVER_ERROR"],
    [{ status: 503 }, "UNKNOWN", "SERVER_ERROR"],
    [new Error("socket hang up"), "UNKNOWN", "NO_RESPONSE"],
  ])("classifies %j as %s", (err, outcome, code) => {
    expect(classifyGmailError(err)).toMatchObject({ outcome, code });
  });
});

describe("GmailEmailProvider", () => {
  function fakeApi(overrides: Partial<GmailApi> = {}) {
    const raws: string[] = [];
    const api: GmailApi = {
      send: (raw) => {
        raws.push(raw);
        return Promise.resolve({ id: "gm-1", threadId: "th-1" });
      },
      findByRfcMessageId: (id) => Promise.resolve(id === email.rfcMessageId ? { id: "gm-1", threadId: "th-1" } : null),
      threadMessages: () =>
        Promise.resolve([
          { from: "Dana <DANA@sender.example.com>", internalDate: 1_000, snippet: "original" },
          { from: "Owner <owner@example.com>", internalDate: 500, snippet: "older than our send" },
          { from: "Owner <owner@example.com>", internalDate: 2_000, snippet: "please unsubscribe" },
        ]),
      ...overrides,
    };
    return { api, raws };
  }

  it("sends a base64url RFC 5322 message", async () => {
    const { api, raws } = fakeApi();
    const provider = new GmailEmailProvider(api, "dana@sender.example.com");
    expect(await provider.send(email)).toEqual({ providerMessageId: "gm-1", threadId: "th-1" });
    const mime = Buffer.from(raws[0]!, "base64url").toString("utf8");
    expect(mime).toContain("To: owner@example.com\r\n");
    expect(mime).toContain("Message-ID: <abc-123@sender.example.com>\r\n");
  });

  it("maps API errors to definite or uncertain outcomes", async () => {
    const rejecting = new GmailEmailProvider(fakeApi({ send: () => Promise.reject(Object.assign(new Error("bad"), { status: 400 })) }).api, "d@x.com");
    await expect(rejecting.send(email)).rejects.toMatchObject({ outcome: "FAILURE" });
    const timingOut = new GmailEmailProvider(fakeApi({ send: () => Promise.reject(new Error("ETIMEDOUT")) }).api, "d@x.com");
    await expect(timingOut.send(email)).rejects.toMatchObject({ outcome: "UNKNOWN" });
  });

  it("finds sent messages and returns only others' later replies", async () => {
    const provider = new GmailEmailProvider(fakeApi().api, "dana@sender.example.com");
    expect(await provider.findSent(email.rfcMessageId)).toEqual({ providerMessageId: "gm-1", threadId: "th-1" });
    expect(await provider.findSent("<other@x>")).toBeNull();
    expect(await provider.repliesInThread("th-1", new Date(1_000))).toEqual([{ receivedAt: new Date(2_000), text: "please unsubscribe" }]);
  });
});

describe("withRecipientAllowlist", () => {
  it("refuses recipients outside the allowlist without calling the provider", async () => {
    const mock = new MockEmailProvider();
    const guarded = withRecipientAllowlist(mock, ["me@mine.example.com", "test.example.org"]);
    await expect(guarded.send(email)).rejects.toMatchObject({ outcome: "FAILURE", code: "NOT_ALLOWLISTED" });
    expect(mock.attempts).toBe(0);
    await expect(guarded.send({ ...email, to: "Me@Mine.example.com" })).resolves.toBeTruthy();
    await expect(guarded.send({ ...email, to: "anyone@test.example.org" })).resolves.toBeTruthy();
    expect(mock.attempts).toBe(2);
  });

  it("is required for Gmail outside production", () => {
    const base = {
      APP_ORIGIN: "http://localhost:5173",
      DATABASE_URL: "postgresql://u:p@127.0.0.1:5433/ace_dev",
      EMAIL_PROVIDER: "gmail",
      GMAIL_CLIENT_ID: "id",
      GMAIL_CLIENT_SECRET: "secret",
      GMAIL_REFRESH_TOKEN: "token",
      GMAIL_SENDER_ADDRESS: "me@example.com",
    };
    expect(() => loadConfig({ ...base, NODE_ENV: "development" })).toThrow(/EMAIL_RECIPIENT_ALLOWLIST/);
    expect(loadConfig({ ...base, NODE_ENV: "development", EMAIL_RECIPIENT_ALLOWLIST: "me@example.com, test.example.org" }).outreach.recipientAllowlist).toEqual([
      "me@example.com",
      "test.example.org",
    ]);
    expect(loadConfig({ ...base, NODE_ENV: "production", APP_ORIGIN: "https://ace.example.com" }).outreach.recipientAllowlist).toBeNull();
  });

  it("mock provider behaviours model definite and uncertain outcomes", async () => {
    const mock = new MockEmailProvider();
    mock.behavior = "timeout-delivered";
    await expect(mock.send(email)).rejects.toBeInstanceOf(EmailSendError);
    expect(await mock.findSent(email.rfcMessageId)).not.toBeNull();
    mock.behavior = "timeout-lost";
    await expect(mock.send({ ...email, rfcMessageId: "<lost@x>" })).rejects.toMatchObject({ outcome: "UNKNOWN" });
    expect(await mock.findSent("<lost@x>")).toBeNull();
  });
});

describe("outreach content rules", () => {
  const outreach = { senderName: "Dana Smith", postalAddress: "1 High St, Springfield", recipientAllowlist: null, reconcileGraceMinutes: 15 };

  it("adds sender identity and the opt-out line, which edits must keep", () => {
    const body = withFooter("Hi there, quick question.", outreach);
    expect(body).toBe(`Hi there, quick question.\n\n--\nDana Smith\n1 High St, Springfield\n${OPT_OUT_LINE}`);
    expect(bodySchema.safeParse(body).success).toBe(true);
    expect(bodySchema.safeParse("Hi there, quick question without the footer.").success).toBe(false);
  });

  it.each([
    ["Please unsubscribe me", true],
    ["Remove me from your list", true],
    ["Not interested, thanks", true],
    ["Stop emailing us", true],
    ["Don't contact me again", true],
    ["Thanks! Can you tell me more about scheduling?", false],
    ["We'd be interested in a call", false],
  ])("detects opt-out in %j: %s", (text, expected) => {
    expect(isOptOut(text)).toBe(expected);
  });

  it.each([
    ["a link", { subject: "Quick question", body: "See https://example.com/offer for details about our product." }],
    ["a bare domain path", { subject: "Quick question", body: "Visit example.com/offer to learn more about this thing." }],
    ["an email address", { subject: "Quick question", body: "Write to sales@example.com and we can talk about it." }],
    ["extra fields", { subject: "Quick question", body: "A perfectly ordinary body with enough length.", to: "x@y.z" }],
  ])("rejects generated drafts containing %s", (_label, draft) => {
    expect(checkGeneratedDraft(draft).ok).toBe(false);
  });

  it("flattens line breaks in generated subjects so they cannot inject headers", () => {
    const result = checkGeneratedDraft({ subject: "Hello\nBcc: x@example.com", body: "A perfectly ordinary body with enough length to pass." });
    expect(result).toMatchObject({ ok: true, subject: "Hello Bcc: x@example.com" });
  });

  it("only quotes the recipient's own published text in the template draft", () => {
    const facts: DraftFacts = {
      senderName: "Dana",
      company: { name: "Example HVAC", domain: "example.com" },
      contact: { name: "Pat Lee", role: "Owner" },
      problem: { title: "manual scheduling", description: "Dispatchers rebuild schedules in spreadsheets." },
      evidence: [{ excerpt: "Another firm said scheduling takes hours.", sourceUrl: "https://example.net/x", fromThisCompany: false }],
      isFollowUp: false,
    };
    const draft = templateDraft(facts);
    expect(draft.body).toContain("Hi Pat,");
    expect(draft.body).not.toContain("Another firm said");
    expect(draft.body).not.toContain("I read on your website");
    expect(checkGeneratedDraft(draft).ok).toBe(true);
  });
});
