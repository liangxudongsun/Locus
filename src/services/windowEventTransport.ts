import { listen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentTauriWindowLabel } from "./tauriRuntime";

export function windowEventName(event: string, windowLabel: string): string {
  return `${event}/${windowLabel}`;
}

/** Tauri's global listeners also receive emit_to, so targeted payloads use a
 * distinct channel that only their owning renderer subscribes to. */
export async function listenWindowEvent<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  const releaseGlobal = await listen<T>(event, handler);
  const label = getCurrentTauriWindowLabel();
  if (!label) return releaseGlobal;
  try {
    const releaseWindow = await listen<T>(windowEventName(event, label), handler);
    return () => { releaseGlobal(); releaseWindow(); };
  } catch (error) {
    releaseGlobal();
    throw error;
  }
}
