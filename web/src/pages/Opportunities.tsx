import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { api, when } from "../api";
import { Link, navigate } from "../router";
import { COMPONENT_LABELS, COMPONENT_ORDER, type Alternative, type Evidence, type Opportunity, type Score } from "../types";
import { ErrorBox, QueryState, ScoreValue } from "../ui";
import { EvidenceList } from "./Runs";

interface ScoringInfo {
  scoring: { version: string; weights: Record<string, number> };
  disclaimer: string;
}

const pct = (n: number | null | undefined) => (n == null ? "-" : `${Math.round(n * 100)}%`);

export function OpportunitiesPage() {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ["opportunities"],
    queryFn: () => api<{ opportunities: Opportunity[] }>("/opportunities").then((r) => r.opportunities),
  });
  const scoring = useQuery({ queryKey: ["scoring"], queryFn: () => api<ScoringInfo>("/opportunities/scoring") });
  const recompute = useMutation({
    mutationFn: () => api("/opportunities/recompute", { method: "POST" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["opportunities"] }),
  });

  return (
    <>
      <h1>Opportunities</h1>
      {scoring.data && (
        <p className="notice">
          {scoring.data.disclaimer} Weights (v{scoring.data.scoring.version}):{" "}
          {COMPONENT_ORDER.map((c) => `${COMPONENT_LABELS[c]} ${scoring.data.scoring.weights[c]}`).join(" · ")}. Unknown components count as 0;
          coverage shows how much of the weighting could be scored.
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="secondary" onClick={() => recompute.mutate()} disabled={recompute.isPending}>
          {recompute.isPending ? "Recomputing..." : "Recompute clusters and scores"}
        </button>
      </div>
      {recompute.error && <ErrorBox error={recompute.error} />}
      <QueryState query={list} isEmpty={(d) => d.length === 0} empty="No opportunities yet. They appear after a research run extracts evidence.">
        {(items) => (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Problem</th>
                  <th title="Independent businesses or sites">Businesses</th>
                  <th>Evidence</th>
                  <th>Score</th>
                  <th>Coverage</th>
                  {COMPONENT_ORDER.map((c) => (
                    <th key={c} className="small">
                      {COMPONENT_LABELS[c]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link to={["opportunities", o.id]}>{o.title}</Link>
                      <div className="muted small">{o.segment}</div>
                    </td>
                    <td>{o.independentCompanyCount}</td>
                    <td>{o._count?.evidence ?? 0}</td>
                    <td>
                      <ScoreValue value={o.totalScore} />
                    </td>
                    <td>{pct(o.scoreCoverage)}</td>
                    {COMPONENT_ORDER.map((c) => (
                      <td key={c}>
                        <ScoreValue value={o.scores?.find((s) => s.component === c)?.value} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryState>
    </>
  );
}

interface Detail {
  opportunity: Opportunity;
  scores: Score[];
  evidence: Evidence[];
}

export function OpportunityDetailPage({ id }: { id: string }) {
  const detail = useQuery({ queryKey: ["opportunity", id], queryFn: () => api<Detail>(`/opportunities/${id}`) });
  return (
    <>
      <p>
        <Link to={["opportunities"]}>&larr; All opportunities</Link>
      </p>
      <QueryState query={detail}>
        {({ opportunity, scores, evidence }) => {
          const evidenceNumber = new Map(evidence.map((e, i) => [e.id, i + 1]));
          return (
            <>
              <h1>{opportunity.title}</h1>
              <p className="muted">
                {opportunity.independentCompanyCount} independent business(es) · {opportunity.independentSourceCount} source(s) · scored{" "}
                {when(opportunity.scoredAt)} with weights v{opportunity.weightsVersion}
              </p>

              <h2>
                Score <ScoreValue value={opportunity.totalScore} /> <span className="muted small">coverage {pct(opportunity.scoreCoverage)}</span>
              </h2>
              <table>
                <thead>
                  <tr>
                    <th>Component</th>
                    <th>Value (0-5)</th>
                    <th>Weight</th>
                    <th>How it was computed</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {COMPONENT_ORDER.map((c) => {
                    const s = scores.find((x) => x.component === c);
                    return (
                      <tr key={c}>
                        <td>{COMPONENT_LABELS[c]}</td>
                        <td>
                          <ScoreValue value={s?.value} />
                        </td>
                        <td>{s?.weight ?? "-"}</td>
                        <td className="small">{s?.rationale ?? "-"}</td>
                        <td className="small">{(s?.evidenceIds ?? []).map((eid) => `#${evidenceNumber.get(eid) ?? "?"}`).join(" ") || "-"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <EditOpportunity opportunity={opportunity} />
              <MergeOpportunity id={opportunity.id} />

              <h2>Supporting evidence</h2>
              <EvidenceList items={evidence} invalidate={[["opportunity", id]]} numbered />
            </>
          );
        }}
      </QueryState>
    </>
  );
}

function EditOpportunity({ opportunity }: { opportunity: Opportunity }) {
  const queryClient = useQueryClient();
  const initial = () => ({
    title: opportunity.title,
    description: opportunity.description,
    segment: opportunity.segment,
    buyer: opportunity.buyer,
    validationQuestions: opportunity.validationQuestions.join("\n"),
    alternatives: opportunity.alternatives,
  });
  const [form, setForm] = useState(initial);
  // Reset the form when fresh data arrives (e.g. after saving and rescoring).
  useEffect(() => setForm(initial()), [opportunity]);

  const save = useMutation({
    mutationFn: () =>
      api(`/opportunities/${opportunity.id}`, {
        method: "PATCH",
        body: {
          title: form.title,
          description: form.description,
          segment: form.segment,
          buyer: form.buyer,
          validationQuestions: form.validationQuestions
            .split("\n")
            .map((q) => q.trim())
            .filter(Boolean),
          alternatives: form.alternatives.map((a) => ({ name: a.name, fit: a.fit, ...(a.note ? { note: a.note } : {}) })),
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["opportunity", opportunity.id] });
      void queryClient.invalidateQueries({ queryKey: ["opportunities"] });
    },
  });

  const setAlt = (i: number, patch: Partial<Alternative>) =>
    setForm({ ...form, alternatives: form.alternatives.map((a, j) => (i === j ? { ...a, ...patch } : a)) });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <form className="card stack" onSubmit={submit}>
      <h2>Review notes</h2>
      <label>
        Title
        <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </label>
      <label>
        Description
        <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </label>
      <div className="row">
        <label>
          Target segment
          <input value={form.segment} onChange={(e) => setForm({ ...form, segment: e.target.value })} />
        </label>
        <label>
          Likely buyer
          <input value={form.buyer} onChange={(e) => setForm({ ...form, buyer: e.target.value })} />
        </label>
      </div>
      <label>
        Validation questions (one per line)
        <textarea rows={3} value={form.validationQuestions} onChange={(e) => setForm({ ...form, validationQuestions: e.target.value })} />
      </label>
      <fieldset>
        <legend>Existing alternatives (used for the differentiation score)</legend>
        {form.alternatives.map((a, i) => (
          <div className="row" key={i}>
            <input aria-label="Alternative name" placeholder="Product name" value={a.name} onChange={(e) => setAlt(i, { name: e.target.value })} />
            <select aria-label="Fit" value={a.fit} onChange={(e) => setAlt(i, { fit: e.target.value as Alternative["fit"] })}>
              <option value="good">Solves it well</option>
              <option value="partial">Partially</option>
              <option value="poor">Poorly</option>
            </select>
            <input aria-label="Note" placeholder="Note (optional)" value={a.note ?? ""} onChange={(e) => setAlt(i, { note: e.target.value })} />
            <button type="button" className="link" onClick={() => setForm({ ...form, alternatives: form.alternatives.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="secondary" onClick={() => setForm({ ...form, alternatives: [...form.alternatives, { name: "", fit: "partial" }] })}>
          Add alternative
        </button>
      </fieldset>
      {save.error && <ErrorBox error={save.error} />}
      <div className="form-actions">
        <button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving..." : "Save and rescore"}
        </button>
        {save.isSuccess && <span className="muted">Saved.</span>}
      </div>
    </form>
  );
}

function MergeOpportunity({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const [intoId, setIntoId] = useState("");
  const others = useQuery({
    queryKey: ["opportunities"],
    queryFn: () => api<{ opportunities: Opportunity[] }>("/opportunities").then((r) => r.opportunities),
  });
  const merge = useMutation({
    mutationFn: () => api(`/opportunities/${id}/merge`, { method: "POST", body: { intoId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["opportunities"] });
      navigate("opportunities", intoId);
    },
  });
  const candidates = (others.data ?? []).filter((o) => o.id !== id);
  if (candidates.length === 0) return null;

  return (
    <div className="card row">
      <label>
        Same problem as another opportunity? Merge into:
        <select value={intoId} onChange={(e) => setIntoId(e.target.value)}>
          <option value="">Choose...</option>
          {candidates.map((o) => (
            <option key={o.id} value={o.id}>
              {o.title}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="secondary" disabled={!intoId || merge.isPending} onClick={() => merge.mutate()}>
        Merge
      </button>
      {merge.error && <ErrorBox error={merge.error} />}
    </div>
  );
}
