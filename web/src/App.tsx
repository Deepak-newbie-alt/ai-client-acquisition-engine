import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, ApiError } from "./api";
import { AuditPage } from "./pages/Audit";
import { CompaniesPage, CompanyDetailPage } from "./pages/Companies";
import { OpportunitiesPage, OpportunityDetailPage } from "./pages/Opportunities";
import { DraftDetailPage, OutreachPage } from "./pages/Outreach";
import { RunDetailPage, RunsPage } from "./pages/Runs";
import { SuppressionsPage } from "./pages/Suppressions";
import { Link, useRoute } from "./router";
import type { User } from "./types";
import { ErrorBox, Loading } from "./ui";

const NAV = [
  ["runs", "Research"],
  ["opportunities", "Opportunities"],
  ["companies", "Companies"],
  ["outreach", "Outreach"],
  ["suppressions", "Suppression list"],
  ["audit", "Audit log"],
] as const;

export function App() {
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () =>
      api<{ user: User }>("/auth/me")
        .then((r) => r.user)
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 401) return null;
          throw err;
        }),
  });

  if (me.isPending) return <Loading label="Checking session..." />;
  if (me.error) return <ErrorBox error={me.error} onRetry={() => void me.refetch()} />;
  if (!me.data) return <Login />;
  return <Shell user={me.data} />;
}

function Shell({ user }: { user: User }) {
  const route = useRoute();
  const queryClient = useQueryClient();
  const logout = useMutation({
    mutationFn: () => api("/auth/logout", { method: "POST" }),
    onSettled: () => queryClient.clear(),
  });
  const [section = "runs", id] = route;

  return (
    <div className="layout">
      <header className="topbar">
        <strong>Client Acquisition Engine</strong>
        <nav>
          {NAV.map(([key, label]) => (
            <Link key={key} to={[key]} className={section === key ? "active" : undefined}>
              {label}
            </Link>
          ))}
        </nav>
        <span className="muted">
          {user.displayName} ({user.role.toLowerCase()})
        </span>
        <button type="button" className="secondary" onClick={() => logout.mutate()} disabled={logout.isPending}>
          Sign out
        </button>
      </header>
      <main>
        {section === "runs" && (id ? <RunDetailPage id={id} /> : <RunsPage />)}
        {section === "opportunities" && (id ? <OpportunityDetailPage id={id} /> : <OpportunitiesPage />)}
        {section === "companies" && (id ? <CompanyDetailPage id={id} /> : <CompaniesPage />)}
        {section === "outreach" && (id ? <DraftDetailPage id={id} /> : <OutreachPage />)}
        {section === "suppressions" && <SuppressionsPage user={user} />}
        {section === "audit" && <AuditPage />}
      </main>
    </div>
  );
}

function Login() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation({
    mutationFn: () => api<{ user: User }>("/auth/login", { method: "POST", body: { email, password } }),
    onSuccess: ({ user }) => {
      setPassword("");
      queryClient.setQueryData(["me"], user);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };

  return (
    <main className="login">
      <h1>Sign in</h1>
      <form onSubmit={submit} className="stack">
        <label>
          Email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {login.error && <ErrorBox error={login.error} />}
        <button type="submit" disabled={login.isPending}>
          {login.isPending ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </main>
  );
}
