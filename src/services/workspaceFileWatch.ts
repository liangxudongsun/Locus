import { ipcInvoke } from "./ipc";
import { flushWindowEventInterests, retainWindowEventInterest } from "./windowEventInterests";
import type { WorkspaceRef } from "./project";

export async function startWorkspaceFileWatch(workspaceRef: WorkspaceRef): Promise<() => Promise<void>> {
  const releaseInterest = retainWindowEventInterest({ workspaceRef });
  let token: string | null;
  try {
    await flushWindowEventInterests();
    token = await ipcInvoke<string | null>("workspace_file_watch_start", { workspaceRef });
  } catch (error) {
    releaseInterest();
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    releaseInterest();
    if (token) await ipcInvoke("workspace_file_watch_stop", { token });
  };
}
