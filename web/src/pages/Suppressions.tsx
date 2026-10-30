import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, when } from "../api";
import type { Suppression, User } from "../types";
import { ErrorBox, QueryState } from "../ui";

export function SuppressionsPage({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ["suppressions"], queryFn: () => api<{ suppressions: Suppression[] }>("/suppressions").then((r) => r.suppressions) });
  const [form, setForm] = useState({ scope: "EMAIL" as Suppression["scope"], value: "", reason: "" });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["suppressions"] });
    void queryClient.invalidateQueries({ queryKey: ["company"] });
  };
  const add = useMutation({
    mutationFn: () => api("/suppressions", { method: "POST", body: form }),
    onSuccess: () => {
      setForm({ ...form, value: "", reason: "" });
      invalidate();
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => api(`/suppressions/${id}`, { method: "DELETE" }), onSuccess: invalidate });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };

  return (
    <>
      <h1>Suppression list</h1>
      <p className="muted">Addresses and domains here are never emailed. Opt-outs are added automatically once outreach is enabled.</p>
      <form className="card row" onSubmit={submit}>
        <label>
          Type
          <select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as Suppression["scope"] })}>
            <option value="EMAIL">Email address</option>
            <option value="DOMAIN">Whole domain</option>
          </select>
        </label>
        <label>
          {form.scope === "EMAIL" ? "Email" : "Domain"}
          <input value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} required />
        </label>
        <label>
          Reason
          <input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} required />
        </label>
        <button type="submit" disabled={add.isPending}>
          Suppress
        </button>
      </form>
      {(add.error ?? remove.error) && <ErrorBox error={add.error ?? remove.error} />}
      <QueryState query={list} isEmpty={(d) => d.length === 0} empty="Nothing is suppressed.">
        {(items) => (
          <table>
            <thead>
              <tr>
                <th>Value</th>
                <th>Type</th>
                <th>Reason</th>
                <th>Source</th>
                <th>Added</th>
                {user.role === "ADMIN" && <th />}
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td>{s.value}</td>
                  <td>{s.scope.toLowerCase()}</td>
                  <td>{s.reason}</td>
                  <td>{s.source}</td>
                  <td>{when(s.createdAt)}</td>
                  {user.role === "ADMIN" && (
                    <td>
                      <button type="button" className="link danger" onClick={() => remove.mutate(s.id)} disabled={remove.isPending}>
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </QueryState>
    </>
  );
}
