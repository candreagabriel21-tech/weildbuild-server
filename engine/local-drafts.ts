// ═══════════════════════════════════════════════════════════════════
// WeildBuild, on-device private drafts (v2.0, IndexedDB)
// ═══════════════════════════════════════════════════════════════════
// PRIVATE work-in-progress games live ONLY on the player's device.
// Nothing here ever touches a WeildBuild server: no fetch, no socket,
// no upload. v2.0 (user decision): drafts are stored as PLAIN JSON,
// exactly like the server's working copies - encryption happens only
// when a file leaves the device (File > Export writes the encrypted
// .wbworld file). Drafts saved by v1.x (encrypted .wbworld blobs) are
// still read transparently by the legacy fallback in loadLocalDraft.
//
// Everything runs against IndexedDB (async, large quota, per-origin).
// Guests can use drafts exactly like logged-in players - a device-local
// build is the one thing that never needs an account.
//
// API:
//   listLocalDrafts()            -> DraftMeta[] (newest first)
//   saveLocalDraft({id?, name, description}) -> DraftMeta
//   loadLocalDraft(id)           -> restores the studio store 1:1
//   deleteLocalDraft(id)         -> true when removed
//   renameLocalDraft(id, name)   -> DraftMeta | null
//   getCurrentDraftId() / setCurrentDraftId(id | null)  (localStorage
//     remembers which draft the studio session has open)
//   estimateLocalDraftsUsage()   -> { usage, quota } from the browser

import {
  buildWbworldPayload,
  decryptWbworld,
  base64ToBytes,
} from './wbworld';
import { restoreStudioState, isValidStudioState, type StudioProjectState } from './studio-project';
import { useStudioStore } from './studio-store';

const DB_NAME = 'weildbuild-drafts';
const DB_VERSION = 1;
const STORE = 'drafts';
const CURRENT_DRAFT_KEY = 'wb-current-draft';

export interface DraftMeta {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  objectCount: number;
  /** Size of the stored world data in bytes (reporting only). */
  bytesLen: number;
}

interface DraftRecord extends DraftMeta {
  /** v2.0: the world as PLAIN studioState JSON. */
  studioState?: any;
  /** v1.x legacy: the encrypted .wbworld blob (base64). Read-only fallback. */
  world_b64?: string;
}

// ─── IndexedDB plumbing ───

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this environment.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open the drafts database.'));
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = fn(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

function newDraftId(): string {
  return `draft_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// ─── Public API ───

/** All drafts on this device, newest first. Empty array on any failure. */
export async function listLocalDrafts(): Promise<DraftMeta[]> {
  try {
    const records = await tx<DraftRecord[]>('readonly', (s) => s.getAll() as IDBRequest<DraftRecord[]>);
    return records
      .map(({ studioState: _plain, world_b64: _blob, ...meta }) => meta)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/** Bytes of a stored world (plain JSON string length, approximate). */
function worldBytes(studioState: any): number {
  try {
    return JSON.stringify(studioState).length;
  } catch {
    return 0;
  }
}

/**
 * Snapshot the LIVE studio store into a PLAIN draft (v2.0). Creates a new
 * draft when `id` is absent (or unknown), updates the existing one
 * otherwise. Saving an existing v1.x draft upgrades it to plain storage.
 */
export async function saveLocalDraft(opts: { id?: string | null; name?: string; description?: string }): Promise<DraftMeta> {
  const name = (opts.name ?? '').trim() || 'My Draft';
  const description = (opts.description ?? '').trim();

  const payload = buildWbworldPayload(name, description);
  const studioState = payload.studioState;
  const bytesLen = worldBytes(studioState);

  const now = Date.now();
  let record: DraftRecord;
  if (opts.id) {
    const existing = await tx<DraftRecord | undefined>('readonly', (s) => s.get(opts.id!) as IDBRequest<DraftRecord | undefined>);
    if (existing) {
      record = {
        ...existing,
        name,
        description,
        updatedAt: now,
        objectCount: studioState.objects.length,
        bytesLen,
        studioState,
        world_b64: undefined, // the v1.x blob is replaced by the plain copy
      };
    } else {
      record = {
        id: opts.id,
        name,
        description,
        createdAt: now,
        updatedAt: now,
        objectCount: studioState.objects.length,
        bytesLen,
        studioState,
      };
    }
  } else {
    record = {
      id: newDraftId(),
      name,
      description,
      createdAt: now,
      updatedAt: now,
      objectCount: studioState.objects.length,
      bytesLen,
      studioState,
    };
  }

  await tx('readwrite', (s) => s.put(record));
  setCurrentDraftId(record.id);
  const { studioState: _p, world_b64: _b, ...meta } = record;
  return meta;
}

/** Load a draft into the live studio store (1:1 restore). Reads the
 *  plain v2.0 copy, or decrypts the v1.x blob when that's all there
 *  is. Throws on missing/corrupt drafts with a message safe to show. */
export async function loadLocalDraft(id: string): Promise<DraftMeta> {
  const record = await tx<DraftRecord | undefined>('readonly', (s) => s.get(id) as IDBRequest<DraftRecord | undefined>);
  if (!record) throw new Error('That draft is gone (it may have been deleted).');
  let studioState: any = record.studioState ?? null;
  if (!studioState && record.world_b64) {
    // v1.x draft (encrypted): decrypt it.
    try {
      const payload = await decryptWbworld(base64ToBytes(record.world_b64));
      studioState = payload?.studioState ?? null;
    } catch {
      throw new Error('That draft is corrupted and cannot be opened.');
    }
  }
  if (!studioState || !isValidStudioState(studioState)) {
    throw new Error('That draft has no loadable world data.');
  }
  restoreStudioState(studioState as StudioProjectState);
  setCurrentDraftId(record.id);
  const { studioState: _p, world_b64: _b, ...meta } = record;
  return meta;
}

/** Permanently remove a draft from this device. */
export async function deleteLocalDraft(id: string): Promise<boolean> {
  const gone = await tx<IDBValidKey>('readwrite', (s) => s.delete(id) as unknown as IDBRequest<IDBValidKey>);
  if (getCurrentDraftId() === id) setCurrentDraftId(null);
  return gone !== undefined; // delete succeeds silently; the id no longer matters
}

/** Rename a draft in place. */
export async function renameLocalDraft(id: string, name: string): Promise<DraftMeta | null> {
  const record = await tx<DraftRecord | undefined>('readonly', (s) => s.get(id) as IDBRequest<DraftRecord | undefined>);
  if (!record) return null;
  const updated: DraftRecord = { ...record, name: name.trim() || record.name, updatedAt: Date.now() };
  await tx('readwrite', (s) => s.put(updated));
  const { studioState: _p, world_b64: _b, ...meta } = updated;
  return meta;
}

// ─── The studio session's current draft (localStorage pointer) ───

/** Which draft the studio currently has open (null = none / unpublished). */
export function getCurrentDraftId(): string | null {
  try {
    return localStorage.getItem(CURRENT_DRAFT_KEY);
  } catch {
    return null;
  }
}

export function setCurrentDraftId(id: string | null): void {
  try {
    if (id) localStorage.setItem(CURRENT_DRAFT_KEY, id);
    else localStorage.removeItem(CURRENT_DRAFT_KEY);
  } catch {
    /* private mode - drafts still work, the pointer just won't persist */
  }
}

/** Browser storage usage for the drafts origin (best effort). */
export async function estimateLocalDraftsUsage(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (navigator.storage?.estimate) {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      return { usage, quota };
    }
  } catch {
    /* not supported */
  }
  return null;
}
