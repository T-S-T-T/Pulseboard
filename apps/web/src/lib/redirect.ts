/** Only allows paths on this site, so a crafted link cannot redirect elsewhere. */
export function safeNextPath(next: string | null): string {
  const fallback = '/dashboard';
  if (!next?.startsWith('/')) return fallback;
  const base = 'http://pulseboard.invalid';
  try {
    const url = new URL(next, base);
    // "/.//host" stays on this origin but normalises to the path "//host",
    // which a browser would then treat as another site.
    if (url.origin !== base || url.pathname.startsWith('//')) return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}
