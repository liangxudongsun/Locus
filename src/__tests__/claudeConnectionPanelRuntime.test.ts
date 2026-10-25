// @vitest-environment jsdom
import { createPinia } from 'pinia';
import { createApp, h, nextTick, ref, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeSessionConnection, ClaudeTransportSnapshot } from '../services/claudeConnection';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), status: vi.fn(), connect: vi.fn() }));
vi.mock('../services/ipc', () => ({ ipcInvoke: mocks.invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('../services/claudeConnection', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/claudeConnection')>(),
  getClaudeSessionConnection: mocks.status,
  connectClaudeSession: mocks.connect,
  isRemoteClaudeCode: ref(true),
  claudePrewarmSettings: ref({ enabled: true, capacity: 2, idleMinutes: 15, scope: 'ssh-a' }),
}));
vi.mock('../services/claudeCodeCli', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/claudeCodeCli')>(),
  claudeCodeCliEnabled: ref(true),
}));
vi.mock('../composables/useClaudePrewarm', () => ({ useClaudePrewarm: () => {} }));
vi.mock('../services/locusRuntime', () => ({ getLocusRuntime: () => ({
  invoke: mocks.invoke, subscribe: async () => () => {},
}) }));

import ChatStatusIndicators from '../components/chat/ChatStatusIndicators.vue';
import { t } from '../i18n';

let app: App | undefined;
let host: HTMLDivElement;
const cause = 'Claude plugin validation failed.\nregister.js:116: invalid helper <script>bad</script>';
const failed: ClaudeSessionConnection = { phase: 'disconnected', target: 'user@server', port: null,
  latencyMs: null, lastError: cause,
  pool: { state: 'retrying', capacity: 2, ready: 0, starting: 0, active: 0, retained: 0 } };
async function flush() { for (let i = 0; i < 25; i++) await nextTick(); }
function icon() { return [...host.querySelectorAll<HTMLButtonElement>('button')]
  .find(button => button.getAttribute('aria-label')?.startsWith(`${t('model.provider.claude_code.remote')}:`))!; }
async function mount() {
  app = createApp(() => h(ChatStatusIndicators, { workspaceRef: { checkoutId: 'test', expectedGeneration: 1, expectedMaterializationEpoch: 0 },
    projectServices: [], selectedModelId: 'claude_code/opus' }));
  app.use(createPinia()); app.mount(host); await flush();
  await vi.advanceTimersByTimeAsync(1);
  icon().click(); await flush();
}
beforeEach(() => {
  vi.useFakeTimers();
  mocks.invoke.mockReset().mockImplementation(async (command: string) => command === 'mcp_get_status' || command === 'list_models' ? [] : null);
  mocks.status.mockReset().mockResolvedValue(failed);
  mocks.connect.mockReset().mockResolvedValue(undefined);
  host = document.createElement('div'); document.body.appendChild(host);
});
afterEach(() => { app?.unmount(); app = undefined; host.remove(); vi.useRealTimers(); });

describe('Claude connection error panel', () => {
  it('displays background errors without a manual connection and clears them after recovery', async () => {
    await mount();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(icon().classList.contains('tone-danger')).toBe(true);
    expect(host.querySelector('.chat-status-popover-summary')?.textContent).toBe(t('chat.status.claude.failed'));
    expect(host.querySelector('[role="alert"]')?.textContent?.trim()).toBe(cause);
    expect(host.querySelector('script')).toBeNull();
    expect(host.textContent).toContain(t('chat.status.claude.pool.retrying'));
    mocks.status.mockResolvedValue({ ...failed, phase: 'starting' });
    await vi.advanceTimersByTimeAsync(1000); await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('register.js:116');
    mocks.status.mockResolvedValue({ ...failed, phase: 'ready', lastError: null, pool: { ...failed.pool, state: 'ready', ready: 2 } });
    await vi.advanceTimersByTimeAsync(1000); await flush();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(icon().classList.contains('tone-success')).toBe(true);
  });

  it('shows passive progress and retains failure evidence without running checks from the panel', async () => {
    const trace: ClaudeTransportSnapshot = {
      id: 7, pid: 123, operation: 'history', stage: 'historyTransfer', elapsedMs: 45000, stageElapsedMs: 40000,
      receivedBytes: 262144, sentBytes: 128, lastReceiveAgeMs: 500, partialFrameBytes: 262144,
      expectedFrameBytes: 1048576, stageReceivedBytes: 262144, stageBytesPerSecond: 6553.6,
      heartbeatAgeMs: null, pendingHeartbeats: 4,
      timeline: [{ stage: 'ssh', elapsedMs: 0 }, { stage: 'historyTransfer', elapsedMs: 5000 }],
    };
    const diagnostics = {
      active: trace,
      lastFailure: { at: 1700000000000, kind: 'historyTransferTimeout', message: '45s expired',
        stderr: 'SSH <script>not executable</script>', exitCode: null, transport: trace },
      probe: { failureId: 6, at: 1700000000000, state: 'complete', checks: [
        { name: 'sshBanner', outcome: 'ok', elapsedMs: 600, detail: 'SSH-2.0-test; no authentication attempted' },
      ] },
    };
    mocks.status.mockResolvedValue({ ...failed, diagnostics });
    await mount();
    expect(host.textContent).toContain(t('chat.status.claude.diagnostics.waitingHeartbeat'));
    const details = host.querySelector<HTMLDetailsElement>('details.chat-status-diagnostics')!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    details.open = true;
    expect(details.textContent).toContain('256.0 KiB / 1.00 MiB');
    expect(details.textContent).toContain('historyTransferTimeout');
    expect(details.textContent).toContain('sshBanner: ok');
    expect(details.textContent).toContain('#6'); // probe belongs to an earlier failure, not active #7
    expect(host.querySelector('script')).toBeNull();
    expect(mocks.connect).not.toHaveBeenCalled();
    mocks.status.mockResolvedValue({ ...failed, phase: 'ready', lastError: null, diagnostics: {
      ...diagnostics, active: { ...trace, id: 8, operation: 'session', stage: 'ready', heartbeatAgeMs: 200 },
    } });
    await vi.advanceTimersByTimeAsync(1000); await flush();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(icon().classList.contains('tone-success')).toBe(true);
    expect(host.textContent).toContain(t('chat.status.claude.diagnostics.lastFailure'));
    expect(host.textContent).toContain('historyTransferTimeout');
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('preserves manual failures when a later disconnected snapshot arrives', async () => {
    mocks.status.mockResolvedValue(null);
    mocks.connect.mockRejectedValue(new Error('SSH permission denied'));
    await mount();
    await vi.advanceTimersByTimeAsync(1);
    host.querySelector<HTMLButtonElement>('.chat-status-action')!.click(); await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('SSH permission denied');
    mocks.status.mockResolvedValue({ ...failed, lastError: null });
    await vi.advanceTimersByTimeAsync(1000); await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('SSH permission denied');
  });
});
