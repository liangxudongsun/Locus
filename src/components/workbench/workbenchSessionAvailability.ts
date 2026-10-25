import type { SessionSummary } from "../../types";
import { listProjectSessions } from "../../services/session";

/** The session behind a workbench tab, or null once it is archived or deleted. */
export async function resolveWorkbenchSession(
  projectId: string,
  sessionId: string,
  cachedSessions: readonly SessionSummary[] = [],
): Promise<SessionSummary | null> {
  const cached = cachedSessions.find((session) => session.id === sessionId);
  if (cached) return cached;

  // A newly created session can reach its editor before the explorer catalog
  // refreshes. Only an authoritative miss may replace the live chat surface.
  // Let lookup failures preserve the editor through the reconciliation catch.
  const sessions = await listProjectSessions(projectId);
  return sessions.find((session) => session.id === sessionId) ?? null;
}
