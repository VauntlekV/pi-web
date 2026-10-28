/** Shape of demo-data.json, written by demo/record.ts and replayed by ./mock.ts. */
import type { ServerEvent, SessionState } from "../../../shared/protocol.ts";

export interface DemoResponse {
  status: number;
  body: unknown;
}

export interface DemoData {
  /** the recorded session (one finished turn) */
  sessionId: string;
  cwd: string;
  /** the prompt of the recorded turn */
  prompt: string;
  /** state of a freshly created session, the template for new ones */
  created: SessionState;
  /** the turn's SSE events, `at` ms after the prompt */
  turn: { at: number; event: ServerEvent }[];
  /** "GET /api/..." -> recorded response */
  responses: Record<string, DemoResponse>;
}
