import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, usd, when } from "../api";
import { Link, navigate } from "../router";
import type { Evidence, ResearchRun, RunSource, Usage } from "../types";
import { ErrorBox, ExternalLink, KindBadge, QueryState, StatusBadge } from "../ui";

const ACTIVE = new Set(["QUEUED", "RUNNING"]);
const SIZES = ["", "1-10", "11-50", "51-200", "201-1000", "1000+"];

/** Recorded provider spend this month; runs stop when a budget is reached. */
function UsageSummary() {
  const usage = useQuery({ queryKey: ["usage"], queryFn: () => api<Usage>("/usage"), refetchInterval: 10_000 });
  return (
    <QueryState query={usage}>
      {(u) => {
        const spent = Number(u.spentMicros);
        const limit = Number(u.monthlyBudgetMicros);
        const kind = (k: Usage["byKind"][number]["kind"]) => usd(u.byKind.find((b) => b.kind === k)?.costMicros ?? 0);
        return (
          <p className={spent >= limit ? "error" : "notice"}>
            Spent this month: <strong>{usd(spent)}</strong> of {usd(limit)} (search {kind("SEARCH")}, LLM {kind("LLM")}). Each run is
            capped at {usd(u.runBudgetMicros)}.{spent >= limit && " New runs are refused until next month or a higher MONTHLY_BUDGET_USD."}
          </p>
        );
      }}
    </QueryState>
  );
}

export function RunsPage() {
  const runs = useQuery({
    queryKey: ["runs"],
    queryFn: () => api<{ runs: ResearchRun[] }>("/research-runs").then((r) => r.runs),
    // Poll only while something is in progress.
    refetchInterval: (q) => (q.state.data?.some((r) => ACTIVE.has(r.status)) ? 2_000 : false),
  });

  return (
    <>
      <h1>Research</h1>
      <UsageSummary />
      <NewRunForm />
      <h2>Runs</h2>
      <QueryState query={runs} isEmpty={(d) => d.length === 0} empty="No research runs yet. Start one above.">
        {(data) => (
          <table>
            <thead>
              <tr>
                <th>Created</th>
                <th>Focus</th>
                <th>Status</th>
                <th>Sources</th>
                <th>Evidence</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.map((run) => (
                <tr key={run.id}>
                  <td>
                    <Link to={["runs", run.id]}>{when(run.createdAt)}</Link>
                  </td>
                  <td>
                    {run.industry} · {run.country}
                    {run.keywords.length > 0 && <span className="muted"> · {run.keywords.join(", ")}</span>}
                  </td>
                  <td>
                    <StatusBadge status={run.status} />
                  </td>
                  <td>{run._count?.sources ?? 0}</td>
                  <td>{run._count?.evidence ?? 0}</td>
                  <td>{usd(run.costMicros)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </QueryState>
    </>
  );
}

function NewRunForm() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ industry: "", country: "GB", companySize: "", keywords: "", resultLimit: 10 });
  const create = useMutation({
    mutationFn: () =>
      api<{ run: ResearchRun }>("/research-runs", {
        method: "POST",
        body: {
          industry: form.industry,
          country: form.country,
          ...(form.companySize ? { companySize: form.companySize } : {}),
          keywords: form.keywords
            .split(",")
            .map((k) => k.trim())
            .filter(Boolean),
          resultLimit: form.resultLimit,
        },
      }),
    onSuccess: ({ run }) => {
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
      navigate("runs", run.id);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <form className="card grid-form" onSubmit={submit}>
      <label>
        Industry
        <input value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })} placeholder="e.g. HVAC services" required />
      </label>
      <label>
        Country (ISO code)
        <input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} maxLength={2} required />
      </label>
      <label>
        Company size
        <select value={form.companySize} onChange={(e) => setForm({ ...form, companySize: e.target.value })}>
          {SIZES.map((s) => (
            <option key={s} value={s}>
              {s || "Any"}
            </option>
          ))}
        </select>
      </label>
      <label>
        Keywords (comma-separated)
        <input value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} placeholder="scheduling, invoicing" />
      </label>
      <label>
        Max sources
        <input type="number" min={1} max={100} value={form.resultLimit} onChange={(e) => setForm({ ...form, resultLimit: Number(e.target.value) })} />
      </label>
      <div className="form-actions">
        <button type="submit" disabled={create.isPending}>
          {create.isPending ? "Starting..." : "Start research"}
        </button>
      </div>
      {create.error && <ErrorBox error={create.error} />}
    </form>
  );
}

const counts = (c: Record<string, number> | undefined) =>
  c && Object.keys(c).length ? Object.entries(c).map(([k, v]) => `${k.toLowerCase().replace(/_/g, " ")}: ${v}`).join(", ") : "none";

