import { useEffect, useState, type AnchorHTMLAttributes } from "react";

/** Minimal hash router: "#/runs/abc" -> ["runs", "abc"]. */
function currentPath(): string[] {
  return window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
}

export function useRoute(): string[] {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onChange = () => setPath(currentPath());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return path;
}

export function navigate(...segments: string[]): void {
  window.location.hash = `/${segments.map(encodeURIComponent).join("/")}`;
}

export function Link({ to, ...rest }: { to: string[] } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a href={`#/${to.map(encodeURIComponent).join("/")}`} {...rest} />;
}
