import { ApiRequestError } from "../api/client.ts";

/** Message for a toast; the server's `error` body when there is one. */
export function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "请求失败";
}

export function isStatus(error: unknown, status: number): boolean {
  return error instanceof ApiRequestError && error.status === status;
}
