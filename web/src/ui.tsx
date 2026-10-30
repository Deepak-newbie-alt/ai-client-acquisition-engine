import type { ReactNode } from "react";
import { ApiError, safeHref } from "./api";

export function Loading({ label = "Loading..." }: { label?: string }) {
  return (
    <p className="muted" role="status">
      {label}
    </p>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof ApiError ? error.message : "Something went wrong.";
  const details = error instanceof ApiError && Array.isArray(error.details) ? (error.details as { path: string; message: string }[]) : [];
  return (
    <div className="error" role="alert">
      <span>{message}</span>
      {details.length > 0 && (
        <ul>
          {details.map((d) => (
            <li key={`${d.path}:${d.message}`}>
              {d.path ? <code>{d.path}</code> : null} {d.message}
            </li>
          ))}
        </ul>
      )}
      {onRetry && (
        <button type="button" className="secondary" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

/** Renders a query's loading / error / empty states, then the content. */
export function QueryState<T>({
  query,
  empty,
  isEmpty,
  children,
}: {
  query: { isPending: boolean; error: unknown; data: T | undefined; refetch: () => unknown };
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <Loading />;
  if (query.error || query.data === undefined) return <ErrorBox error={query.error} onRetry={() => void query.refetch()} />;
  if (empty && isEmpty?.(query.data)) return <Empty>{empty}</Empty>;
  return <>{children(query.data)}</>;
}

export function Badge({ tone, children, title }: { tone: string; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, string> = {
  QUEUED: "neutral",
  RUNNING: "info",
  SUCCEEDED: "good",
  FAILED: "bad",
  CANCELLED: "neutral",
  FETCHED: "good",
  SKIPPED: "neutral",
  PENDING: "neutral",
  VERIFIED: "good",
  UNVERIFIED: "neutral",
  INVALID: "bad",
};

export const StatusBadge = ({ status }: { status: string }) => <Badge tone={STATUS_TONE[status] ?? "neutral"}>{status}</Badge>;

const KIND_HELP: Record<string, string> = {
  OBSERVED: "The excerpt directly states the problem.",
  INFERRED: "The problem is a reading of the excerpt, not stated in it.",
  UNKNOWN: "Unclear whether the excerpt describes the problem.",
};

export const KindBadge = ({ kind }: { kind: string }) => (
  <Badge tone={kind === "OBSERVED" ? "good" : kind === "INFERRED" ? "warn" : "neutral"} title={KIND_HELP[kind]}>
    {kind.toLowerCase()}
  </Badge>
);

export function ExternalLink({ href, children }: { href: string; children?: ReactNode }) {
  const safe = safeHref(href);
  if (!safe) return <span>{children ?? href}</span>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer nofollow">
      {children ?? href}
    </a>
  );
}

export const ScoreValue = ({ value }: { value: number | null | undefined }) =>
  value == null ? (
    <span className="unknown" title="Not enough evidence to score">
      unknown
    </span>
  ) : (
    <span className="score">{value.toFixed(1)}</span>
  );
