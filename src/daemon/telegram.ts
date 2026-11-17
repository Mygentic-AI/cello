// Telegram's Bot API: the calls a notifier needs. Every call has a time limit, and a refusal carries Telegram's own words.
// The bot token is part of the address, so nothing here ever puts an address in an error.
// Where Telegram is, how long one call may take, and how long a wait for new messages is held open. Only a test changes these.
export interface TelegramEndpoint { apiUrl: string; timeoutMs: number; pollSeconds: number }
export const TELEGRAM: TelegramEndpoint = { apiUrl: "https://api.telegram.org", timeoutMs: 15_000, pollSeconds: 25 };

export class TelegramError extends Error {
  // Telegram's own error number, when it gave one: 401 is a token it doesn't know, 409 is another reader on the same bot.
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

async function call(at: TelegramEndpoint, token: string, method: string, body: Record<string, unknown>, limitMs = at.timeoutMs, stop?: AbortSignal): Promise<unknown> {
  let response: Response | undefined;
  // A dropped connection is tried once more, because a person not being told matters more than their being told twice.
  // A timeout isn't: the limit is the promise.
  for (let attempt = 1; response === undefined; attempt++) {
    try {
      response = await fetch(`${at.apiUrl}/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: stop ? AbortSignal.any([AbortSignal.timeout(limitMs), stop]) : AbortSignal.timeout(limitMs),
      });
    } catch (err: unknown) {
      if (stop?.aborted) throw new TelegramError("Stopped.");
      if (err instanceof Error && err.name === "TimeoutError") throw new TelegramError(`Telegram didn't answer within ${limitMs / 1000} seconds.`);
      if (attempt < 2) continue;
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : err instanceof Error ? err.message : String(err);
      throw new TelegramError(`Telegram couldn't be reached, twice: ${cause.replaceAll(token, "<bot token>")}.`);
    }
  }
  let answer: { ok?: boolean; description?: string; error_code?: number; result?: unknown };
  try {
    answer = await response.json() as typeof answer;
  } catch {
    // No number: a page from a proxy or a hotel network isn't Telegram refusing the token.
    throw new TelegramError(`Telegram answered with something unreadable (HTTP ${response.status}).`);
  }
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
}

// The newest thing sent to the bot, alone. Offset -1 asks for just that: without it Telegram gives the oldest hundred, and
// "last" would be wrong on a bot with a backlog. It also makes Telegram forget everything older.
export async function newestUpdate(at: TelegramEndpoint, token: string): Promise<TelegramUpdate | undefined> {
  const updates = await call(at, token, "getUpdates", { offset: -1, timeout: 0, allowed_updates: ["message"] }) as TelegramUpdate[];
  return updates.at(-1);
}

// Everything sent to the bot from this update on, waiting up to pollSeconds for the first. Stopping it ends the wait at once.
export async function updatesFrom(at: TelegramEndpoint, token: string, offset: number, stop: AbortSignal): Promise<TelegramUpdate[]> {
  return await call(at, token, "getUpdates", { offset, timeout: at.pollSeconds, allowed_updates: ["message"] }, at.pollSeconds * 1000 + at.timeoutMs, stop) as TelegramUpdate[];
}

// Answers only once Telegram has accepted the message, with the ids Telegram gave: the chat's own number, which is what a
// reply will carry even if the chat was named as @something, and the message's.
export async function sendText(at: TelegramEndpoint, token: string, chatId: string, text: string): Promise<{ chatId: string; messageId: number }> {
  const sent = await call(at, token, "sendMessage", { chat_id: chatId, text }) as { message_id?: number; chat?: { id?: number | string } };
  if (typeof sent?.message_id !== "number" || sent.chat?.id === undefined) throw new TelegramError("Telegram accepted the message but didn't say where it went.");
  return { chatId: String(sent.chat.id), messageId: sent.message_id };
}
