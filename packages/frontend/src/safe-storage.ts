// localStorage throws when site data is blocked or the quota is full. These
// are per-browser conveniences, so a failure reads as unset and saves nothing.
export const safeStorage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // not persisted
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      // not persisted
    }
  },
};
