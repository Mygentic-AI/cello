// Everything a person might adjust lives in the daemon's encrypted database, with its default written there on first start,
// so moving the database and its key moves all of it. Protocol and internal retry timing stay constants in the code.
import type { Store } from "./store.ts";

interface Setting { default: number; min: number; max: number; description: string }

export const SETTINGS = {
  screener_workers: { default: 1, min: 1, max: 8, description: "Screening threads. Each costs about 1 GB with the model, and more than one hasn't been measured to help." },
  screener_model_threads: { default: 4, min: 1, max: 64, description: "CPU threads the model uses in each screening thread. Fewer costs less CPU, and long messages take longer." },
  screener_worker_memory_mb: { default: 2048, min: 16, max: 65536, description: "The JavaScript memory one screening thread may use. Past it the thread crashes and restarts, and the message stays undelivered." },
  screener_measure_max_bytes: { default: 16_000, min: 1_000, max: 1_000_000, description: "A message up to this size is measured straight away to see if it's short. A longer one goes to the long lane." },
  screener_short_max_windows: { default: 1, min: 1, max: 100, description: "A message of up to this many model windows goes in the short lane." },
  screener_tell_after_ms: { default: 3_000, min: 0, max: 3_600_000, description: "How long a message can wait for its screen before both sides are told." },
  screener_max_attempts: { default: 3, min: 1, max: 100, description: "How many times a screen can fail on one message before that message is refused, so it can't hold its conversation up for good." },
  sender_backlog_gap: { default: 8, min: 1, max: 100_000, description: "How many of your messages a reader can be behind on screening before your daemon waits before sending the next." },
  sender_backlog_wait_ms: { default: 10_000, min: 0, max: 600_000, description: "The longest one send waits for a reader to catch up. Then it goes anyway, and says so." },
} as const satisfies Record<string, Setting>;

export type SettingName = keyof typeof SETTINGS;
export type Settings = Record<SettingName, number>;

const NAMES = Object.keys(SETTINGS) as SettingName[];
const configKey = (name: SettingName): string => `setting.${name}`;

export class SettingError extends Error {}

function checked(name: SettingName, raw: string): number {
  const value = Number(raw);
  const { min, max } = SETTINGS[name];
  if (!Number.isInteger(value) || value < min || value > max) throw new SettingError(`${name} must be a whole number from ${min} to ${max}, not ${raw}`);
  return value;
}

// Writes any default that's missing, and fails by name on a stored value that doesn't make sense.
export function loadSettings(store: Store): Settings {
  const loaded = {} as Settings;
  for (const name of NAMES) {
    const stored = store.getConfig(configKey(name));
    if (stored === undefined) store.setConfig(configKey(name), String(SETTINGS[name].default));
    loaded[name] = stored === undefined ? SETTINGS[name].default : checked(name, stored);
  }
  return loaded;
}

export function changeSetting(store: Store, name: string, raw: string): void {
  if (!NAMES.includes(name as SettingName)) throw new SettingError(`there's no setting named ${name}. They are: ${NAMES.join(", ")}`);
  store.setConfig(configKey(name as SettingName), String(checked(name as SettingName, raw)));
}

export function listSettings(store: Store): { name: string; value: number; default: number; description: string }[] {
  return NAMES.map((name) => ({ name, value: Number(store.getConfig(configKey(name)) ?? SETTINGS[name].default), default: SETTINGS[name].default, description: SETTINGS[name].description }));
}
