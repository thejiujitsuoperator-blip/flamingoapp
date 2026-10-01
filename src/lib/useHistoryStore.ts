import { useCallback, useEffect, useRef, useState } from "react";
import {
  combineImports,
  describeSettingsChange,
  describeTxnId,
  findDuplicate,
  newId,
  PARSER_VERSION,
  rosterDiff,
  runChecks,
  sha256Hex,
  statementPeriod,
  type ChangeEntry,
  type ImportRecord,
  type RosterVersion,
} from "./audit";
import { formatDate } from "./dates";
import { backupImport, backupRosterVersion } from "./drive";
import { analyse, monthly } from "./members";
import type { Dataset, RosterEntry, Settings } from "./types";
import { currentRoster, openVault, readLegacyData, type LegacyData, type OriginalFile, type Vault, type VaultState } from "./vault";

export const monthlyFor = (settings: Settings) => (d: Dataset) =>
  monthly(analyse(d, settings, d.txns.length ? d.txns[d.txns.length - 1].date : "2000-01-01"));

const SETTINGS_SAVE_DELAY = 1200;

/** Loads the upload history and exposes every action that adds to it. */
export function useHistoryStore() {
  const [vault, setVault] = useState<Vault | null>(null);
  const [state, setState] = useState<VaultState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [legacy, setLegacy] = useState<LegacyData | null>(null);
  const stateRef = useRef<VaultState | null>(null);
  stateRef.current = state;

  // Settings edits are saved after a pause, with one change-log entry per pause.
  const savedSettings = useRef<Settings | null>(null);
  const settingsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await openVault();
        const s = await v.load();
        if (cancelled) return;
        savedSettings.current = s.config.settings;
        setVault(v);
        setState(s);
        if (!s.imports.length && !s.rosterVersions.length) setLegacy(readLegacyData());
      } catch (err) {
        if (!cancelled) setLoadError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const logChange = useCallback(
    async (kind: ChangeEntry["kind"], lines: string[]) => {
      if (!vault || !lines.length) return;
      const change: ChangeEntry = { id: newId(), at: new Date().toISOString(), by: vault.userId, kind, lines };
      await vault.addChange(change);
      setState((s) => (s ? { ...s, changes: [...s.changes, change] } : s));
    },
    [vault],
  );

  const rememberFolder = useCallback(
    async (id: string) => {
      const s = stateRef.current;
      if (!vault || !s) return;
      const config = { ...s.config, driveFolderId: id };
      await vault.saveConfig(config);
      setState((prev) => (prev ? { ...prev, config } : prev));
    },
    [vault],
  );

  const runImportBackup = useCallback(
    async (record: ImportRecord, original: OriginalFile | null) => {
      const s = stateRef.current;
      if (!vault || vault.kind !== "cloud" || !s) return;
      const backup = await backupImport(record, s.rows[record.id] ?? [], original, {
        folderId: s.config.driveFolderId,
        rememberFolder,
      });
      await vault.setImportBackup(record.id, backup).catch(() => undefined);
      setState((prev) => (prev ? { ...prev, imports: prev.imports.map((i) => (i.id === record.id ? { ...i, backup } : i)) } : prev));
    },
    [vault, rememberFolder],
  );

  const runRosterBackup = useCallback(
    async (version: RosterVersion) => {
      const s = stateRef.current;
      if (!vault || vault.kind !== "cloud" || !s) return;
      const backup = await backupRosterVersion(version, { folderId: s.config.driveFolderId, rememberFolder });
      await vault.setRosterBackup(version.id, backup).catch(() => undefined);
      setState((prev) =>
        prev ? { ...prev, rosterVersions: prev.rosterVersions.map((v) => (v.id === version.id ? { ...v, backup } : v)) } : prev,
      );
    },
    [vault, rememberFolder],
  );

  /** Checks and stores one statement file. Returns the saved import. */
  const importStatement = useCallback(
    async (file: File): Promise<ImportRecord> => {
      const s = stateRef.current;
      if (!vault || !s) throw new Error("Still loading your history. Try again in a moment.");
      if (!vault.canWrite) throw new Error("Only the page's owner can upload statements.");
      const { parseStatement } = await import("./parseStatement");
      const buffer = await file.arrayBuffer();
      const hash = await sha256Hex(buffer);
      const dup = findDuplicate(hash, s.imports);
      if (dup) {
        throw new Error(`This exact file was already uploaded on ${formatDate(dup.uploadedAt.slice(0, 10))} as "${dup.fileName}". Nothing was added.`);
      }
      const parsed = parseStatement(buffer, file.name);
      const period = statementPeriod(parsed.source);
      const settings = s.config.settings;
      const known = new Set(combineImports(s.imports, s.rows).txns.map((t) => t.id));
      const record: ImportRecord = {
        id: newId(),
        origin: "upload",
        fileName: file.name,
        fileHash: hash,
        fileAssetId: null,
        uploadedAt: new Date().toISOString(),
        uploadedBy: vault.userId,
        accountHolder: parsed.source.accountHolder,
        periodFrom: period.from,
        periodTo: period.to,
        summary: parsed.source.summary ?? null,
        rowCount: parsed.txns.length,
        newRowCount: parsed.txns.filter((t) => !known.has(t.id)).length,
        checks: runChecks(parsed, { imports: s.imports, rows: s.rows }, monthlyFor(settings)),
        settings,
        parserVersion: PARSER_VERSION,
      };
      const original: OriginalFile = {
        fileName: file.name,
        contentType: file.type || "application/vnd.ms-excel",
        bytes: new Uint8Array(buffer),
      };
      const saved = await vault.addImport(record, parsed.txns, original);
      setState((prev) => (prev ? { ...prev, imports: [...prev.imports, saved], rows: { ...prev.rows, [saved.id]: parsed.txns } } : prev));
      stateRef.current = { ...s, imports: [...s.imports, saved], rows: { ...s.rows, [saved.id]: parsed.txns } };
      void runImportBackup(saved, original);
      return saved;
    },
    [vault, runImportBackup],
  );

  const updateSettings = useCallback(
    (fn: (s: Settings) => Settings) => {
      const s = stateRef.current;
      if (!s) return;
      const config = { ...s.config, settings: fn(s.config.settings) };
      stateRef.current = { ...s, config };
      setState((prev) => (prev ? { ...prev, config: { ...prev.config, settings: config.settings } } : prev));
      if (settingsTimer.current) clearTimeout(settingsTimer.current);
      settingsTimer.current = setTimeout(async () => {
        const latest = stateRef.current;
        if (!vault || !latest) return;
        const before = savedSettings.current ?? latest.config.settings;
        const lines = describeSettingsChange(before, latest.config.settings, describeTxnId);
        try {
          await vault.saveConfig(latest.config);
          savedSettings.current = latest.config.settings;
          setSaveError(null);
          await logChange("settings", lines);
        } catch (err) {
          setSaveError((err as Error).message);
        }
      }, SETTINGS_SAVE_DELAY);
    },
    [vault, logChange],
  );

  const saveRosterVersion = useCallback(
    async (entries: RosterEntry[], note: string) => {
      const s = stateRef.current;
      if (!vault || !s) return;
      const before = currentRoster(s);
      const clean = entries.map(({ linkedMemberId: _l, ...e }) => e);
      const diff = rosterDiff(before, clean);
      if (!diff.added.length && !diff.removed.length) return;
      const version: RosterVersion = {
        id: newId(),
        createdAt: new Date().toISOString(),
        createdBy: vault.userId,
        note,
        entries: clean,
        added: diff.added,
        removed: diff.removed,
      };
      await vault.addRosterVersion(version);
      setState((prev) => (prev ? { ...prev, rosterVersions: [...prev.rosterVersions, version] } : prev));
      stateRef.current = { ...s, rosterVersions: [...s.rosterVersions, version] };
      void runRosterBackup(version);
    },
    [vault, runRosterBackup],
  );

  /** Records a manual member-list match (undefined = back to automatic). */
  const setRosterLink = useCallback(
    async (entry: RosterEntry, memberId: string | null | undefined, describe: string) => {
      const s = stateRef.current;
      if (!vault || !s) return;
      const rosterLinks = { ...s.config.rosterLinks };
      if (memberId === undefined) delete rosterLinks[entry.id];
      else rosterLinks[entry.id] = memberId;
      const config = { ...s.config, rosterLinks };
      setState((prev) => (prev ? { ...prev, config } : prev));
      stateRef.current = { ...s, config };
      await vault.saveConfig(config);
      await logChange("match", [describe]);
    },
    [vault, logChange],
  );

  const retryImportBackup = useCallback(
    async (record: ImportRecord) => {
      if (!vault) return;
      await runImportBackup(record, await vault.readOriginal(record).catch(() => null));
    },
    [vault, runImportBackup],
  );

  /** Moves statements and the member list saved by the previous version into the history. */
  const migrateLegacy = useCallback(async () => {
    const s = stateRef.current;
    if (!vault || !s || !legacy) return;
    const settings = legacy.settings ?? s.config.settings;
    if (legacy.txns.length) {
      const dates = legacy.txns.map((t) => t.date).sort();
      const record: ImportRecord = {
        id: newId(),
        origin: "migrated",
        fileName: legacy.fileNames.join(", ") || "Earlier upload",
        fileHash: null,
        fileAssetId: null,
        uploadedAt: new Date().toISOString(),
        uploadedBy: vault.userId,
        accountHolder: legacy.accountHolder,
        periodFrom: dates[0],
        periodTo: dates[dates.length - 1],
        summary: null,
        rowCount: legacy.txns.length,
        newRowCount: legacy.txns.length,
        checks: runChecks(
          { source: { fileName: "", accountHolder: legacy.accountHolder, from: dates[0], to: dates[dates.length - 1], rows: legacy.txns.length }, txns: legacy.txns },
          { imports: [], rows: {} },
          monthlyFor(settings),
        ),
        settings,
        parserVersion: PARSER_VERSION,
      };
      const saved = await vault.addImport(record, legacy.txns, null);
      setState((prev) => (prev ? { ...prev, imports: [...prev.imports, saved], rows: { ...prev.rows, [saved.id]: legacy.txns } } : prev));
      stateRef.current = { ...stateRef.current!, imports: [...s.imports, saved], rows: { ...s.rows, [saved.id]: legacy.txns } };
    }
    const links = Object.fromEntries(legacy.roster.filter((e) => e.linkedMemberId !== undefined).map((e) => [e.id, e.linkedMemberId ?? null]));
    const config = { ...stateRef.current!.config, settings, rosterLinks: { ...stateRef.current!.config.rosterLinks, ...links } };
    await vault.saveConfig(config);
    savedSettings.current = settings;
    setState((prev) => (prev ? { ...prev, config } : prev));
    stateRef.current = { ...stateRef.current!, config };
    if (legacy.roster.length) await saveRosterVersion(legacy.roster, "Moved from this browser's earlier storage");
    await logChange("migration", [
      `Moved ${legacy.txns.length} transactions and ${legacy.roster.length} member-list names saved by the earlier version of the app into the history.`,
    ]);
    setLegacy(null);
  }, [vault, legacy, saveRosterVersion, logChange]);

  return {
    vault,
    state,
    loadError,
    saveError,
    legacy,
    dismissLegacy: () => setLegacy(null),
    importStatement,
    updateSettings,
    saveRosterVersion,
    setRosterLink,
    retryImportBackup,
    retryRosterBackup: runRosterBackup,
    migrateLegacy,
  };
}

export type HistoryStore = ReturnType<typeof useHistoryStore>;
