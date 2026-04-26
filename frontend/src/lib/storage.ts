export function readStorage<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeStorage<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // quota exceeded — in-memory state still works
  }
}

export const SESSION_KEY = 'session_id';
export const THEME_KEY = 'theme';
export const docsKey = (sessionId: string): string => `docs_${sessionId}`;
export const msgsKey = (sessionId: string): string => `msgs_${sessionId}`;
