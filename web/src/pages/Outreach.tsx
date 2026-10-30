import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { api, when } from "../api";
import { Link, navigate } from "../router";
import type { Opportunity } from "../types";
import { Badge, ErrorBox, QueryState, StatusBadge } from "../ui";

type DraftStatus = "DRAFT" | "APPROVED" | "SENDING" | "SENT" | "REJECTED" | "CANCELLED" | "FAILED";

interface DraftSummary {
  id: string;
  status: DraftStatus;
  subject: string;
  recipientEmail: string;
  updatedAt: string;
  contact: { id: string; email: string; name: string | null };
  company: { id: string; name: string };
  opportunity: { id: string; title: string } | null;
}

interface Approval {
  id: string;
  contentHash: string;
  recipientEmail: string;
  approvedAt: string;
  expiresAt: string;
  invalidatedAt: string | null;
  invalidationReason: string | null;
  consumedAt: string | null;
  approvedBy: { displayName: string };
}

interface DraftDetail {
  draft: DraftSummary & {
    body: string;
    contentHash: string;
    contactId: string;
    opportunityId: string | null;
    sendOutcome: "SUCCESS" | "FAILURE" | "UNKNOWN" | null;
    sendAttemptedAt: string | null;
    sentAt: string | null;
    failureReason: string | null;
    repliedAt: string | null;
    optedOutAt: string | null;
    generatedByModel: string | null;
    approvals: Approval[];
    followUpOf: { id: string; subject: string } | null;
    followUps: { id: string; status: DraftStatus; subject: string }[];
  };
  recipientSuppressed: boolean;
  companyContacts: { id: string; email: string; name: string | null; verificationStatus: string }[];
  provider: string;
}

const STATUSES: DraftStatus[] = ["DRAFT", "APPROVED", "SENDING", "SENT", "FAILED", "REJECTED", "CANCELLED"];

