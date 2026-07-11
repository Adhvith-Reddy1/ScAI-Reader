/**
 * A reader's own AI provider key, entered once they've used up the site's
 * free daily quota (see backend/app/quota.py). Stored only in this browser
 * — never sent anywhere but as a per-request header to this app's own
 * backend, and never written to the server's disk (backend/app/ai.py's
 * `with_override_key` uses it for one call and discards it).
 */

const STORAGE_KEY = "scai.userApiKey";

export function getUserApiKey(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

export function setUserApiKey(key: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, key.trim());
  } catch {
    /* localStorage unavailable; the key just won't persist across reloads */
  }
}

export function clearUserApiKey(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
