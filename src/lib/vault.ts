import type { BackupStatus, ChangeEntry, ImportRecord, RosterVersion } from "./audit";
import { DEFAULT_SETTINGS } from "./settings";
import type { RosterEntry, Settings, Txn } from "./types";

/**
 * Append-only history of everything uploaded or changed. Imports, member-list versions and
 * change-log entries are only ever added; the one thing updated in place is the current
 * configuration (settings and member-list matches), and every change to it is also logged.
 */

export interface VaultConfig {
  settings: Settings;
  /** Manual member-list matches: list entry id → member id, or null for "not in statements". */
  rosterLinks: Record<string, string | null>;
  driveFolderId: string | null;
}

export interface VaultState {
  imports: ImportRecord[];
  rows: Record<string, Txn[]>;
  rosterVersions: RosterVersion[];
  changes: ChangeEntry[];
  config: VaultConfig;
}

export interface OriginalFile {
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface Vault {
  /** "cloud": saved on claude.ai with the page. "browser": this browser only. */
  kind: "cloud" | "browser";
  canWrite: boolean;
  userId: string | null;
  load(): Promise<VaultState>;
  /** Stores the original file (when possible), the parsed rows, then the import record. */
  addImport(record: ImportRecord, rows: Txn[], original: OriginalFile | null): Promise<ImportRecord>;
  setImportBackup(id: string, backup: BackupStatus): Promise<void>;
  addRosterVersion(version: RosterVersion): Promise<void>;
  setRosterBackup(id: string, backup: BackupStatus): Promise<void>;
  addChange(change: ChangeEntry): Promise<void>;
  saveConfig(config: VaultConfig): Promise<void>;
  readOriginal(record: ImportRecord): Promise<OriginalFile | null>;
}

export const EMPTY_STATE: VaultState = {
  imports: [],
  rows: {},
  rosterVersions: [],
  changes: [],
  config: { settings: DEFAULT_SETTINGS, rosterLinks: {}, driveFolderId: null },
};

/** The current member list: the latest version's entries with manual matches applied. */
export function currentRoster(state: VaultState): RosterEntry[] {
  const latest = [...state.rosterVersions].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).pop();
  return (latest?.entries ?? []).map((e) => {
    const { linkedMemberId: _ignored, ...rest } = e;
    return e.id in state.config.rosterLinks ? { ...rest, linkedMemberId: state.config.rosterLinks[e.id] } : rest;
  });
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export { fromBase64, toBase64 };

// ---------- Browser storage (local runs) ----------

const BROWSER_KEY = "flamingo:vault:v1";

export class BrowserVault implements Vault {
  kind = "browser" as const;
  canWrite = true;
  userId = null;
  private state: VaultState = EMPTY_STATE;

  async load(): Promise<VaultState> {
    try {
      const raw = localStorage.getItem(BROWSER_KEY);
      if (raw) this.state = { ...EMPTY_STATE, ...JSON.parse(raw) };
    } catch {
      // Unreadable storage: start empty for this visit.
    }
    return this.state;
  }

  private persist(next: VaultState) {
    this.state = next;
    try {
      localStorage.setItem(BROWSER_KEY, JSON.stringify(next));
    } catch {
      throw new Error("This browser's storage is full or blocked, so the change couldn't be saved.");
    }
  }

