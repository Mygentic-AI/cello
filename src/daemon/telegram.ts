// Telegram's Bot API: the calls a notifier needs. Every call has a time limit, and a refusal carries Telegram's own words.
// The bot token is part of the address, so nothing here ever puts an address in an error.
import { type RequestOptions, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

// Where Telegram is, how long one call may take, and how long a wait for new messages is held open. Only a test changes these.
export interface TelegramEndpoint { apiUrl: string; timeoutMs: number; pollSeconds: number }
export const TELEGRAM: TelegramEndpoint = { apiUrl: "https://api.telegram.org", timeoutMs: 6_000, pollSeconds: 25 };

export class TelegramError extends Error {
  // Telegram's own error number, when it gave one: 401 is a token it doesn't know, 409 is another reader on the same bot.
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

class TimedOut extends Error {}

// Why a connection failed, in the system's own codes. Telegram has an IPv4 and an IPv6 address, and a failure to reach it
// is one error per address with an empty message of its own, so each address's code is listed.
function reason(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const each = (err as Error & { errors?: unknown[] }).errors;
  if (Array.isArray(each) && each.length > 0) return each.map((e) => { const one = e as { code?: string; address?: string; message?: string }; return `${one.code ?? one.message ?? "failed"}${one.address ? ` at ${one.address}` : ""}`; }).join(", ");
  const code = (err as Error & { code?: string }).code;
  return [code, err.message].filter((part) => typeof part === "string" && part.length > 0).join(": ") || err.name;
}

// One POST. Not fetch, for one reason: fetch gives each of a host's addresses a quarter of a second to connect before it
// moves to the next, and can't be told otherwise. On a slow link, or a machine with no IPv6 route, that fails a call Telegram
// would have answered. Here each address gets the call's whole limit.
function post(url: URL, body: string, limitMs: number, stop: AbortSignal | undefined): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === "http:" ? httpRequest : httpsRequest;
    // The connection option is passed through to the socket. The request's own types don't list it.
    const options: RequestOptions & { autoSelectFamilyAttemptTimeout: number } = { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, autoSelectFamilyAttemptTimeout: limitMs };
    const request = send(url, options, (response) => {
      const parts: Buffer[] = [];
      response.on("data", (part: Buffer) => { parts.push(part); });
      response.on("end", () => { done(); resolve({ status: response.statusCode ?? 0, text: Buffer.concat(parts).toString("utf8") }); });
      response.on("error", (err) => { done(); reject(err); });
    });
    const timer = setTimeout(() => { request.destroy(new TimedOut()); }, limitMs);
    const stopped = (): void => { request.destroy(new Error("stopped")); };
    function done(): void {
      clearTimeout(timer);
      stop?.removeEventListener("abort", stopped);
    }
    stop?.addEventListener("abort", stopped);
    request.on("error", (err) => { done(); reject(err); });
    request.end(body);
  });
}

// How many times one call is tried. Telegram sometimes doesn't answer a new connection at all: measured on 17 November from
// two networks, one try in six sat silent for its whole limit while the next was answered in under a second. So a silent
// try is given up on quickly and made again. A person not being told matters more than their being told twice.
const TRIES = 3;

async function call(at: TelegramEndpoint, token: string, method: string, body: Record<string, unknown>, limitMs = at.timeoutMs, stop?: AbortSignal, tries = TRIES): Promise<unknown> {
  let url: URL;
  try {
    url = new URL(`${at.apiUrl}/bot${token}/${method}`);
  } catch {
    throw new TelegramError("Telegram couldn't be reached: its address isn't one.");
  }
  let response: { status: number; text: string } | undefined;
  for (let attempt = 1; response === undefined; attempt++) {
    try {
      response = await post(url, JSON.stringify(body), limitMs, stop);
    } catch (err: unknown) {
      if (stop?.aborted) throw new TelegramError("Stopped.");
      if (attempt < tries) continue;
      const times = tries === 1 ? "" : `, in ${tries} tries`;
      if (err instanceof TimedOut) throw new TelegramError(`Telegram didn't answer within ${limitMs / 1000} seconds${times}.`);
      throw new TelegramError(`Telegram couldn't be reached${times}: ${reason(err).replaceAll(token, "<bot token>")}.`);
    }
  }
  let answer: { ok?: boolean; description?: string; error_code?: number; result?: unknown };
  try {
    answer = JSON.parse(response.text) as typeof answer;
  } catch {
    // No number: a page from a proxy or a hotel network isn't Telegram refusing the token.
    throw new TelegramError(`Telegram answered with something unreadable (HTTP ${response.status}).`);
  }
  if (answer === null || typeof answer !== "object") throw new TelegramError(`Telegram answered with something unreadable (HTTP ${response.status}).`);
  if (answer.ok !== true) throw new TelegramError(`Telegram refused: ${answer.description ?? `HTTP ${response.status}`}.`, answer.error_code);
  return answer.result;
}

