import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../types";
import { listProjectSessions } from "../services/session";
import { resolveWorkbenchSession } from "../components/workbench/workbenchSessionAvailability";

vi.mock("../services/session", () => ({ listProjectSessions: vi.fn() }));

const session: SessionSummary = {
  id: "created-session",
  projectId: "project-a",
  title: "hello",
  sessionType: "chat",
  updatedAt: 1,
};

describe("workbench session availability", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps a newly created session available while its explorer catalog is stale", async () => {
    let finishLookup!: (sessions: SessionSummary[]) => void;
    vi.mocked(listProjectSessions).mockReturnValue(new Promise((resolve) => {
      finishLookup = resolve;
    }));
    const settled = vi.fn();
    const result = resolveWorkbenchSession("project-a", session.id, [])
      .then(settled);

    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    finishLookup([session]);
    await result;
    expect(settled).toHaveBeenCalledExactlyOnceWith(session);
    expect(listProjectSessions).toHaveBeenCalledExactlyOnceWith("project-a");
  });

  it("confirms archived or deleted sessions are unavailable", async () => {
    vi.mocked(listProjectSessions).mockResolvedValue([session]);
    await expect(resolveWorkbenchSession("project-a", "removed-session", []))
      .resolves.toBeNull();
  });

  it("does not interpret a failed lookup as a missing session", async () => {
    const error = new Error("catalog unavailable");
    vi.mocked(listProjectSessions).mockRejectedValue(error);
    await expect(resolveWorkbenchSession("project-a", session.id))
      .rejects.toBe(error);
  });

  it("uses catalog hits without another backend request", async () => {
    await expect(resolveWorkbenchSession("project-a", session.id, [session]))
      .resolves.toBe(session);
    expect(listProjectSessions).not.toHaveBeenCalled();
  });
});
