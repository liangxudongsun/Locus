// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isRenderDelayedFrame,
  isRuntimePerformanceDiagnosticsRunning,
  snapshotLongAnimationFrame,
  startRuntimePerformanceDiagnostics,
  stopRuntimePerformanceDiagnostics,
  type RuntimePerformanceIncident,
} from "../services/runtimePerformanceDiagnostics";

class MockPerformanceObserver {
  static supportedEntryTypes = ["long-animation-frame"];
  static instances: MockPerformanceObserver[] = [];

  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(private readonly callback: PerformanceObserverCallback) {
    MockPerformanceObserver.instances.push(this);
  }

  emit(entries: PerformanceEntry[]) {
    this.callback({ getEntries: () => entries } as PerformanceObserverEntryList, this as unknown as PerformanceObserver);
  }
}

afterEach(() => {
  stopRuntimePerformanceDiagnostics();
  MockPerformanceObserver.instances = [];
  MockPerformanceObserver.supportedEntryTypes = ["long-animation-frame"];
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runtime performance diagnostics", () => {
  it("does not install runtime work merely by loading the module", () => {
    vi.useFakeTimers();

    expect(isRuntimePerformanceDiagnosticsRunning()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("extracts bounded long-frame attribution without URL query data", () => {
    const snapshot = snapshotLongAnimationFrame({
      name: "long-animation-frame",
      entryType: "long-animation-frame",
      startTime: 100,
      duration: 600,
      blockingDuration: 470,
      renderStart: 620,
      styleAndLayoutStart: 660,
      firstUIEventTimestamp: 105,
      scripts: [{
        duration: 520,
        executionStart: 110,
        forcedStyleAndLayoutDuration: 45,
        pauseDuration: 0,
        invoker: "DOMWindow.onclick",
        invokerType: "event-listener",
        sourceURL: "http://localhost:14901/src/App.vue?cache=secret#fragment",
        sourceFunctionName: "handleClick",
        sourceCharPosition: 42,
      }],
      toJSON: () => ({}),
    });

    expect(snapshot).toMatchObject({
      startTimeMs: 100,
      durationMs: 600,
      blockingDurationMs: 470,
      renderStartDelayMs: 520,
      renderDurationMs: 80,
      styleAndLayoutDurationMs: 40,
      scriptDurationMs: 520,
      firstUiEventTimestampMs: 105,
    });
    expect(isRenderDelayedFrame(snapshot)).toBe(false);
    expect(snapshot.scripts[0]).toMatchObject({
      durationMs: 520,
      forcedStyleAndLayoutDurationMs: 45,
      invoker: "DOMWindow.onclick",
      sourceUrl: "http://localhost:14901/src/App.vue",
      sourceFunctionName: "handleClick",
      sourceCharPosition: 42,
    });
  });

  it("reports long frames only after diagnostics explicitly start", () => {
    vi.useFakeTimers();
    vi.stubGlobal("PerformanceObserver", MockPerformanceObserver);
    vi.spyOn(console, "info").mockImplementation(() => {});
    const incidents: RuntimePerformanceIncident[] = [];

    startRuntimePerformanceDiagnostics({
      now: () => 1_000,
      warmupMs: 0,
      coalesceDelayMs: 0,
      reportIncident: (incident) => incidents.push(incident),
      getContext: () => ({ pendingInvokes: [{ command: "slow_command", ageMs: 800 }] }),
    });

    expect(isRuntimePerformanceDiagnosticsRunning()).toBe(true);
    expect(MockPerformanceObserver.instances).toHaveLength(1);
    expect(MockPerformanceObserver.instances[0]?.observe).toHaveBeenCalledWith({
      type: "long-animation-frame",
    });

    MockPerformanceObserver.instances[0]?.emit([{
      name: "long-animation-frame",
      entryType: "long-animation-frame",
      startTime: 400,
      duration: 500,
      blockingDuration: 420,
      scripts: [],
      toJSON: () => ({}),
    } as PerformanceEntry]);
    vi.advanceTimersByTime(0);

    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      kind: "main-thread",
      durationMs: 500,
      triggers: ["long-animation-frame"],
      context: {
        pendingInvokes: [{ command: "slow_command", ageMs: 800 }],
      },
    });
  });

  it("reports an idle wait before rendering as a render delay, not a stall", () => {
    vi.useFakeTimers();
    vi.stubGlobal("PerformanceObserver", MockPerformanceObserver);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getContext = vi.fn(() => ({}));

    startRuntimePerformanceDiagnostics({ now: () => 1_000, warmupMs: 0, coalesceDelayMs: 0, getContext });
    info.mockClear();

    MockPerformanceObserver.instances[0]?.emit([{
      name: "long-animation-frame",
      entryType: "long-animation-frame",
      startTime: 400,
      duration: 330,
      blockingDuration: 0,
      renderStart: 729,
      styleAndLayoutStart: 729.5,
      scripts: [],
      toJSON: () => ({}),
    } as PerformanceEntry]);
    vi.advanceTimersByTime(0);

    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledOnce();
    const [module, message, summary, incident] = info.mock.calls[0] as [string, string, string, RuntimePerformanceIncident];
    expect(module).toBe("[RuntimePerformance]");
    expect(message).toBe("render delay detected");
    expect(summary).toContain("render-delay 330ms");
    expect(summary).toContain("renderStartDelay=329ms");
    expect(incident).toMatchObject({
      kind: "render-delay",
      longAnimationFrame: { renderStartDelayMs: 329, scriptDurationMs: 0 },
    });
    expect(typeof incident.hasFocus).toBe("boolean");
    expect(getContext).toHaveBeenCalledWith({
      approximateStartedAtMs: incident.approximateStartedAtMs,
      detectedAtMs: incident.detectedAtMs,
    });
  });

  it("keeps a merged incident on the main thread when any frame did script work", () => {
    vi.useFakeTimers();
    vi.stubGlobal("PerformanceObserver", MockPerformanceObserver);
    vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    startRuntimePerformanceDiagnostics({ now: () => 2_000, warmupMs: 0, coalesceDelayMs: 0 });

    MockPerformanceObserver.instances[0]?.emit([
      {
        name: "long-animation-frame",
        entryType: "long-animation-frame",
        startTime: 100,
        duration: 400,
        blockingDuration: 0,
        renderStart: 499,
        scripts: [],
        toJSON: () => ({}),
      },
      {
        name: "long-animation-frame",
        entryType: "long-animation-frame",
        startTime: 520,
        duration: 300,
        blockingDuration: 230,
        renderStart: 815,
        scripts: [{ duration: 280, invoker: "BUTTON.onclick", invokerType: "event-listener" }],
        toJSON: () => ({}),
      },
    ] as unknown as PerformanceEntry[]);
    vi.advanceTimersByTime(0);

    expect(warn).toHaveBeenCalledOnce();
    const [, message, summary, incident] = warn.mock.calls[0] as [string, string, string, RuntimePerformanceIncident];
    expect(message).toBe("stall detected");
    expect(incident.kind).toBe("main-thread");
    expect(incident.durationMs).toBe(720);
    expect(summary).toContain("main-thread 720ms");
  });

  it("reports a two-second burst of medium long frames as one jank incident", () => {
    vi.useFakeTimers();
    vi.stubGlobal("PerformanceObserver", MockPerformanceObserver);
    vi.spyOn(console, "info").mockImplementation(() => {});
    const incidents: RuntimePerformanceIncident[] = [];

    startRuntimePerformanceDiagnostics({
      now: () => 2_500,
      warmupMs: 0,
      coalesceDelayMs: 0,
      reportIncident: (incident) => incidents.push(incident),
    });

    MockPerformanceObserver.instances[0]?.emit(
      [100, 400, 700, 1_000, 1_300].map((startTime) => ({
        name: "long-animation-frame",
        entryType: "long-animation-frame",
        startTime,
        duration: 100,
        blockingDuration: 20,
        scripts: [],
        toJSON: () => ({}),
      } as PerformanceEntry)),
    );
    vi.advanceTimersByTime(0);

    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      kind: "main-thread",
      durationMs: 1_300,
      triggers: ["jank-burst"],
      jankBurst: {
        renderDelayedFrameCount: 0,
        windowStartTimeMs: 100,
        windowEndTimeMs: 1_400,
        windowDurationMs: 1_300,
        frameCount: 5,
        totalFrameDurationMs: 500,
        totalBlockingDurationMs: 100,
        maxFrameDurationMs: 100,
      },
    });
    expect(incidents[0]?.jankBurst?.frames).toHaveLength(5);
  });

  it("keeps isolated medium frames below the burst threshold", () => {
    vi.useFakeTimers();
    vi.stubGlobal("PerformanceObserver", MockPerformanceObserver);
    vi.spyOn(console, "info").mockImplementation(() => {});
    const incidents: RuntimePerformanceIncident[] = [];

    startRuntimePerformanceDiagnostics({
      now: () => 4_000,
      warmupMs: 0,
      coalesceDelayMs: 0,
      reportIncident: (incident) => incidents.push(incident),
    });

    MockPerformanceObserver.instances[0]?.emit(
      [100, 700, 1_300, 3_500].map((startTime) => ({
        name: "long-animation-frame",
        entryType: "long-animation-frame",
        startTime,
        duration: 100,
        blockingDuration: 0,
        scripts: [],
        toJSON: () => ({}),
      } as PerformanceEntry)),
    );
    vi.advanceTimersByTime(0);

    expect(incidents).toHaveLength(0);
  });

  it("detects event-loop stalls with the foreground watchdog", () => {
    vi.useFakeTimers();
    MockPerformanceObserver.supportedEntryTypes = [];
    vi.stubGlobal("PerformanceObserver", MockPerformanceObserver);
    vi.spyOn(console, "info").mockImplementation(() => {});
    let clockMs = 0;
    const incidents: RuntimePerformanceIncident[] = [];

    startRuntimePerformanceDiagnostics({
      now: () => clockMs,
      warmupMs: 0,
      watchdogIntervalMs: 100,
      stallThresholdMs: 200,
      coalesceDelayMs: 0,
      reportIncident: (incident) => incidents.push(incident),
    });

    clockMs = 700;
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(1);

    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      durationMs: 600,
      triggers: ["watchdog"],
      watchdogDriftMs: 600,
    });
  });

  it("removes observers, timers, and interaction listeners when stopped", () => {
    vi.useFakeTimers();
    vi.stubGlobal("PerformanceObserver", MockPerformanceObserver);
    vi.spyOn(console, "info").mockImplementation(() => {});

    startRuntimePerformanceDiagnostics({ warmupMs: 0 });
    const observer = MockPerformanceObserver.instances[0];
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    stopRuntimePerformanceDiagnostics();

    expect(isRuntimePerformanceDiagnosticsRunning()).toBe(false);
    expect(observer?.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
