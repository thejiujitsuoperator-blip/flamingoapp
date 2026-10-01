import type { BackupStatus, ImportRecord, RosterVersion } from "./audit";
import { toBase64, type OriginalFile } from "./vault";
import type { Txn } from "./types";

/**
 * Backups to the owner's Google Drive through their claude.ai Google Drive connector (the page's
 * `mcp` capability). Each import becomes two files in one folder: the original statement and a
 * JSON audit record; each member-list version becomes one JSON file.
 */

const SERVER = "Google Drive";
const FOLDER_TITLE = "Flamingo Members backups";
/** Tool input is capped at 1 MiB; leave room for the rest of the call. */
const MAX_INLINE_BASE64 = 900_000;

interface McpError {
  code: string;
  message: string;
}
interface Mcp {
  callTool(server: string, tool: string, input: unknown): Promise<{ payload?: unknown }>;
}

let mcpPromise: Promise<Mcp | null> | null = null;

export function driveAvailable(): Promise<Mcp | null> {
  const use = (window as unknown as { claude?: { use?: (n: string) => Promise<unknown> } }).claude?.use;
  mcpPromise ??= use ? (use("mcp").catch(() => null) as Promise<Mcp | null>) : Promise.resolve(null);
  return mcpPromise;
}

function explain(err: unknown): string {
  const e = err as McpError;
  switch (e?.code) {
    case "needs_reauth":
      return "Google Drive needs reconnecting: claude.ai Settings → Connectors.";
    case "server_not_connected":
    case "server_not_found":
      return "Google Drive isn't connected: add it in claude.ai Settings → Connectors.";
    case "selection_required":
      return "Choose which Google Drive account to use when claude.ai asks, then retry.";
    case "not_in_manifest":
      return "Google Drive isn't allowed for this page. Allow it when asked, then retry.";
    case "blocked_by_policy":
    case "approval_required":
      return "Your organization doesn't allow this page to use Google Drive.";
    case "tool_error":
      return `Google Drive refused the file: ${e.message}`;
    case "server_unavailable":
      return "Google Drive didn't respond. Retry in a minute.";
    default:
      return "The backup didn't go through. Retry in a minute.";
  }
}

function fileId(payload: unknown): string | null {
  const p = payload as { id?: unknown; file?: { id?: unknown } } | null;
  const id = p?.id ?? p?.file?.id;
  return typeof id === "string" ? id : null;
}

async function createFile(mcp: Mcp, input: Record<string, unknown>): Promise<string | null> {
  const res = await mcp.callTool(SERVER, "create_file", input);
  return fileId(res.payload);
}

/** The backup folder's id, creating the folder the first time. Null means "save at the top of My Drive". */
async function ensureFolder(mcp: Mcp, known: string | null, remember: (id: string) => Promise<void>): Promise<string | null> {
  if (known) return known;
  const id = await createFile(mcp, { title: FOLDER_TITLE, contentMimeType: "application/vnd.google-apps.folder" });
  if (id) await remember(id);
  return id;
}

const day = (iso: string) => iso.slice(0, 10);

function jsonFile(title: string, parentId: string | null, body: unknown) {
  return {
    title,
    textContent: JSON.stringify(body, null, 2),
    contentMimeType: "application/json",
    disableConversionToGoogleType: true,
    ...(parentId ? { parentId } : {}),
  };
}

export interface DriveContext {
  folderId: string | null;
  rememberFolder: (id: string) => Promise<void>;
}

export async function backupImport(
  record: ImportRecord,
  rows: Txn[],
  original: OriginalFile | null,
  ctx: DriveContext,
): Promise<BackupStatus> {
  const at = new Date().toISOString();
  const mcp = await driveAvailable();
  if (!mcp) return { state: "failed", at, detail: "Google Drive can only be reached from the page on claude.ai." };
  try {
    const folder = await ensureFolder(mcp, ctx.folderId, ctx.rememberFolder);
    const prefix = `${day(record.uploadedAt)} ${record.periodFrom} to ${record.periodTo}`;
    let originalNote = "";
    if (original) {
      const base64 = toBase64(original.bytes);
      if (base64.length <= MAX_INLINE_BASE64) {
        await createFile(mcp, {
          title: `${prefix} ${original.fileName}`,
          base64Content: base64,
          contentMimeType: original.contentType || "application/octet-stream",
          disableConversionToGoogleType: true,
          ...(folder ? { parentId: folder } : {}),
        });
      } else {
        originalNote = " The original file is too large to send to Drive; it's kept on claude.ai.";
      }
    }
    await createFile(mcp, jsonFile(`${prefix} audit record.json`, folder, { record, rows }));
    return { state: "done", at, detail: `Saved to "${FOLDER_TITLE}" in Google Drive.${originalNote}` };
  } catch (err) {
    return { state: "failed", at, detail: explain(err) };
  }
}

export async function backupRosterVersion(version: RosterVersion, ctx: DriveContext): Promise<BackupStatus> {
  const at = new Date().toISOString();
  const mcp = await driveAvailable();
  if (!mcp) return { state: "failed", at, detail: "Google Drive can only be reached from the page on claude.ai." };
  try {
    const folder = await ensureFolder(mcp, ctx.folderId, ctx.rememberFolder);
    const { backup: _omit, ...body } = version;
    await createFile(mcp, jsonFile(`${day(version.createdAt)} member list (${version.entries.length} names).json`, folder, body));
    return { state: "done", at, detail: `Saved to "${FOLDER_TITLE}" in Google Drive.` };
  } catch (err) {
    return { state: "failed", at, detail: explain(err) };
  }
}

/** One JSON file holding the whole history: every import with its rows, list versions, change log, settings. */
export function snapshotJson(state: { imports: ImportRecord[]; rows: Record<string, Txn[]>; rosterVersions: RosterVersion[]; changes: unknown[]; config: unknown }): string {
  return JSON.stringify(
    {
      takenAt: new Date().toISOString(),
      imports: state.imports.map((record) => ({ record, rows: state.rows[record.id] ?? [] })),
      rosterVersions: state.rosterVersions,
      changes: state.changes,
      config: state.config,
    },
    null,
    2,
  );
}

export function snapshotTitle(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())} full backup.json`;
}

export async function backupSnapshot(json: string, ctx: DriveContext): Promise<BackupStatus> {
  const at = new Date().toISOString();
  const mcp = await driveAvailable();
  if (!mcp) return { state: "failed", at, detail: "Google Drive can only be reached from the page on claude.ai." };
  try {
    const folder = await ensureFolder(mcp, ctx.folderId, ctx.rememberFolder);
    await createFile(mcp, {
      title: snapshotTitle(),
      textContent: json,
      contentMimeType: "application/json",
      disableConversionToGoogleType: true,
      ...(folder ? { parentId: folder } : {}),
    });
    return { state: "done", at, detail: `Saved to "${FOLDER_TITLE}" in Google Drive.` };
  } catch (err) {
    return { state: "failed", at, detail: explain(err) };
  }
}