export function OutreachPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<DraftStatus | "">("");
  const drafts = useQuery({
    queryKey: ["drafts", status],
    queryFn: () => api<{ drafts: DraftSummary[] }>(`/outreach/drafts${status ? `?status=${status}` : ""}`).then((r) => r.drafts),
  });
  const check = useMutation({
    mutationFn: () => api<{ checked: number; replied: number; optedOut: number; errors: number }>("/outreach/check-replies", { method: "POST" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["drafts"] }),
  });

  return (
    <>
      <h1>Outreach</h1>
      <p className="muted">
        Drafts are created from a company contact. Nothing is sent until a person approves the exact email and then presses Send separately.
      </p>
      <div className="card row">
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value as DraftStatus | "")}>
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.toLowerCase()}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="secondary" onClick={() => check.mutate()} disabled={check.isPending}>
          {check.isPending ? "Checking..." : "Check for replies"}
        </button>
        {check.data && (
          <span className="muted small">
            Checked {check.data.checked} sent emails: {check.data.replied} replied, {check.data.optedOut} opted out
            {check.data.errors ? `, ${check.data.errors} errors` : ""}.
          </span>
        )}
      </div>
      {check.error && <ErrorBox error={check.error} />}
      <QueryState query={drafts} isEmpty={(d) => d.length === 0} empty="No outreach drafts. Create one from a contact on a company page.">
        {(items) => (
          <table>
            <thead>
              <tr>
                <th>Subject</th>
                <th>Recipient</th>
                <th>Status</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Link to={["outreach", d.id]}>{d.subject}</Link>
                    {d.opportunity && <div className="muted small">{d.opportunity.title}</div>}
                  </td>
                  <td>
                    {d.recipientEmail}
                    <div className="muted small">{d.company.name}</div>
                  </td>
                  <td>
                    <StatusBadge status={d.status} />
                  </td>
                  <td className="small">{when(d.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </QueryState>
    </>
  );
}

/** Used on company pages: starts a draft (generated or written by hand) for one contact. */
export function NewDraftForm({ contactId, followUpOfId, onCancel }: { contactId: string; followUpOfId?: string; onCancel: () => void }) {
  const [mode, setMode] = useState<"generate" | "manual">("generate");
  const [opportunityId, setOpportunityId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const opportunities = useQuery({
    queryKey: ["opportunities"],
    queryFn: () => api<{ opportunities: Opportunity[] }>("/opportunities").then((r) => r.opportunities),
  });
  const create = useMutation({
    mutationFn: () =>
      api<{ draft: { id: string } }>("/outreach/drafts", {
        method: "POST",
        body: {
          contactId,
          mode,
          ...(opportunityId ? { opportunityId } : {}),
          ...(followUpOfId ? { followUpOfId } : {}),
          ...(mode === "manual" ? { subject, body } : {}),
        },
      }),
    onSuccess: ({ draft }) => navigate("outreach", draft.id),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <form className="card stack" onSubmit={submit}>
      <div className="row">
        <label>
          About which problem?
          <select value={opportunityId} onChange={(e) => setOpportunityId(e.target.value)}>
            <option value="">General introduction</option>
            {(opportunities.data ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          How
          <select value={mode} onChange={(e) => setMode(e.target.value as "generate" | "manual")}>
            <option value="generate">Generate a draft from the research</option>
            <option value="manual">Write it myself</option>
          </select>
        </label>
      </div>
      {mode === "manual" && (
        <>
          <label>
            Subject
            <input value={subject} onChange={(e) => setSubject(e.target.value)} required />
          </label>
          <label>
            Message (the opt-out footer is added automatically)
            <textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} required />
          </label>
        </>
      )}
      {create.error && <ErrorBox error={create.error} />}
      <div className="form-actions">
        <button type="submit" disabled={create.isPending}>
          {create.isPending ? "Creating..." : "Create draft"}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
        <span className="muted small">Creating a draft never sends anything.</span>
      </div>
    </form>
  );
}

export function DraftDetailPage({ id }: { id: string }) {
  const detail = useQuery({ queryKey: ["draft", id], queryFn: () => api<DraftDetail>(`/outreach/drafts/${id}`) });
  return (
    <>
      <p>
        <Link to={["outreach"]}>&larr; All outreach</Link>
      </p>
      <QueryState query={detail}>{(data) => <DraftView data={data} />}</QueryState>
    </>
  );
}

function DraftView({ data }: { data: DraftDetail }) {
  const { draft } = data;
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["draft", draft.id] });
    void queryClient.invalidateQueries({ queryKey: ["drafts"] });
  };
  const reject = useDraftAction(draft.id, "reject", refresh);
  const cancel = useDraftAction(draft.id, "cancel", refresh);
  const reconcile = useDraftAction(draft.id, "reconcile", refresh);
  const revise = useMutation({
    mutationFn: () => api<{ draft: { id: string } }>(`/outreach/drafts/${draft.id}/revise`, { method: "POST" }),
    onSuccess: ({ draft: next }) => navigate("outreach", next.id),
  });
  const replied = useMutation({
    mutationFn: (optOut: boolean) => api(`/outreach/drafts/${draft.id}/replied`, { method: "POST", body: { optOut } }),
    onSuccess: refresh,
  });
  const [followUp, setFollowUp] = useState(false);

  const liveApproval = draft.approvals.find((a) => !a.invalidatedAt && !a.consumedAt);
  const editable = draft.status === "DRAFT" || draft.status === "APPROVED";
  const error = reject.error ?? cancel.error ?? reconcile.error ?? revise.error ?? replied.error;

  return (
    <>
      <h1>
        {draft.subject} <StatusBadge status={draft.status} />
      </h1>
      {data.provider === "mock" ? (
        <p className="notice">Mock email provider: sending records the message locally; nobody receives it.</p>
      ) : (
        <p className="error">Real email provider ({data.provider}): sending delivers this email to the recipient.</p>
      )}

      <div className="card">
        <dl className="facts">
          <dt>To</dt>
          <dd>
            {draft.recipientEmail} · {draft.company.name}{" "}
            {data.recipientSuppressed ? <Badge tone="bad">suppressed</Badge> : null}
          </dd>
          <dt>Subject</dt>
          <dd>{draft.subject}</dd>
          <dt>About</dt>
          <dd>{draft.opportunity ? <Link to={["opportunities", draft.opportunity.id]}>{draft.opportunity.title}</Link> : "General introduction"}</dd>
          {draft.followUpOf && (
            <>
              <dt>Follow-up to</dt>
              <dd>
                <Link to={["outreach", draft.followUpOf.id]}>{draft.followUpOf.subject}</Link>
              </dd>
            </>
          )}
          <dt>Content hash</dt>
          <dd>
            <code title={draft.contentHash}>{draft.contentHash.slice(0, 16)}...</code>
            {draft.generatedByModel && <span className="muted small"> · drafted by {draft.generatedByModel}</span>}
          </dd>
        </dl>
        <pre className="email-body">{draft.body}</pre>
      </div>

      {draft.status === "DRAFT" && <ApproveBox draft={draft} suppressed={data.recipientSuppressed} onDone={refresh} />}
      {draft.status === "APPROVED" && liveApproval && <SendBox draft={draft} approval={liveApproval} onDone={refresh} />}

      {draft.status === "SENDING" && (
        <div className="card stack">
          <strong>Send outcome {draft.sendOutcome === "UNKNOWN" ? "uncertain" : "pending"}</strong>
          <p className="small">
            The provider did not confirm delivery ({draft.failureReason ?? "no response"}). It will not be resent automatically. Reconcile looks
            for this exact message in the sent mail: if found it is marked sent; if still missing after the grace period it is marked failed.
          </p>
          <div className="form-actions">
            <button type="button" onClick={() => reconcile.mutate()} disabled={reconcile.isPending}>
              Reconcile
            </button>
          </div>
        </div>
      )}

      {draft.status === "SENT" && (
        <div className="card stack">
          <span>
            Sent {when(draft.sentAt)}.{" "}
            {draft.optedOutAt ? (
              <Badge tone="bad">opted out</Badge>
            ) : draft.repliedAt ? (
              <Badge tone="good">replied {when(draft.repliedAt)}</Badge>
            ) : (
              <span className="muted">No reply recorded.</span>
            )}
          </span>
          <div className="form-actions">
            {!draft.repliedAt && (
              <>
                <button type="button" className="secondary" onClick={() => replied.mutate(false)} disabled={replied.isPending}>
                  Record a reply
                </button>
                <button type="button" className="secondary" onClick={() => replied.mutate(true)} disabled={replied.isPending}>
                  Record an opt-out
                </button>
                <button type="button" className="secondary" onClick={() => setFollowUp(true)}>
                  Draft a follow-up
                </button>
              </>
            )}
          </div>
          {followUp && <NewDraftForm contactId={draft.contactId} followUpOfId={draft.id} onCancel={() => setFollowUp(false)} />}
        </div>
      )}

      {(draft.status === "FAILED" || draft.status === "REJECTED" || draft.status === "CANCELLED") && (
        <div className="card stack">
          {draft.failureReason && <span>{draft.failureReason}</span>}
          <div className="form-actions">
            <button type="button" className="secondary" onClick={() => revise.mutate()} disabled={revise.isPending}>
              Start a new draft from this one
            </button>
          </div>
        </div>
      )}

      {editable && (
        <>
          <EditDraft draft={draft} contacts={data.companyContacts} onSaved={refresh} />
          <div className="form-actions">
            <button type="button" className="secondary" onClick={() => reject.mutate()} disabled={reject.isPending}>
              Reject draft
            </button>
            <button type="button" className="link danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
              Cancel outreach
            </button>
          </div>
        </>
      )}
      {error && <ErrorBox error={error} />}

      <h2>Approval history</h2>
      {draft.approvals.length === 0 ? (
        <p className="empty">No approvals yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Approved</th>
              <th>By</th>
              <th>Content hash</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {draft.approvals.map((a) => (
              <tr key={a.id}>
                <td className="small">{when(a.approvedAt)}</td>
                <td>{a.approvedBy.displayName}</td>
                <td>
                  <code>{a.contentHash.slice(0, 12)}...</code>
                </td>
                <td className="small">
                  {a.consumedAt
                    ? `used to send ${when(a.consumedAt)}`
                    : a.invalidatedAt
                      ? `invalidated: ${a.invalidationReason ?? ""}`
                      : `valid until ${when(a.expiresAt)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function useDraftAction(draftId: string, path: string, onSuccess: () => void) {
  return useMutation({ mutationFn: () => api(`/outreach/drafts/${draftId}/${path}`, { method: "POST" }), onSuccess });
}

function ApproveBox({ draft, suppressed, onDone }: { draft: DraftDetail["draft"]; suppressed: boolean; onDone: () => void }) {
  const [reviewed, setReviewed] = useState(false);
  const approve = useMutation({
    mutationFn: () => api(`/outreach/drafts/${draft.id}/approve`, { method: "POST", body: { contentHash: draft.contentHash } }),
    onSuccess: onDone,
  });
  useEffect(() => setReviewed(false), [draft.contentHash]);
  return (
    <div className="card stack">
      <strong>Approve</strong>
      <label className="check">
        <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} disabled={suppressed} />
        I have reviewed the recipient, subject and the complete message above, and approve exactly this version.
      </label>
      {approve.error && <ErrorBox error={approve.error} />}
      <div className="form-actions">
        <button type="button" onClick={() => approve.mutate()} disabled={!reviewed || suppressed || approve.isPending}>
          Approve this email
        </button>
        <span className="muted small">Approving does not send. Any later edit cancels the approval.</span>
      </div>
    </div>
  );
}

function SendBox({ draft, approval, onDone }: { draft: DraftDetail["draft"]; approval: Approval; onDone: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const send = useMutation({
    mutationFn: () =>
      api<{ outcome: string }>(`/outreach/drafts/${draft.id}/send`, { method: "POST", body: { contentHash: draft.contentHash } }),
    onSettled: onDone,
  });
  return (
    <div className="card stack">
      <strong>Send</strong>
      <span className="small">
        Approved by {approval.approvedBy.displayName} {when(approval.approvedAt)} · valid until {when(approval.expiresAt)}
      </span>
      <label className="check">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        Send this exact email to {draft.recipientEmail} now.
      </label>
      {send.error && <ErrorBox error={send.error} />}
      {send.data && <span className="muted">Result: {send.data.outcome.toLowerCase()}</span>}
      <div className="form-actions">
        <button type="button" onClick={() => send.mutate()} disabled={!confirmed || send.isPending}>
          {send.isPending ? "Sending..." : "Send email"}
        </button>
      </div>
    </div>
  );
}

function EditDraft({
  draft,
  contacts,
  onSaved,
}: {
  draft: DraftDetail["draft"];
  contacts: DraftDetail["companyContacts"];
  onSaved: () => void;
}) {
  const [form, setForm] = useState({ subject: draft.subject, body: draft.body, contactId: draft.contactId });
  useEffect(() => setForm({ subject: draft.subject, body: draft.body, contactId: draft.contactId }), [draft.contentHash, draft.contactId, draft.subject, draft.body]);
  const save = useMutation({
    mutationFn: () =>
      api(`/outreach/drafts/${draft.id}`, {
        method: "PATCH",
        body: { expectedContentHash: draft.contentHash, subject: form.subject, body: form.body, contactId: form.contactId },
      }),
    onSuccess: onSaved,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <form className="card stack" onSubmit={submit}>
      <strong>Edit</strong>
      {draft.status === "APPROVED" && <p className="notice">Saving changes cancels the current approval; the edited email must be approved again.</p>}
      <label>
        Recipient
        <select value={form.contactId} onChange={(e) => setForm({ ...form, contactId: e.target.value })}>
          {contacts.map((c) => (
            <option key={c.id} value={c.id} disabled={c.verificationStatus === "INVALID"}>
              {c.email}
              {c.name ? ` (${c.name})` : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        Subject
        <input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
      </label>
      <label>
        Body (keep the opt-out line)
        <textarea rows={12} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
      </label>
      {save.error && <ErrorBox error={save.error} />}
      <div className="form-actions">
        <button type="submit" className="secondary" disabled={save.isPending}>
          Save changes
        </button>
      </div>
    </form>
  );
}