// The number before the colon in a token is the bot's own id, and it stays the same when the token is replaced.
export const botIdOf = (token: string): string => token.split(":")[0] ?? "";

// The bot's own username, which also proves the token is real.
export async function botUsername(at: TelegramEndpoint, token: string): Promise<string> {
  const me = await call(at, token, "getMe", {}) as { username?: string };
  if (typeof me?.username !== "string") throw new TelegramError("Telegram accepted the token but didn't name a bot.");
  return me.username;
}

export interface TelegramChat { id?: number | string; type?: string; username?: string; first_name?: string; title?: string }
export interface TelegramUpdate {
  update_id: number;
  message?: { message_id?: number; text?: string; chat?: TelegramChat; reply_to_message?: { message_id?: number } };
  // A button was tapped. data is what the button carried, and message is the one the buttons were under.
  callback_query?: { id?: string; data?: string; message?: { message_id?: number; text?: string; chat?: TelegramChat } };
}

// What a button carries back when it's tapped: its place in the list. Telegram allows 64 bytes, so never the words.
const choiceData = (index: number): string => `choice:${index}`;
export function choiceIndex(data: unknown): number | undefined {
  const match = typeof data === "string" ? /^choice:(\d+)$/.exec(data) : null;
  return match ? Number(match[1]) : undefined;
}

// The newest thing sent to the bot, alone. Offset -1 asks for just that: without it Telegram gives the oldest hundred, and
// "last" would be wrong on a bot with a backlog. It also makes Telegram forget everything older.
export async function newestUpdate(at: TelegramEndpoint, token: string): Promise<TelegramUpdate | undefined> {
  // The same kinds the reader asks for: Telegram keeps whatever the last call named, so naming fewer here would switch taps off.
  const updates = await call(at, token, "getUpdates", { offset: -1, timeout: 0, allowed_updates: ["message", "callback_query"] }) as TelegramUpdate[];
  return updates.at(-1);
}

// Everything sent to the bot from this update on, waiting up to pollSeconds for the first. Stopping it ends the wait at once.
export async function updatesFrom(at: TelegramEndpoint, token: string, offset: number, stop: AbortSignal): Promise<TelegramUpdate[]> {
  // One try: the reader calls again by itself, with a growing wait.
  return await call(at, token, "getUpdates", { offset, timeout: at.pollSeconds, allowed_updates: ["message", "callback_query"] }, at.pollSeconds * 1000 + at.timeoutMs, stop, 1) as TelegramUpdate[];
}

// Answers only once Telegram has accepted the message, with the ids Telegram gave: the chat's own number, which is what a
// reply will carry even if the chat was named as @something, and the message's.
// With choices, each becomes a button under the message, one to a row so a long one is never cut short.
export async function sendText(at: TelegramEndpoint, token: string, chatId: string, text: string, choices: readonly string[] = []): Promise<{ chatId: string; messageId: number }> {
  const buttons = choices.length === 0 ? {} : { reply_markup: { inline_keyboard: choices.map((label, index) => [{ text: label, callback_data: choiceData(index) }]) } };
  const sent = await call(at, token, "sendMessage", { chat_id: chatId, text, ...buttons }) as { message_id?: number; chat?: { id?: number | string } };
  if (typeof sent?.message_id !== "number" || sent.chat?.id === undefined) throw new TelegramError("Telegram accepted the message but didn't say where it went.");
  return { chatId: String(sent.chat.id), messageId: sent.message_id };
}

// Stops the tapped button's spinner, with a short line Telegram shows the person.
export async function answerTap(at: TelegramEndpoint, token: string, tapId: string, text: string): Promise<void> {
  await call(at, token, "answerCallbackQuery", { callback_query_id: tapId, text });
}

// Takes the buttons off a message, so a choice that's been made can't be made again. The words are left alone: rewriting
// them can fail on a long message, and Telegram doesn't always give an old message's text back.
export async function clearButtons(at: TelegramEndpoint, token: string, chatId: string, messageId: number): Promise<void> {
  await call(at, token, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
}
