import { auth, gmail } from "@googleapis/gmail";
import { buildMimeMessage } from "./mime.js";
import { EmailSendError, type EmailProvider, type InboundReply, type OutgoingEmail, type SentEmail } from "./types.js";

/** The few Gmail API calls this app needs, so the provider can be tested without Google. */
export interface GmailApi {
  send(raw: string): Promise<{ id: string; threadId: string | null }>;
  findByRfcMessageId(rfcMessageId: string): Promise<{ id: string; threadId: string | null } | null>;
  threadMessages(threadId: string): Promise<{ from: string; internalDate: number; snippet: string }[]>;
}

// Never let the HTTP client retry a send on its own: a retried send after a
// lost response is exactly how duplicate emails happen.
const REQUEST_OPTIONS = { retry: false, timeout: 30_000 };

export function createGoogleGmailApi(credentials: { clientId: string; clientSecret: string; refreshToken: string }): GmailApi {
  const oauth = new auth.OAuth2(credentials.clientId, credentials.clientSecret);
  oauth.setCredentials({ refresh_token: credentials.refreshToken });
  const api = gmail({ version: "v1", auth: oauth });

  return {
    async send(raw) {
      const res = await api.users.messages.send({ userId: "me", requestBody: { raw } }, REQUEST_OPTIONS);
      if (!res.data.id) throw new Error("Gmail returned no message id");
      return { id: res.data.id, threadId: res.data.threadId ?? null };
    },
    async findByRfcMessageId(rfcMessageId) {
      const res = await api.users.messages.list({ userId: "me", q: `rfc822msgid:${rfcMessageId}`, maxResults: 1 }, REQUEST_OPTIONS);
      const first = res.data.messages?.[0];
      return first?.id ? { id: first.id, threadId: first.threadId ?? null } : null;
    },
    async threadMessages(threadId) {
      const res = await api.users.threads.get({ userId: "me", id: threadId, format: "metadata", metadataHeaders: ["From"] }, REQUEST_OPTIONS);
      return (res.data.messages ?? []).map((m) => ({
        from: m.payload?.headers?.find((h) => h.name?.toLowerCase() === "from")?.value ?? "",
        internalDate: Number(m.internalDate ?? 0),
        snippet: m.snippet ?? "",
      }));
    },
  };
}

function statusOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { status?: unknown; response?: { status?: unknown } };
  const status = typeof e.status === "number" ? e.status : e.response?.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * A 4xx (other than 408) means Gmail refused the request, so nothing was sent.
 * Anything else (5xx, timeout, connection loss) may or may not have been sent.
 */
export function classifyGmailError(err: unknown): EmailSendError {
  const status = statusOf(err);
  if (status === 401 || status === 403) return new EmailSendError("FAILURE", "AUTH", `Gmail rejected the credentials (HTTP ${status})`);
  if (status === 429) return new EmailSendError("FAILURE", "RATE_LIMITED", "Gmail rate limit reached; message not sent");
  if (status !== undefined && status >= 400 && status < 500 && status !== 408) {
    return new EmailSendError("FAILURE", "REJECTED", `Gmail rejected the message (HTTP ${status})`);
  }
  return new EmailSendError("UNKNOWN", status ? "SERVER_ERROR" : "NO_RESPONSE", "Gmail did not confirm the send; it may or may not have been delivered");
}

const addressOf = (header: string) => (/<([^>]+)>/.exec(header)?.[1] ?? header).trim().toLowerCase();

export class GmailEmailProvider implements EmailProvider {
  readonly name = "gmail";

  constructor(
    private readonly api: GmailApi,
    readonly senderAddress: string,
  ) {}

  async send(email: OutgoingEmail): Promise<SentEmail> {
    const raw = Buffer.from(buildMimeMessage(email)).toString("base64url");
    try {
      const res = await this.api.send(raw);
      return { providerMessageId: res.id, threadId: res.threadId };
    } catch (err) {
      throw classifyGmailError(err);
    }
  }

  async findSent(rfcMessageId: string): Promise<SentEmail | null> {
    const found = await this.api.findByRfcMessageId(rfcMessageId);
    return found ? { providerMessageId: found.id, threadId: found.threadId } : null;
  }

  async repliesInThread(threadId: string, after: Date): Promise<InboundReply[]> {
    const sender = this.senderAddress.toLowerCase();
    return (await this.api.threadMessages(threadId))
      .filter((m) => addressOf(m.from) !== sender && m.internalDate > after.getTime())
      .map((m) => ({ receivedAt: new Date(m.internalDate), text: m.snippet }));
  }
}