export function RunDetailPage({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ["run", id],
    queryFn: () => api<{ run: ResearchRun; sources: RunSource[] }>(`/research-runs/${id}`),
    refetchInterval: (q) => (q.state.data && ACTIVE.has(q.state.data.run.status) ? 2_000 : false),
  });
  const active = detail.data ? ACTIVE.has(detail.data.run.status) : false;
  const evidence = useQuery({
    queryKey: ["run-evidence", id],
    queryFn: () => api<{ evidence: Evidence[] }>(`/research-runs/${id}/evidence`).then((r) => r.evidence),
    refetchInterval: active ? 3_000 : false,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["run", id] });
    void queryClient.invalidateQueries({ queryKey: ["runs"] });
  };
  const cancel = useMutation({ mutationFn: () => api(`/research-runs/${id}/cancel`, { method: "POST" }), onSuccess: refresh });
  const retry = useMutation({
    mutationFn: () => api<{ run: ResearchRun }>(`/research-runs/${id}/retry`, { method: "POST" }),
    onSuccess: ({ run }) => {
      refresh();
      navigate("runs", run.id);
    },
  });

  return (
    <>
      <p>
        <Link to={["runs"]}>&larr; All runs</Link>
      </p>
      <QueryState query={detail}>
        {({ run, sources }) => (
          <>
            <h1>
              {run.industry} · {run.country} <StatusBadge status={run.status} />
            </h1>
            <div className="card">
              <dl className="facts">
                <dt>Query</dt>
                <dd>
                  <code>{run.query}</code>
                </dd>
                <dt>Created</dt>
                <dd>{when(run.createdAt)}</dd>
                <dt>Completed</dt>
                <dd>{when(run.completedAt)}</dd>
                <dt>Usage</dt>
                <dd>
                  {run.searchCalls} search, {run.llmCalls} LLM calls · {usd(run.costMicros)}
                </dd>
                {run.stats && (
                  <>
                    <dt>Pipeline</dt>
                    <dd>
                      {run.stats.searchHits} hits → {run.stats.selected} selected ({run.stats.duplicateUrls} duplicates, rejected: {counts(run.stats.rejectedUrls)}) ·{" "}
                      {run.stats.fetched} fetched, {run.stats.reusedSources} reused · skipped: {counts(run.stats.skipped)} · failed: {counts(run.stats.failed)}
                    </dd>
                    <dt>Evidence</dt>
                    <dd>
                      {run.stats.evidenceAccepted} accepted · rejected: {counts(run.stats.evidenceRejected)} · extraction errors: {run.stats.extractionErrors}
                    </dd>
                  </>
                )}
              </dl>
              {run.errorMessage && (
                <p className="error">
                  {run.errorCode}: {run.errorMessage}
                </p>
              )}
              <div className="form-actions">
                {ACTIVE.has(run.status) && (
                  <button type="button" className="secondary" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                    Cancel run
                  </button>
                )}
                {!ACTIVE.has(run.status) && (
                  <button type="button" className="secondary" onClick={() => retry.mutate()} disabled={retry.isPending}>
                    Run again with same filters
                  </button>
                )}
              </div>
              {(cancel.error ?? retry.error) && <ErrorBox error={cancel.error ?? retry.error} />}
            </div>

            <h2>Sources</h2>
            {sources.length === 0 ? (
              <p className="empty">{ACTIVE.has(run.status) ? "Searching..." : "No sources."}</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Source</th>
                    <th>Status</th>
                    <th>Evidence</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sources.map((s) => (
                    <tr key={s.id}>
                      <td>{(s.searchRank ?? 0) + 1}</td>
                      <td>
                        <ExternalLink href={s.canonicalUrl}>{s.title ?? s.canonicalUrl}</ExternalLink>
                        <div className="muted small">{s.registrableDomain}</div>
                      </td>
                      <td>
                        <StatusBadge status={s.retrievalStatus} /> {s.skipReason && <span className="muted small">{s.skipReason.split(":")[0]}</span>}
                      </td>
                      <td>{s._count.evidence}</td>
                      <td>{s.retrievalStatus === "FETCHED" && <AddCompanyButton sourceId={s.id} name={s.registrableDomain} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </QueryState>

      <h2>Evidence</h2>
      <QueryState query={evidence} isEmpty={(d) => d.length === 0} empty="No evidence extracted yet.">
        {(items) => <EvidenceList items={items} invalidate={[["run-evidence", id]]} />}
      </QueryState>
    </>
  );
}

function AddCompanyButton({ sourceId, name }: { sourceId: string; name: string }) {
  const create = useMutation({
    mutationFn: () => api<{ company: { id: string } }>("/companies", { method: "POST", body: { name, fromSourceId: sourceId } }),
    onSuccess: ({ company }) => navigate("companies", company.id),
  });
  return (
    <>
      <button type="button" className="link" onClick={() => create.mutate()} disabled={create.isPending} title="Create a company record for this domain">
        Add company
      </button>
      {create.error && <ErrorBox error={create.error} />}
    </>
  );
}

/** Evidence with provenance, observed/inferred labels and a reject/restore action. */
export function EvidenceList({ items, invalidate, numbered = false }: { items: Evidence[]; invalidate: unknown[][]; numbered?: boolean }) {
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "VALID" | "REJECTED" }) =>
      api(`/evidence/${id}`, { method: "PATCH", body: { validationStatus: status } }),
    onSuccess: () => {
      for (const key of invalidate) void queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({ queryKey: ["opportunities"] });
    },
  });

  return (
    <ul className="evidence">
      {items.map((e, i) => (
        <li key={e.id} className={e.validationStatus === "REJECTED" ? "rejected" : undefined}>
          {numbered && <strong className="evidence-number">#{i + 1}</strong>}
          <blockquote>{e.excerpt}</blockquote>
          <div className="meta">
            <KindBadge kind={e.kind} /> confidence {e.confidence.toFixed(2)}
            {e.workflow && <> · {e.workflow}</>} · <ExternalLink href={e.source.canonicalUrl}>{e.source.registrableDomain}</ExternalLink>
          </div>
          <div>{e.problemSummary}</div>
          <div className="muted small">
            {e.validationStatus === "REJECTED" && <strong>Rejected by reviewer · </strong>}
            Impact: {e.impactNote ?? "unknown"}
            {e.validationNote && <> · {e.validationNote}</>}
          </div>
          <button
            type="button"
            className="link"
            disabled={update.isPending}
            onClick={() => update.mutate({ id: e.id, status: e.validationStatus === "REJECTED" ? "VALID" : "REJECTED" })}
          >
            {e.validationStatus === "REJECTED" ? "Restore" : "Reject as not supporting a problem"}
          </button>
        </li>
      ))}
      {update.error && <ErrorBox error={update.error} />}
    </ul>
  );
}
