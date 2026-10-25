import { ipcInvoke } from "./ipc";
import type { TextDelta } from "../document/textDelta";

export interface DocumentSnapshot { text: string; at: number }
export interface DocumentRecovery {
  schemaVersion: 2;
  /** Hash of the latest history version; drafts are stored relative to it. */
  head: string | null;
  draft: DocumentSnapshot | null;
  snapshots: DocumentSnapshot[];
}
/** Full text, or a single-span delta against the version hashed as `base`. */
export interface RecoveryVersion {
  hash: string;
  base?: string;
  delta?: TextDelta;
  text?: string;
  checkpoint?: boolean;
}
export interface RecoveryUpdate {
  key: string;
  head?: RecoveryVersion;
  /** Omitted keeps the stored draft; null clears it. */
  draft?: RecoveryVersion | null;
}
export interface RecoveryUpdateResult { head: string | null; headAccepted: boolean; draftAccepted: boolean }

export function readDocumentRecovery(key: string, includeHistory = false): Promise<DocumentRecovery> {
  return ipcInvoke("markdown_recovery_read", { key, includeHistory });
}
export function updateDocumentRecovery(request: RecoveryUpdate): Promise<RecoveryUpdateResult> {
  return ipcInvoke("markdown_recovery_update", { request });
}
