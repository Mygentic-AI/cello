// Between the daemon and its local clients: one JSON object per line, on a Unix socket only the owner can open.
export interface IpcRequest { id: number; method: string; params?: Record<string, unknown> }
export type IpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string } };
export interface IpcNotification { notification: string; data: Record<string, unknown> }