  async addImport(record: ImportRecord, rows: Txn[]): Promise<ImportRecord> {
    this.persist({ ...this.state, imports: [...this.state.imports, record], rows: { ...this.state.rows, [record.id]: rows } });
    return record;
  }
  async setImportBackup(id: string, backup: BackupStatus) {
    this.persist({ ...this.state, imports: this.state.imports.map((i) => (i.id === id ? { ...i, backup } : i)) });
  }
  async addRosterVersion(version: RosterVersion) {
    this.persist({ ...this.state, rosterVersions: [...this.state.rosterVersions, version] });
  }
  async setRosterBackup(id: string, backup: BackupStatus) {
    this.persist({ ...this.state, rosterVersions: this.state.rosterVersions.map((v) => (v.id === id ? { ...v, backup } : v)) });
  }
  async addChange(change: ChangeEntry) {
    this.persist({ ...this.state, changes: [...this.state.changes, change] });
  }
  async saveConfig(config: VaultConfig) {
    this.persist({ ...this.state, config });
  }
  async readOriginal(): Promise<OriginalFile | null> {
    return null;
  }
}

// ---------- claude.ai storage (published artifact) ----------

interface DbError {
  code: string;
  message: string;
}
interface DocSnap {
  id: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}
interface DocRef {
  get(): Promise<DocSnap>;
  set(data: Record<string, unknown>): Promise<void>;
  update(data: Record<string, unknown>): Promise<void>;
}
interface QueryRef {
  limit(n: number): QueryRef;
  get(): Promise<{ docs: DocSnap[] }>;
}
interface CollectionRef extends QueryRef {
  doc(id: string): DocRef;
}
export interface Db {
  doc(path: string): DocRef;
  collection(path: string): CollectionRef;
}
export interface Assets {
  upload(blob: Blob, options?: { type?: string }): Promise<{ id: string }>;
}

const ROWS_PER_DOC = 400;

function friendly(err: unknown): Error {
  const code = (err as DbError)?.code;
  if (code === "quota_exceeded") return new Error("Storage for this page is full. Older uploads would need to be removed first.");
  if (code === "invalid_argument") return new Error("Only the page's owner can save changes.");
  if (code === "revoked") return new Error("Access to this page's storage was withdrawn. Reload the page.");
  if (code === "too_large") return new Error("That file is over 20 MB, too large to keep a copy of.");
  return new Error("Saving to claude.ai didn't work just now. Try again in a moment.");
}

async function retryOnce<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const code = (err as DbError)?.code;
    if (code !== "unavailable" && code !== "store_unavailable") throw friendly(err);
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 600));
    try {
      return await fn();
    } catch (again) {
      throw friendly(again);
    }
  }
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class CloudVault implements Vault {
  kind = "cloud" as const;
  constructor(
    private db: Db,
    private assets: Assets | null,
    public userId: string | null,
    public canWrite: boolean,
  ) {}

  async load(): Promise<VaultState> {
    const [imports, rowDocs, versions, changes, config] = await Promise.all([
      retryOnce(() => this.db.collection("imports").limit(1000).get()),
      retryOnce(() => this.db.collection("importRows").limit(1000).get()),
      retryOnce(() => this.db.collection("rosterVersions").limit(1000).get()),
      retryOnce(() => this.db.collection("changes").limit(1000).get()),
      retryOnce(() => this.db.doc("config/current").get()),
    ]);
    const rows: Record<string, Txn[]> = {};
    const chunks = rowDocs.docs
      .map((d) => d.data() as { importId: string; n: number; rows: Txn[] })
      .sort((a, b) => a.importId.localeCompare(b.importId) || a.n - b.n);
    for (const c of chunks) (rows[c.importId] ??= []).push(...c.rows);
    const cfg = config.exists ? (config.data() as Partial<VaultConfig>) : {};
    return {
      imports: imports.docs.map((d) => clone(d.data()) as unknown as ImportRecord),
      rows,
      rosterVersions: versions.docs.map((d) => clone(d.data()) as unknown as RosterVersion),
      changes: changes.docs.map((d) => clone(d.data()) as unknown as ChangeEntry).sort((a, b) => a.at.localeCompare(b.at)),
      config: {
        settings: { ...DEFAULT_SETTINGS, ...(cfg.settings ?? {}) },
        rosterLinks: cfg.rosterLinks ?? {},
        driveFolderId: cfg.driveFolderId ?? null,
      },
    };
  }

  async addImport(record: ImportRecord, rows: Txn[], original: OriginalFile | null): Promise<ImportRecord> {
    let fileAssetId: string | null = null;
    if (original && this.assets) {
      // Spreadsheets aren't an accepted asset type, so the original travels inside a JSON wrapper.
      const wrapped = JSON.stringify({ fileName: original.fileName, contentType: original.contentType, base64: toBase64(original.bytes) });
      const res = await retryOnce(() => this.assets!.upload(new Blob([wrapped], { type: "application/json" }), { type: "application/json" }));
      fileAssetId = res.id;
    }
    for (let n = 0; n * ROWS_PER_DOC < rows.length; n++) {
      const chunk = rows.slice(n * ROWS_PER_DOC, (n + 1) * ROWS_PER_DOC);
      await retryOnce(() => this.db.doc(`importRows/${record.id}-${n}`).set({ importId: record.id, n, rows: chunk }));
    }
    // The import record goes last, so a record only exists once its rows are safely stored.
    const saved = { ...record, fileAssetId };
    await retryOnce(() => this.db.doc(`imports/${record.id}`).set(clone(saved) as unknown as Record<string, unknown>));
    return saved;
  }

  async setImportBackup(id: string, backup: BackupStatus) {
    await retryOnce(() => this.db.doc(`imports/${id}`).update({ backup }));
  }
  async addRosterVersion(version: RosterVersion) {
    await retryOnce(() => this.db.doc(`rosterVersions/${version.id}`).set(clone(version) as unknown as Record<string, unknown>));
  }
  async setRosterBackup(id: string, backup: BackupStatus) {
    await retryOnce(() => this.db.doc(`rosterVersions/${id}`).update({ backup }));
  }
  async addChange(change: ChangeEntry) {
    await retryOnce(() => this.db.doc(`changes/${change.id}`).set(clone(change) as unknown as Record<string, unknown>));
  }
  async saveConfig(config: VaultConfig) {
    await retryOnce(() => this.db.doc("config/current").set(clone(config) as unknown as Record<string, unknown>));
  }

  async readOriginal(record: ImportRecord): Promise<OriginalFile | null> {
    if (!record.fileAssetId) return null;
    const res = await fetch(`/_blob/${record.fileAssetId}`);
    if (!res.ok) return null;
    const json = (await res.json()) as { fileName: string; contentType: string; base64: string };
    return { fileName: json.fileName, contentType: json.contentType, bytes: fromBase64(json.base64) };
  }
}

