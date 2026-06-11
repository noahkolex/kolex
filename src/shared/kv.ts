/**
 * Tiny async key-value interface over chrome.storage.local, with an
 * in-memory implementation for tests and non-extension contexts.
 */
export interface KV {
  get<T>(key: string, fallback: T): Promise<T>;
  set(key: string, value: unknown): Promise<void>;
}

export class MemoryKV implements KV {
  private map = new Map<string, unknown>();

  async get<T>(key: string, fallback: T): Promise<T> {
    return this.map.has(key) ? (this.map.get(key) as T) : fallback;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
}

interface ChromeLikeStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export class ChromeKV implements KV {
  constructor(private area: ChromeLikeStorage) {}

  async get<T>(key: string, fallback: T): Promise<T> {
    const result = await this.area.get(key);
    return (result[key] as T) ?? fallback;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.area.set({ [key]: value });
  }
}
