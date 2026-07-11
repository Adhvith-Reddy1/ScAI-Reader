/**
 * Anonymous per-browser identifier sent on AI requests so the backend can
 * bound the shared, server-funded daily AI budget per browser (see
 * backend/app/quota.py). This is not an account: it's a random id generated
 * once and stored in localStorage, identifying a browser, not a person. No
 * signup is required to use the app.
 */

const STORAGE_KEY = "scai.clientId";

let cached: string | null = null;

export function getClientId(): string {
  if (cached) return cached;
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) {
      cached = existing;
      return existing;
    }
    const id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, id);
    cached = id;
    return id;
  } catch {
    // localStorage unavailable (private mode, etc.): fall back to an id that
    // at least stays stable for the life of this page.
    cached ??= crypto.randomUUID();
    return cached;
  }
}
