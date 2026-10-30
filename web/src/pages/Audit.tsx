import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, when } from "../api";
import type { AuditEvent } from "../types";
import { QueryState } from "../ui";

export function AuditPage() {
  const [entityType, setEntityType] = useState("");
  const params = new URLSearchParams({ limit: "100", ...(entityType ? { entityType } : {}) });
  const events = useQuery({
    queryKey: ["audit", entityType],
    queryFn: () => api<{ events: AuditEvent[] }>(`/audit-events?${params.toString()}`).then((r) => r.events),
  });

  return (
    <>
      <h1>Audit log</h1>
      <div className="card row">
        <label>
          Entity
          <select value={entityType} onChange={(e) => setEntityType(e.target.value)}>
            <option value="">All</option>
            {["ResearchRun", "ProblemCluster", "Evidence", "Company", "Contact", "SuppressionRecord", "User", "ServiceToken"].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="secondary" onClick={() => void events.refetch()}>
          Refresh
        </button>
      </div>
      <QueryState query={events} isEmpty={(d) => d.length === 0} empty="No events.">
        {(items) => (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <td className="small">{when(e.createdAt)}</td>
                  <td className="small">
                    {e.actorType.toLowerCase()}
                    {e.actorId && <div className="muted">{e.actorId.slice(0, 8)}</div>}
                  </td>
                  <td>
                    <code>{e.action}</code>
                  </td>
                  <td className="small">
                    {e.entityType}
                    {e.entityId && <div className="muted">{e.entityId.slice(0, 8)}</div>}
                  </td>
                  <td className="small">
                    {e.metadata
                      ? Object.entries(e.metadata)
                          .map(([k, v]) => `${k}: ${String(v)}`)
                          .join(", ")
                      : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </QueryState>
    </>
  );
}
