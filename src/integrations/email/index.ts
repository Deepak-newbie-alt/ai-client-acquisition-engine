import type { AppConfig } from "../../config/env.js";
import { emailDomain } from "../../lib/email.js";
import { createGoogleGmailApi, GmailEmailProvider } from "./gmail.js";
import { MockEmailProvider } from "./mock.js";
import { EmailSendError, type EmailProvider } from "./types.js";

/**
 * Refuses (as a definite, nothing-sent failure) any recipient that is not on
 * the allowlist. Used to keep development and staging from emailing real people.
 */
export function withRecipientAllowlist(provider: EmailProvider, allowlist: readonly string[]): EmailProvider {
  const allowed = new Set(allowlist.map((v) => v.toLowerCase()));
  return {
    name: provider.name,
    senderAddress: provider.senderAddress,
    findSent: (id) => provider.findSent(id),
    repliesInThread: (threadId, after) => provider.repliesInThread(threadId, after),
    send: (email) => {
      const to = email.to.toLowerCase();
      if (!allowed.has(to) && !allowed.has(emailDomain(to))) {
        return Promise.reject(new EmailSendError("FAILURE", "NOT_ALLOWLISTED", "Recipient is not on EMAIL_RECIPIENT_ALLOWLIST; nothing was sent"));
      }
      return provider.send(email);
    },
  };
}

export function createEmailProvider(config: AppConfig): EmailProvider {
  const provider =
    config.email.provider === "gmail"
      ? new GmailEmailProvider(createGoogleGmailApi(config.email), config.email.senderAddress)
      : new MockEmailProvider();
  return config.outreach.recipientAllowlist ? withRecipientAllowlist(provider, config.outreach.recipientAllowlist) : provider;
}
