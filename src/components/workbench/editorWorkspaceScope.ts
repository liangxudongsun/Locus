import { workspaceMaterializationMatches, type WorkspaceRef, type WorkspaceRuntimeDescriptor } from "../../services/project";
import type { SessionSummary } from "../../types";
import type { EditorCheckoutBinding } from "../../types/workbench";

/** Refresh a process incarnation only after the durable assignment matches.
 * Never replace a persisted epoch with the currently occupying pool slot. */
export function workspaceRefForEditorBinding(binding: EditorCheckoutBinding | null | undefined, runtime?: WorkspaceRuntimeDescriptor | null): WorkspaceRef | null {
  if (!binding?.checkoutId) return null;
  const sameAssignment = runtime?.checkoutId === binding.checkoutId
    && workspaceMaterializationMatches(binding.expectedMaterializationEpoch, runtime.materializationEpoch);
  return {
    checkoutId: binding.checkoutId,
    expectedGeneration: sameAssignment ? runtime.workspaceGeneration : binding.expectedGeneration ?? undefined,
    expectedMaterializationEpoch: binding.expectedMaterializationEpoch ?? undefined,
  };
}

/** A session tab follows the session's durable checkout assignment, never
 * the runtime: the backend may rebind a session to the same directory (an
 * imported checkout), while a recycled pool slot leaves it on the old epoch. */
export function sessionEditorBinding(
  binding: EditorCheckoutBinding | null | undefined,
  session: Pick<SessionSummary, "defaultCheckoutId" | "defaultMaterializationEpoch"> | null | undefined,
): EditorCheckoutBinding | null {
  if (!binding) return null;
  const epoch = session?.defaultCheckoutId === binding.checkoutId ? session.defaultMaterializationEpoch : null;
  return typeof epoch === "number" && epoch !== binding.expectedMaterializationEpoch
    ? { ...binding, expectedMaterializationEpoch: epoch }
    : binding;
}

export function editorBindingMatchesRuntime(binding: EditorCheckoutBinding | null | undefined, runtime?: WorkspaceRuntimeDescriptor | null): boolean {
  return !!binding?.checkoutId && !!runtime && binding.checkoutId === runtime.checkoutId
    && workspaceMaterializationMatches(binding.expectedMaterializationEpoch, runtime.materializationEpoch);
}
