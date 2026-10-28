import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  AgentMessage,
  BranchSummaryMessage,
  CompactionSummaryMessage,
  CustomMessage,
  TranscriptItem,
} from "../shared/protocol.ts";

const millis = (iso: string): number => Date.parse(iso);

/** Entries on the active branch -> protocol transcript. */
export function buildTranscript(branch: SessionEntry[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const entry of branch) {
    switch (entry.type) {
      case "message":
        if (entry.message.role === "system") break;
        items.push({ entryId: entry.id, message: entry.message as unknown as AgentMessage });
        break;
      case "custom_message": {
        if (!entry.display) break;
        const message: CustomMessage = {
          role: "custom",
          customType: entry.customType,
          content: entry.content,
          display: true,
          timestamp: millis(entry.timestamp),
        };
        items.push({ entryId: entry.id, message });
        break;
      }
      case "compaction": {
        const message: CompactionSummaryMessage = {
          role: "compactionSummary",
          summary: entry.summary,
          tokensBefore: entry.tokensBefore,
          timestamp: millis(entry.timestamp),
        };
        items.push({ entryId: entry.id, message });
        break;
      }
      case "branch_summary": {
        const message: BranchSummaryMessage = {
          role: "branchSummary",
          summary: entry.summary,
          fromId: entry.fromId ?? null,
          timestamp: millis(entry.timestamp),
        };
        items.push({ entryId: entry.id, message });
        break;
      }
      default:
        break;
    }
  }
  return items;
}
