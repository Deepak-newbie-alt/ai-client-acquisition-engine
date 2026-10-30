import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, when } from "../api";
import { Link, navigate } from "../router";
import type { Company, Contact } from "../types";
import { Badge, ErrorBox, ExternalLink, QueryState, StatusBadge } from "../ui";
import { NewDraftForm } from "./Outreach";

export function CompaniesPage() {
  const list = useQuery({ queryKey: ["companies"], queryFn: () => api<{ companies: Company[] }>("/companies").then((r) => r.companies) });
  const [form, setForm] = useState({ name: "", website: "" });
  const create = useMutation({
    mutationFn: () => api<{ company: Company }>("/companies", { method: "POST", body: form }),
    onSuccess: ({ company }) => navigate("companies", company.id),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <>
      <h1>Companies</h1>
      <form className="card row" onSubmit={submit}>
        <label>
          Name
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </label>
        <label>
          Website
          <input type="url" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://..." required />
        </label>
        <button type="submit" disabled={create.isPending}>
          Add company
        </button>
        {create.error && <ErrorBox error={create.error} />}
      </form>
      <p className="muted small">Companies can also be added from a fetched source on a research run.</p>
      <QueryState query={list} isEmpty={(d) => d.length === 0} empty="No companies yet.">
        {(items) => (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Domain</th>
                <th>Status</th>
                <th>Contacts</th>
                <th>Sources</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={["companies", c.id]}>{c.name}</Link>
                  </td>
                  <td>{c.domain}</td>
                  <td>{c.researchStatus.toLowerCase()}</td>
                  <td>{c._count?.contacts ?? 0}</td>
                  <td>{c._count?.sources ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </QueryState>
    </>
  );
}

interface CompanyDetail {
  company: Company & {
    sources: { id: string; canonicalUrl: string; title: string | null; retrievalStatus: string; _count: { evidence: number } }[];
    provenanceSource: { id: string; canonicalUrl: string } | null;
  };
  contacts: Contact[];
}

export function CompanyDetailPage({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["company", id], queryFn: () => api<CompanyDetail>(`/companies/${id}`) });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["company", id] });
    void queryClient.invalidateQueries({ queryKey: ["companies"] });
  };
  const verify = useMutation({ mutationFn: (contactId: string) => api(`/contacts/${contactId}/verify`, { method: "POST" }), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (contactId: string) => api(`/contacts/${contactId}`, { method: "DELETE" }), onSuccess: invalidate });
  const [draftFor, setDraftFor] = useState<string | null>(null);

  return (
    <>
      <p>
        <Link to={["companies"]}>&larr; All companies</Link>
      </p>
      <QueryState query={detail}>
        {({ company, contacts }) => (
          <>
            <h1>{company.name}</h1>
            <p className="muted">
              {company.website ? <ExternalLink href={company.website} /> : company.domain}
              {company.provenanceSource && (
                <>
                  {" "}
                  · discovered via <ExternalLink href={company.provenanceSource.canonicalUrl}>source</ExternalLink>
                </>
              )}
            </p>
            <EditCompany company={company} onSaved={invalidate} />

            <h2>Contacts</h2>
            <p className="muted small">
              Only business addresses published on a public page. Verification re-fetches the source page and checks the address appears there.
            </p>
            {contacts.length === 0 ? (
              <p className="empty">No contacts.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Contact</th>
                    <th>Source</th>
                    <th>Verification</th>
                    <th>Outreach</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((c) => (
                    <tr key={c.id}>
                      <td>
                        {c.email}
                        <div className="muted small">{[c.name, c.role].filter(Boolean).join(", ")}</div>
                      </td>
                      <td className="small">
                        <ExternalLink href={c.sourceUrl} />
                        <div className="muted">retrieved {when(c.retrievedAt)}</div>
                      </td>
                      <td>
                        <StatusBadge status={c.verificationStatus} />
                      </td>
                      <td>{c.suppressed ? <Badge tone="bad">suppressed</Badge> : <Badge tone="neutral">allowed</Badge>}</td>
                      <td>
                        {!c.suppressed && c.verificationStatus !== "INVALID" && (
                          <>
                            <button type="button" className="link" onClick={() => setDraftFor(c.id)}>
                              Draft email
                            </button>{" "}
                          </>
                        )}
                        <button type="button" className="link" onClick={() => verify.mutate(c.id)} disabled={verify.isPending}>
                          Verify
                        </button>{" "}
                        <button type="button" className="link danger" onClick={() => remove.mutate(c.id)} disabled={remove.isPending}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {(verify.error ?? remove.error) && <ErrorBox error={verify.error ?? remove.error} />}
            {draftFor && <NewDraftForm contactId={draftFor} onCancel={() => setDraftFor(null)} />}
            <AddContact companyId={company.id} onAdded={invalidate} />

            <h2>Sources from this company</h2>
            {company.sources.length === 0 ? (
              <p className="empty">No research sources on this domain.</p>
            ) : (
              <ul>
                {company.sources.map((s) => (
                  <li key={s.id}>
                    <ExternalLink href={s.canonicalUrl}>{s.title ?? s.canonicalUrl}</ExternalLink>{" "}
                    <span className="muted small">
                      {s.retrievalStatus.toLowerCase()} · {s._count.evidence} evidence
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </QueryState>
    </>
  );
}

function EditCompany({ company, onSaved }: { company: Company; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: company.name,
    researchStatus: company.researchStatus,
    summary: company.profile?.summary ?? "",
    notes: company.profile?.notes ?? "",
  });
  const save = useMutation({
    mutationFn: () =>
      api(`/companies/${company.id}`, {
        method: "PATCH",
        body: { name: form.name, researchStatus: form.researchStatus, profile: { summary: form.summary, notes: form.notes } },
      }),
    onSuccess: onSaved,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <form className="card stack" onSubmit={submit}>
      <div className="row">
        <label>
          Name
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label>
          Research status
          <select value={form.researchStatus} onChange={(e) => setForm({ ...form, researchStatus: e.target.value as Company["researchStatus"] })}>
            {["DISCOVERED", "RESEARCHING", "RESEARCHED", "EXCLUDED"].map((s) => (
              <option key={s} value={s}>
                {s.toLowerCase()}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Business profile
        <textarea rows={2} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} />
      </label>
      <label>
        Notes
        <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </label>
      {save.error && <ErrorBox error={save.error} />}
      <div className="form-actions">
        <button type="submit" className="secondary" disabled={save.isPending}>
          Save
        </button>
        {save.isSuccess && <span className="muted">Saved.</span>}
      </div>
    </form>
  );
}

function AddContact({ companyId, onAdded }: { companyId: string; onAdded: () => void }) {
  const empty = { email: "", name: "", role: "", sourceUrl: "" };
  const [form, setForm] = useState(empty);
  const add = useMutation({
    mutationFn: () =>
      api(`/companies/${companyId}/contacts`, {
        method: "POST",
        body: {
          email: form.email,
          sourceUrl: form.sourceUrl,
          ...(form.name ? { name: form.name } : {}),
          ...(form.role ? { role: form.role } : {}),
        },
      }),
    onSuccess: () => {
      setForm(empty);
      onAdded();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };
  return (
    <form className="card grid-form" onSubmit={submit}>
      <label>
        Business email
        <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
      </label>
      <label>
        Published at (URL)
        <input type="url" value={form.sourceUrl} onChange={(e) => setForm({ ...form, sourceUrl: e.target.value })} required />
      </label>
      <label>
        Name (optional)
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </label>
      <label>
        Role (optional)
        <input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} />
      </label>
      <div className="form-actions">
        <button type="submit" disabled={add.isPending}>
          Add contact
        </button>
      </div>
      {add.error && <ErrorBox error={add.error} />}
    </form>
  );
}
