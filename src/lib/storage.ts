import { DEFAULT_SETTINGS } from "./settings";
import type { Dataset, RosterEntry, Settings } from "./types";

const DATA_KEY = "flamingo:data:v1";
const SETTINGS_KEY = "flamingo:settings:v1";

export const EMPTY_DATASET: Dataset = { txns: [], sources: [], accountHolder: null };

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the dashboard still works for this session.
  }
}

export const loadDataset = () => read<Dataset>(DATA_KEY, EMPTY_DATASET);
export const saveDataset = (d: Dataset) => write(DATA_KEY, d);
export const loadSettings = () => read<Settings>(SETTINGS_KEY, DEFAULT_SETTINGS);
export const saveSettings = (s: Settings) => write(SETTINGS_KEY, s);

const ROSTER_KEY = "flamingo:roster:v1";

export function loadRoster(): RosterEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(ROSTER_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
export const saveRoster = (r: RosterEntry[]) => write(ROSTER_KEY, r);
