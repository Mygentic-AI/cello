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
  offer_lifetime_minutes: { default: 10_080, min: 1, max: 525_600, description: "How long a call waits for an answer before it expires." },
  channel_check_seconds: { default: 30, min: 1, max: 86_400, description: "How often the daemon checks every channel, in case a push was missed. A change takes effect at once." },
  channel_lost_wait_seconds: { default: 3_600, min: 1, max: 2_592_000, description: "How long a missing channel post is asked for before a reader calls it lost and moves on, and its publisher is told. A change takes effect at once." },
  channel_default_retention_days: { default: 7, min: 1, max: 3_650, description: "How long a new channel keeps posts unless channel-create says otherwise. The server sets the most it allows." },
  channel_local_retention_days: { default: 30, min: 1, max: 36_500, description: "How long this machine keeps channel posts it has read, and your own posts in its log. Positions and unread posts are kept." },
  channel_read_wait_seconds: { default: 20, min: 0, max: 60, description: "How long channel-read waits for posts to be screened. What isn't ready by then is listed as still screening, and a doorbell rings when it is." },
} as const satisfies Record<string, Setting>;

// Settings that are words rather than numbers. The same rule: the default is written to the database on first start.
export const TEXT_SETTINGS = {
  issuer_url: { default: "https://trust.celloprotocol.com", description: "The issuer this daemon redeems codes at and collects signals from. Which issuers count is decided by the signed list, not by this." },
  concierge_address: { default: "", description: "The agent setup calls to prove this one works. Empty means there's nothing to call yet." },
} as const satisfies Record<string, { default: string; description: string }>;
export type TextSettingName = keyof typeof TEXT_SETTINGS;
const TEXT_NAMES = Object.keys(TEXT_SETTINGS) as TextSettingName[];

export const DEFAULT_SERVER_URL = "wss://server.celloprotocol.com/v1";

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
  for (const name of TEXT_NAMES) {
    if (store.getConfig(`setting.${name}`) === undefined) store.setConfig(`setting.${name}`, TEXT_SETTINGS[name].default);
  }
  return loaded;
}

// For what reads a setting each time it's needed, so a change takes effect with no restart.
export function currentSetting(store: Store, name: SettingName): number {
  return checked(name, store.getConfig(configKey(name)) ?? String(SETTINGS[name].default));
}

export function currentText(store: Store, name: TextSettingName): string {
  return store.getConfig(`setting.${name}`) ?? TEXT_SETTINGS[name].default;
}

export function changeSetting(store: Store, name: string, raw: string): void {
  if (TEXT_NAMES.includes(name as TextSettingName)) {
    store.setConfig(`setting.${name}`, raw);
    return;
  }
  if (!NAMES.includes(name as SettingName)) throw new SettingError(`there's no setting named ${name}. They are: ${[...NAMES, ...TEXT_NAMES].join(", ")}`);
  store.setConfig(configKey(name as SettingName), String(checked(name as SettingName, raw)));
}

export function listSettings(store: Store): { name: string; value: number | string; default: number | string; description: string }[] {
  return [
    ...NAMES.map((name) => ({ name, value: Number(store.getConfig(configKey(name)) ?? SETTINGS[name].default), default: SETTINGS[name].default, description: SETTINGS[name].description })),
    ...TEXT_NAMES.map((name) => ({ name, value: currentText(store, name), default: TEXT_SETTINGS[name].default, description: TEXT_SETTINGS[name].description })),
  ];
}
