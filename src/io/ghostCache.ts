/**
 * Browser-side cache (IndexedDB) for what the TM Exchange tab fetches: record
 * lists and converted driving lines. A reload then shows the lists at once
 * and re-adding a line costs no download or conversion.
 *
 * This is a CACHE, not storage: lines shown on a layer are saved with the map
 * (mapStore), and everything here can be fetched again. So every failure —
 * no IndexedDB (tests, private windows), a full disk, a blocked database — is
 * swallowed: a miss on read, a no-op on write.
 *
 * Entries are keyed by what makes them immutable where possible: a Nadeo
 * record's line by map, account AND time (a new personal best is a new key),
 * a TMX replay's by its replay id. Lists carry their age so the panel can say
 * how old they are and refresh them.
 */
const DB_NAME = "trackedit-ghosts";
const DB_VERSION = 1;
export type CacheStore = "lists" | "lines";
const STORES: CacheStore[] = ["lists", "lines"];
/** Driving lines are tens of KB each; keep the newest this many. */
const MAX_LINES = 300;

export interface Cached<T> {
  /** When it was fetched (ms since epoch). */
  at: number;
  value: T;
}

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

const done = <T>(req: IDBRequest<T>): Promise<T | undefined> =>
  new Promise((resolve) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(undefined);
  });

export async function cacheGet<T>(store: CacheStore, key: string): Promise<Cached<T> | null> {
  try {
    const db = await open();
    if (!db) return null;
    const hit = await done(db.transaction(store, "readonly").objectStore(store).get(key) as IDBRequest<Cached<T> | undefined>);
    return hit && typeof hit.at === "number" ? hit : null;
  } catch {
    return null;
  }
}

export async function cachePut<T>(store: CacheStore, key: string, value: T): Promise<void> {
  try {
    const db = await open();
    if (!db) return;
    const os = db.transaction(store, "readwrite").objectStore(store);
    await done(os.put({ at: Date.now(), value } satisfies Cached<T>, key));
    if (store === "lines") void trimLines(db);
  } catch {
    /* a cache that cannot be written is only slower */
  }
}

/** Drop the oldest lines beyond MAX_LINES. */
async function trimLines(db: IDBDatabase): Promise<void> {
  try {
    const read = db.transaction("lines", "readonly").objectStore("lines");
    // Both requests are issued before anything is awaited, so they share the transaction.
    const [k, v] = await Promise.all([done(read.getAllKeys()), done(read.getAll())]);
    const keys = (k ?? []) as string[], values = (v ?? []) as Cached<unknown>[];
    if (keys.length <= MAX_LINES) return;
    const oldest = keys.map((k, i) => ({ k, at: values[i]?.at ?? 0 })).sort((a, b) => a.at - b.at).slice(0, keys.length - MAX_LINES);
    const write = db.transaction("lines", "readwrite").objectStore("lines");
    for (const { k } of oldest) write.delete(k);
  } catch {
    /* next write tries again */
  }
}

/** "just now", "12 min ago", "3 h ago", "5 days ago". */
export function ageText(at: number, now = Date.now()): string {
  const min = Math.floor((now - at) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}