// ---------- Choosing a vault ----------

interface UserCap {
  id(): Promise<string | null>;
  isOwner(): Promise<boolean>;
}
type Use = (name: string) => Promise<unknown>;

/** claude.ai storage inside the published page; this browser's storage everywhere else. */
export async function openVault(): Promise<Vault> {
  const use = (window as unknown as { claude?: { use?: Use } }).claude?.use;
  if (use) {
    const [db, assets, user] = await Promise.all([
      use("db").catch(() => null) as Promise<Db | null>,
      use("assets").catch(() => null) as Promise<Assets | null>,
      use("user").catch(() => null) as Promise<UserCap | null>,
    ]);
    if (db) {
      const [userId, isOwner] = await Promise.all([
        user?.id().catch(() => null) ?? null,
        user?.isOwner().catch(() => true) ?? true,
      ]);
      return new CloudVault(db, assets, userId, isOwner);
    }
  }
  return new BrowserVault();
}

// ---------- Data saved by the previous version of the app ----------

export interface LegacyData {
  txns: Txn[];
  fileNames: string[];
  accountHolder: string | null;
  settings: Settings | null;
  roster: RosterEntry[];
}

/** Statements and member list the previous version kept in this browser, if any. */
export function readLegacyData(): LegacyData | null {
  try {
    const data = JSON.parse(localStorage.getItem("flamingo:data:v1") ?? "null");
    const settings = JSON.parse(localStorage.getItem("flamingo:settings:v1") ?? "null");
    const roster = JSON.parse(localStorage.getItem("flamingo:roster:v1") ?? "[]");
    const real = data?.txns?.length && !data.sources?.some((s: { fileName: string }) => s.fileName === "Demo data");
    if (!real && !(Array.isArray(roster) && roster.length)) return null;
    return {
      txns: real ? data.txns : [],
      fileNames: real ? data.sources.map((s: { fileName: string }) => s.fileName) : [],
      accountHolder: real ? data.accountHolder : null,
      settings: settings ? { ...DEFAULT_SETTINGS, ...settings } : null,
      roster: Array.isArray(roster) ? roster : [],
    };
  } catch {
    return null;
  }
}
