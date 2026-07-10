import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { SandboxConfig } from '@/persistence';

const {
    mockExecSync,
    mockInitializeSandbox,
    mockWrapForMcpTransport,
    mockSandboxCleanup,
    mockSpawn,
    mockSignalPosixDescendants,
    mockSignalProcessIds,
    mockWaitForProcessIdsToExit,
} = vi.hoisted(() => ({
    mockExecSync: vi.fn(),
    mockInitializeSandbox: vi.fn(),
    mockWrapForMcpTransport: vi.fn(),
    mockSandboxCleanup: vi.fn(),
    mockSpawn: vi.fn(),
    mockSignalPosixDescendants: vi.fn(),
    mockSignalProcessIds: vi.fn(),
    mockWaitForProcessIdsToExit: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    execSync: mockExecSync,
    spawn: mockSpawn,
}));

vi.mock('cross-spawn', () => ({
    spawn: mockSpawn,
}));

vi.mock('@/sandbox/manager', () => ({
    initializeSandbox: mockInitializeSandbox,
    wrapForMcpTransport: mockWrapForMcpTransport,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('@/utils/processTree', () => ({
    signalPosixProcessDescendants: mockSignalPosixDescendants,
    signalProcessIds: mockSignalProcessIds,
    waitForProcessIdsToExit: mockWaitForProcessIdsToExit,
}));

vi.mock('../package.json', () => ({
    default: { version: '0.0.1-test' },
}));

type MockRpcMessage = {
    id?: number | string;
    method?: string;
    params?: any;
    result?: any;
};

function pushJsonLine(stdout: NodeJS.ReadableStream & { push: (chunk: string) => void }, payload: unknown) {
    stdout.push(JSON.stringify(payload) + '\n');
}

// Mock child process with stdin/stdout/stderr
function createMockProcess(opts?: {
    pid?: number;
    initializeDelayMs?: number;
    onRequest?: (msg: MockRpcMessage, stdout: NodeJS.ReadableStream & { push: (chunk: string) => void }) => void;
}) {
    const { Readable, Writable } = require('stream');
    const initializeDelayMs = opts?.initializeDelayMs ?? 5;
    const stdin = new Writable({ write: (_: any, __: any, cb: () => void) => cb() });
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const proc = Object.assign(new (require('events').EventEmitter)(), {
        stdin,
        stdout,
        stderr,
        pid: opts?.pid ?? 12345,
        kill: vi.fn(),
    });
    // Send initialize response immediately when stdin is written to
    const origWrite = stdin.write.bind(stdin);
    stdin.write = (data: any, ...args: any[]) => {
        try {
            const msg = JSON.parse(typeof data === 'string' ? data : data.toString());
            if (msg.method === 'initialize' && msg.id != null) {
                // Send response on next tick
                setTimeout(() => {
                    pushJsonLine(stdout, { id: msg.id, result: { userAgent: 'test' } });
                }, initializeDelayMs);
            }
            opts?.onRequest?.(msg, stdout);
        } catch {}
        return origWrite(data, ...args);
    };
    return proc;
}

async function waitFor(predicate: () => boolean, timeoutMs: number = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error(`Timed out after ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

const sandboxConfig: SandboxConfig = {
    enabled: true,
    workspaceRoot: '~/projects',
    sessionIsolation: 'workspace',
    customWritePaths: [],
    denyReadPaths: ['~/.ssh'],
    extraWritePaths: ['/tmp'],
    denyWritePaths: ['.env'],
    networkMode: 'allowed',
    allowedDomains: [],
    deniedDomains: [],
    allowLocalBinding: true,
};

describe('CodexAppServerClient sandbox integration', () => {
    const originalRustLog = process.env.RUST_LOG;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.RUST_LOG = originalRustLog;
        mockExecSync.mockReturnValue('codex-cli 0.107.0');
        mockInitializeSandbox.mockResolvedValue(mockSandboxCleanup);
        mockWrapForMcpTransport.mockResolvedValue({ command: 'sh', args: ['-c', 'wrapped codex app-server'] });
        mockSpawn.mockImplementation(() => createMockProcess());
        mockSignalPosixDescendants.mockReturnValue([]);
        mockWaitForProcessIdsToExit.mockResolvedValue([]);
    });

    afterAll(() => {
        process.env.RUST_LOG = originalRustLog;
    });

    it('wraps transport when sandbox is enabled', async () => {
        // Dynamic import to ensure mocks are applied
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(mockInitializeSandbox).toHaveBeenCalledWith(sandboxConfig, process.cwd());
        expect(mockWrapForMcpTransport).toHaveBeenCalledWith('codex', ['app-server', '--listen', 'stdio://']);
        expect(mockSpawn).toHaveBeenCalledWith(
            'sh',
            ['-c', 'exec wrapped codex app-server'],
            expect.objectContaining({
                env: expect.objectContaining({
                    CODEX_SANDBOX: 'seatbelt',
                    RUST_LOG: expect.stringContaining('codex_core::rollout::list=off'),
                }),
            }),
        );
        expect(client.sandboxEnabled).toBe(true);

        await client.disconnect();
    });

    it('falls back to non-sandbox transport when sandbox initialization fails', async () => {
        mockInitializeSandbox.mockRejectedValue(new Error('sandbox init failed'));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(mockWrapForMcpTransport).not.toHaveBeenCalled();
        expect(mockSpawn).toHaveBeenCalledWith(
            'codex',
            ['app-server', '--listen', 'stdio://'],
            expect.objectContaining({
                env: expect.objectContaining({
                    RUST_LOG: expect.stringContaining('codex_core::rollout::list=off'),
                }),
            }),
        );
        expect(client.sandboxEnabled).toBe(false);

        await client.disconnect();
    });

    it('resets sandbox on disconnect', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();
        await client.disconnect();

        expect(mockSandboxCleanup).toHaveBeenCalledTimes(1);
        expect(client.sandboxEnabled).toBe(false);
    });

    it('waits for the app-server process to exit during ownership handoff', async () => {
        const proc = createMockProcess({ pid: 1401 });
        proc.kill.mockImplementation((signal: string) => {
            if (signal === 'SIGTERM') {
                setTimeout(() => proc.emit('exit', 0, null), 10);
            }
            return true;
        });
        mockSpawn.mockImplementationOnce(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();

        let settled = false;
        const disconnect = client.disconnectAndWait(100).then(() => {
            settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 1));
        expect(settled).toBe(false);
        await disconnect;
        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('force-kills an app-server that does not stop within the handoff timeout', async () => {
        const proc = createMockProcess({ pid: 1402 });
        proc.kill.mockImplementation((signal: string) => {
            if (signal === 'SIGKILL') {
                setTimeout(() => proc.emit('exit', null, 'SIGKILL'), 0);
            }
            return true;
        });
        mockSpawn.mockImplementationOnce(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        await client.disconnectAndWait(1);

        expect(proc.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
        expect(proc.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
        expect(mockSignalPosixDescendants).toHaveBeenNthCalledWith(1, 1402, 'SIGTERM');
        expect(mockSignalPosixDescendants).toHaveBeenNthCalledWith(2, 1402, 'SIGKILL');
    });

    it('shares one in-flight process reaper across concurrent handoff callers', async () => {
        const proc = createMockProcess({ pid: 1405 });
        mockSpawn.mockImplementationOnce(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();

        const first = client.disconnectAndWait(100);
        let secondSettled = false;
        const second = client.disconnectAndWait(100).then(() => {
            secondSettled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 1));

        expect(secondSettled).toBe(false);
        expect(proc.kill).toHaveBeenCalledTimes(1);
        proc.emit('exit', 0, null);

        await Promise.all([first, second]);
        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('reaps a captured tool descendant after the app-server wrapper exits', async () => {
        const proc = createMockProcess({ pid: 1406 });
        proc.kill.mockImplementation((signal: string) => {
            if (signal === 'SIGTERM') setTimeout(() => proc.emit('exit', 0, null), 0);
            return true;
        });
        mockSignalPosixDescendants.mockReturnValueOnce([2401]);
        mockWaitForProcessIdsToExit
            .mockResolvedValueOnce([2401])
            .mockResolvedValueOnce([]);
        mockSpawn.mockImplementationOnce(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        await client.disconnectAndWait(100);

        expect(mockSignalProcessIds).toHaveBeenCalledWith([2401], 'SIGKILL');
        expect(mockWaitForProcessIdsToExit).toHaveBeenCalledTimes(2);
    });

    it('kills the complete Windows shim process tree during handoff', async () => {
        const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
        try {
            const proc = createMockProcess({ pid: 1403 });
            const taskkill = createMockProcess({ pid: 1404 });
            mockSpawn
                .mockImplementationOnce(() => proc)
                .mockImplementationOnce(() => {
                    setTimeout(() => proc.emit('exit', 0, null), 0);
                    return taskkill;
                });

            const { CodexAppServerClient } = await import('./codexAppServerClient');
            const client = new CodexAppServerClient();
            await client.connect();
            await client.disconnectAndWait(100);

            expect(mockSpawn).toHaveBeenNthCalledWith(
                2,
                'taskkill',
                ['/PID', '1403', '/T', '/F'],
                { stdio: 'ignore', windowsHide: true },
            );
            expect(proc.kill).not.toHaveBeenCalled();
        } finally {
            platform.mockRestore();
        }
    });

    it('appends rollout log filter to existing RUST_LOG', async () => {
        process.env.RUST_LOG = 'info,codex_core=warn';
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(mockSpawn).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                env: expect.objectContaining({
                    RUST_LOG: 'info,codex_core=warn,codex_core::rollout::list=off',
                }),
            }),
        );

        await client.disconnect();
    });

    it('ignores stale process exit during reconnect initialize', async () => {
        const proc1 = createMockProcess({ pid: 1001, initializeDelayMs: 5 });
        const proc2 = createMockProcess({ pid: 1002, initializeDelayMs: 50 });
        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.disconnect();

        const reconnect = client.connect();
        setTimeout(() => {
            proc1.emit('exit', 0, null);
        }, 10);

        await expect(reconnect).resolves.toBeUndefined();
        await client.disconnect();
    });

    it('reconnects and resumes the same thread after forced restart timeout', async () => {
        const firstProcessRequests: MockRpcMessage[] = [];
        const secondProcessRequests: MockRpcMessage[] = [];
        let firstProcessExited = false;
        let secondProcessSpawnedBeforeExit = false;
        type CapturedEvent = { type: string; [key: string]: unknown };

        const proc1 = createMockProcess({
            pid: 2001,
            onRequest: (msg, stdout) => {
                firstProcessRequests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-1', path: '/tmp/thread-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_started', turn_id: 'turn-1' } },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: { abortReason: 'interrupted' } });
                    }, 0);
                }
            },
        });

        const proc2 = createMockProcess({
            pid: 2002,
            onRequest: (msg, stdout) => {
                secondProcessRequests.push(msg);

                if (msg.method === 'thread/resume' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-1', path: '/tmp/thread-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_started', turn_id: 'turn-2' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_complete', turn_id: 'turn-2' } },
                        });
                    }, 0);
                }
            },
        });

        proc1.kill.mockImplementation((signal: string) => {
            if (signal === 'SIGTERM') {
                setTimeout(() => {
                    firstProcessExited = true;
                    proc1.emit('exit', 0, null);
                }, 10);
            }
            return true;
        });

        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => {
                secondProcessSpawnedBeforeExit = !firstProcessExited;
                return proc2;
            });

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: CapturedEvent[] = [];
        client.setEventHandler((msg) => {
            events.push(msg as CapturedEvent);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        const pendingTurn = client.sendTurnAndWait('hang forever', { turnTimeoutMs: 5000 });
        await waitFor(() => firstProcessRequests.some((msg) => msg.method === 'turn/start'));

        const abortResult = await client.abortTurnWithFallback({
            gracePeriodMs: 1,
            forceRestartOnTimeout: true,
        });

        await expect(pendingTurn).resolves.toEqual({ aborted: true });
        expect(abortResult).toEqual({
            hadActiveTurn: true,
            aborted: true,
            forcedRestart: true,
            resumedThread: true,
        });
        expect(events).toContainEqual(expect.objectContaining({
            type: 'turn_aborted',
            reason: 'interrupted',
            turn_id: 'turn-1',
            forced_restart: true,
        }));

        const resumeRequest = secondProcessRequests.find((msg) => msg.method === 'thread/resume');
        expect(resumeRequest?.params).toEqual(expect.objectContaining({
            threadId: 'thread-1',
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
            persistExtendedHistory: true,
        }));
        expect(client.threadId).toBe('thread-1');
        expect(secondProcessSpawnedBeforeExit).toBe(false);

        await expect(client.sendTurnAndWait('follow up after reconnect')).resolves.toEqual({ aborted: false });

        await client.disconnect();
    });

    it('maps raw item notifications into legacy events and deduplicates turn completion', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3001,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-1', path: '/tmp/thread-raw-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-1', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/status/changed',
                            params: { threadId: 'thread-raw-1', status: { type: 'active', activeFlags: [] } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-1',
                                turn: {
                                    id: 'turn-raw-1',
                                    items: [{
                                        type: 'userMessage',
                                        id: 'user-raw-1',
                                        clientId: null,
                                        content: [{ type: 'text', text: 'run pwd', text_elements: [] }],
                                    }],
                                    status: 'inProgress',
                                    error: null,
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'userMessage',
                                    id: 'user-raw-1',
                                    clientId: null,
                                    content: [{ type: 'text', text: 'run pwd', text_elements: [] }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'commandExecution',
                                    id: 'call-1',
                                    command: '/bin/zsh -lc pwd',
                                    cwd: '/tmp/project',
                                    status: 'inProgress',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'commandExecution',
                                    id: 'call-1',
                                    command: '/bin/zsh -lc pwd',
                                    cwd: '/tmp/project',
                                    aggregatedOutput: '/tmp/project\n',
                                    exitCode: 0,
                                    durationMs: 1,
                                    status: 'completed',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-1',
                                    text: 'done',
                                    phase: 'final_answer',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/status/changed',
                            params: { threadId: 'thread-raw-1', status: { type: 'idle' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turn: { id: 'turn-raw-1', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('run pwd')).resolves.toEqual({ aborted: false });

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'user_message', message: 'run pwd', item_id: 'user-raw-1' }),
            expect.objectContaining({ type: 'task_started', turn_id: 'turn-raw-1' }),
            expect.objectContaining({ type: 'exec_command_begin', callId: 'call-1' }),
            expect.objectContaining({ type: 'exec_command_end', callId: 'call-1', output: '/tmp/project\n' }),
            expect.objectContaining({ type: 'agent_message', message: 'done' }),
        ]));
        expect(events.findIndex((event) => event.type === 'user_message'))
            .toBeLessThan(events.findIndex((event) => event.type === 'task_started'));
        expect(events.filter((event) => event.type === 'user_message')).toHaveLength(1);
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);

        await client.disconnect();
    });

    it('announces a root thread created by another app-server client', async () => {
        const proc = createMockProcess({
            pid: 3007,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/resume' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: {
                                id: 'thread-from-tui',
                                turns: [{
                                    id: 'turn-from-tui',
                                    status: 'inProgress',
                                    items: [{
                                        type: 'userMessage',
                                        id: 'user-from-tui',
                                        clientId: null,
                                        content: [{ type: 'text', text: 'why', text_elements: [] }],
                                    }],
                                }],
                            },
                            model: 'gpt-test',
                        },
                    }), 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((event) => events.push(event as Record<string, unknown>));
        await client.connect();

        pushJsonLine(proc.stdout, {
            method: 'thread/started',
            params: {
                thread: {
                    id: 'thread-from-tui',
                    parentThreadId: null,
                    path: '/tmp/thread-from-tui',
                },
            },
        });
        await waitFor(() => client.threadId === 'thread-from-tui');

        expect(events).toContainEqual({
            type: 'thread_started',
            thread_id: 'thread-from-tui',
        });

        pushJsonLine(proc.stdout, {
            method: 'thread/status/changed',
            params: {
                threadId: 'thread-from-tui',
                status: { type: 'active', activeFlags: [] },
            },
        });
        await waitFor(() => events.some((event) => event.type === 'thread_active'));
        expect(events).toContainEqual({
            type: 'thread_active',
            thread_id: 'thread-from-tui',
        });

        await client.resumeThread({
            threadId: 'thread-from-tui',
            emitActiveTurnSnapshot: true,
        });
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'user_message', message: 'why', item_id: 'user-from-tui' }),
            expect.objectContaining({ type: 'task_started', turn_id: 'turn-from-tui' }),
        ]));
        await client.disconnect();
    });

    it('maps raw file change items into legacy patch events', async () => {
        const proc = createMockProcess({
            pid: 3003,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-3', path: '/tmp/thread-raw-3' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-3', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-3',
                                turn: { id: 'turn-raw-3', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-1',
                                    status: 'inProgress',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-1',
                                    status: 'completed',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-3',
                                    text: 'patched',
                                    phase: 'final_answer',
                                },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('patch the file')).resolves.toEqual({ aborted: false });

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'patch_apply_begin',
                callId: 'patch-1',
                changes: {
                    'README.md': {
                        diff: '@@ -1 +1 @@',
                        kind: { type: 'update', move_path: null },
                    },
                },
            }),
            expect.objectContaining({
                type: 'patch_apply_end',
                callId: 'patch-1',
                status: 'completed',
            }),
        ]));

        await client.disconnect();
    });

    it('hydrates v2 file change approvals from raw item metadata', async () => {
        const approvals: Array<Record<string, unknown>> = [];
        const proc = createMockProcess({
            pid: 3004,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-4', path: '/tmp/thread-raw-4' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-4',
                                turnId: 'turn-raw-4',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-approval-1',
                                    status: 'inProgress',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 99,
                            method: 'item/fileChange/requestApproval',
                            params: {
                                threadId: 'thread-raw-4',
                                turnId: 'turn-raw-4',
                                itemId: 'patch-approval-1',
                                reason: null,
                                grantRoot: null,
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setApprovalHandler(async (params) => {
            approvals.push(params as Record<string, unknown>);
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });

        await waitFor(() => approvals.length === 1);

        expect(approvals[0]).toEqual(expect.objectContaining({
            type: 'patch',
            callId: 'patch-approval-1',
            fileChanges: {
                'README.md': {
                    diff: '@@ -1 +1 @@',
                    kind: { type: 'update', move_path: null },
                },
            },
            reason: null,
        }));

        await client.disconnect();
    });

    it('falls back to final answer completion when raw turn/completed is missing', async () => {
        const proc = createMockProcess({
            pid: 3002,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-2', path: '/tmp/thread-raw-2' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-2', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-2',
                                turn: { id: 'turn-raw-2', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-2',
                                turnId: 'turn-raw-2',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-2',
                                    text: 'still works',
                                    phase: 'final_answer',
                                },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('say hi')).resolves.toEqual({ aborted: false });
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'task_started', turn_id: 'turn-raw-2' }),
            expect.objectContaining({ type: 'agent_message', message: 'still works' }),
            expect.objectContaining({ type: 'task_complete', turn_id: 'turn-raw-2' }),
        ]));

        await client.disconnect();
    });

    it('responds to MCP elicitation requests with an action payload', async () => {
        const approvals: Array<Record<string, unknown>> = [];
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3007,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-7', path: '/tmp/thread-raw-7' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 77,
                            method: 'mcpServer/elicitation/request',
                            params: {
                                threadId: 'thread-raw-7',
                                turnId: 'turn-raw-7',
                                serverName: 'happy',
                                mode: 'form',
                                _meta: {
                                    codex_approval_kind: 'mcp_tool_call',
                                    tool_title: 'Change Chat Title',
                                    tool_description: 'Change the title of the current chat session',
                                    tool_params: { title: 'Casual Greeting' },
                                },
                                message: 'Allow the happy MCP server to run tool "change_title"?',
                                requestedSchema: {
                                    type: 'object',
                                    properties: {},
                                },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setApprovalHandler(async (params) => {
            approvals.push(params as Record<string, unknown>);
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });

        await waitFor(() => approvals.length === 1);
        await waitFor(() => requests.some((msg) => msg.id === 77 && msg.result?.action === 'accept'));

        expect(approvals[0]).toEqual(expect.objectContaining({
            type: 'mcp',
            callId: 'happy:77',
            toolName: 'change_title',
            input: { title: 'Casual Greeting' },
            serverName: 'happy',
        }));
        expect(requests).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 77,
                result: {
                    action: 'accept',
                    content: {},
                    _meta: null,
                },
            }),
        ]));

        await client.disconnect();
    });

    it('steers an active turn without interrupting or replacing it', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3010,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-steer', path: '/tmp/thread-steer' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'never',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: { turn: { id: 'turn-steer' } } });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: { threadId: 'thread-steer', turn: { id: 'turn-steer', status: 'inProgress' } },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/steer' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { turnId: 'turn-steer' },
                    }), 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        await client.startThread({ approvalPolicy: 'never', sandbox: 'danger-full-access' });

        let originalSettled = false;
        const originalTurn = client.sendTurnAndWait('original', { turnTimeoutMs: 5_000 }).then((result) => {
            originalSettled = true;
            return result;
        });
        await waitFor(() => client.turnId === 'turn-steer');

        await expect(client.steerTurn('phone follow-up')).resolves.toEqual({ turnId: 'turn-steer' });
        expect(requests.find((msg) => msg.method === 'turn/steer')?.params).toEqual({
            threadId: 'thread-steer',
            expectedTurnId: 'turn-steer',
            input: [{ type: 'text', text: 'phone follow-up' }],
        });
        expect(requests.some((msg) => msg.method === 'turn/interrupt')).toBe(false);
        expect(originalSettled).toBe(false);

        pushJsonLine(proc.stdout, {
            method: 'turn/completed',
            params: { threadId: 'thread-steer', turn: { id: 'turn-steer', status: 'completed', error: null } },
        });
        await expect(originalTurn).resolves.toEqual({ aborted: false });
        expect(client.hasActiveTurn()).toBe(false);
        await client.disconnect();
    });

    it('does not resurrect a turn that completes before the steer response', async () => {
        const proc = createMockProcess({
            pid: 3017,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { thread: { id: 'thread-fast', path: '/tmp/fast' }, model: 'gpt-test' },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: { turn: { id: 'turn-fast' } } });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: { threadId: 'thread-fast', turn: { id: 'turn-fast', status: 'inProgress' } },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/steer' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: { threadId: 'thread-fast', turn: { id: 'turn-fast', status: 'completed', error: null } },
                        });
                        pushJsonLine(stdout, { id: msg.id, result: { turnId: 'turn-fast' } });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        await client.startThread({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
        const originalTurn = client.sendTurnAndWait('original', { turnTimeoutMs: 5_000 });
        await waitFor(() => client.turnId === 'turn-fast');
        await expect(client.steerTurn('fast follow-up')).resolves.toEqual({ turnId: 'turn-fast' });
        await expect(originalTurn).resolves.toEqual({ aborted: false });
        expect(client.hasActiveTurn()).toBe(false);
        await client.disconnect();
    });

    it('observes local-TUI approvals without racing a response', async () => {
        const requests: MockRpcMessage[] = [];
        const approvals: Array<Record<string, unknown>> = [];
        const proc = createMockProcess({
            pid: 3011,
            onRequest: (msg) => requests.push(msg),
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setApprovalHandler(async (params) => {
            approvals.push(params as Record<string, unknown>);
            return 'approved';
        });
        client.setApprovalHandlingMode('observer');
        await client.connect();

        pushJsonLine(proc.stdout, {
            id: 88,
            method: 'item/commandExecution/requestApproval',
            params: { threadId: 'thread-local', turnId: 'turn-local', itemId: 'call-local', command: 'pwd', cwd: '/tmp' },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(approvals).toHaveLength(0);
        expect(requests.some((msg) => msg.id === 88 && msg.result)).toBe(false);

        pushJsonLine(proc.stdout, {
            method: 'serverRequest/resolved',
            params: { threadId: 'thread-local', requestId: 88 },
        });
        client.setApprovalHandlingMode('active');
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(approvals).toHaveLength(0);

        pushJsonLine(proc.stdout, {
            id: 89,
            method: 'item/commandExecution/requestApproval',
            params: { threadId: 'thread-remote', turnId: 'turn-remote', itemId: 'call-remote', command: 'pwd', cwd: '/tmp' },
        });
        await waitFor(() => approvals.length === 1);
        await waitFor(() => requests.some((msg) => msg.id === 89 && msg.result?.decision === 'accept'));
        await client.disconnect();
    });

    it('waits for an approval handler before assuming ownership of a deferred request', async () => {
        const requests: MockRpcMessage[] = [];
        const approvals: Array<Record<string, unknown>> = [];
        const proc = createMockProcess({
            pid: 3013,
            onRequest: (msg) => requests.push(msg),
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setApprovalHandlingMode('observer');
        await client.connect();

        pushJsonLine(proc.stdout, {
            id: 'approval-before-handler',
            method: 'item/commandExecution/requestApproval',
            params: { threadId: 'thread-local', turnId: 'turn-local', itemId: 'call-local', command: 'pwd', cwd: '/tmp' },
        });
        client.setApprovalHandlingMode('active');
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(requests.some((msg) => msg.id === 'approval-before-handler' && msg.result)).toBe(false);

        client.setApprovalHandler(async (params) => {
            approvals.push(params as Record<string, unknown>);
            return 'approved';
        });
        await waitFor(() => approvals.length === 1);
        await waitFor(() => requests.some((msg) => msg.id === 'approval-before-handler' && msg.result?.decision === 'accept'));
        await client.disconnect();
    });

    it('suppresses a phone approval response resolved by the local TUI', async () => {
        const requests: MockRpcMessage[] = [];
        let resolveApproval!: () => void;
        const approvalGate = new Promise<void>((resolve) => { resolveApproval = resolve; });
        const proc = createMockProcess({
            pid: 3014,
            onRequest: (msg) => requests.push(msg),
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        let approvalStarted = false;
        client.setApprovalHandler(async () => {
            approvalStarted = true;
            await approvalGate;
            return 'approved';
        });
        await client.connect();

        pushJsonLine(proc.stdout, {
            id: 90,
            method: 'item/commandExecution/requestApproval',
            params: { threadId: 'thread-root', turnId: 'turn-root', itemId: 'call-root', command: 'pwd', cwd: '/tmp' },
        });
        await waitFor(() => approvalStarted);
        pushJsonLine(proc.stdout, {
            method: 'serverRequest/resolved',
            params: { threadId: 'thread-root', requestId: 90 },
        });
        resolveApproval();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(requests.some((msg) => msg.id === 90 && msg.result)).toBe(false);
        await client.disconnect();
    });

    it('keeps root turn state while child subagent lifecycle events complete', async () => {
        const proc = createMockProcess({
            pid: 3015,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { thread: { id: 'thread-root', path: '/tmp/root', turns: [] }, model: 'gpt-test' },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: { turn: { id: 'turn-root' } } });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: { threadId: 'thread-root', turn: { id: 'turn-root', status: 'inProgress' } },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((event) => events.push(event as Record<string, unknown>));
        await client.connect();
        await client.startThread({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
        let rootSettled = false;
        const rootTurn = client.sendTurnAndWait('delegate', { turnTimeoutMs: 5_000 }).then((result) => {
            rootSettled = true;
            return result;
        });
        await waitFor(() => client.turnId === 'turn-root');

        pushJsonLine(proc.stdout, {
            method: 'turn/started',
            params: { threadId: 'thread-child', turn: { id: 'turn-child', status: 'inProgress' } },
        });
        pushJsonLine(proc.stdout, {
            method: 'item/completed',
            params: { threadId: 'thread-child', turnId: 'turn-child', item: { type: 'agentMessage', id: 'child-final', text: 'done', phase: 'final_answer' } },
        });
        pushJsonLine(proc.stdout, {
            method: 'thread/status/changed',
            params: { threadId: 'thread-child', status: { type: 'idle' } },
        });
        pushJsonLine(proc.stdout, {
            method: 'turn/completed',
            params: { threadId: 'thread-child', turn: { id: 'turn-child', status: 'completed', error: null } },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(client.turnId).toBe('turn-root');
        expect(rootSettled).toBe(false);
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(0);

        pushJsonLine(proc.stdout, {
            method: 'turn/completed',
            params: { threadId: 'thread-root', turn: { id: 'turn-root', status: 'completed', error: null } },
        });
        await expect(rootTurn).resolves.toEqual({ aborted: false });
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);
        await client.disconnect();
    });

    it('does not clear a newer active turn on stale completion', async () => {
        const proc = createMockProcess({ pid: 3012 });
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((event) => events.push(event as Record<string, unknown>));
        await client.connect();

        pushJsonLine(proc.stdout, {
            method: 'turn/started',
            params: { threadId: 'thread-race', turn: { id: 'turn-new', status: 'inProgress' } },
        });
        await waitFor(() => client.turnId === 'turn-new');
        pushJsonLine(proc.stdout, {
            method: 'turn/completed',
            params: { threadId: 'thread-race', turn: { id: 'turn-old', status: 'completed', error: null } },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(client.turnId).toBe('turn-new');
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(0);
        await client.disconnect();
    });

    it('initializes JSON-RPC over WebSocket and reaps the owned host', async () => {
        let server: WebSocketServer | null = null;
        const proc = createMockProcess({ pid: 3016 });
        proc.kill.mockImplementation((signal: string) => {
            if (signal === 'SIGTERM') {
                server?.close();
                setTimeout(() => proc.emit('exit', 0, null), 0);
            }
            return true;
        });
        mockSpawn.mockImplementationOnce((_command: string, args: string[]) => {
            const endpoint = new URL(args[2]);
            server = new WebSocketServer({ host: endpoint.hostname, port: Number(endpoint.port) });
            server.on('connection', (socket) => {
                socket.on('message', (data) => {
                    const message = JSON.parse(data.toString());
                    if (message.method === 'initialize') {
                        socket.send(JSON.stringify({ id: message.id, result: { userAgent: 'ws-test' } }));
                    }
                });
            });
            return proc;
        });

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(undefined, { transport: 'websocket' });
        await client.connect();
        expect(client.remoteEndpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
        await client.disconnectAndWait(100);
        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('reaps the WebSocket app-server when initialize fails', async () => {
        let server: WebSocketServer | null = null;
        const proc = createMockProcess({ pid: 3018 });
        proc.kill.mockImplementation((signal: string) => {
            if (signal === 'SIGTERM') {
                server?.close();
                setTimeout(() => proc.emit('exit', 1, null), 0);
            }
            return true;
        });
        mockSpawn.mockImplementationOnce((_command: string, args: string[]) => {
            const endpoint = new URL(args[2]);
            server = new WebSocketServer({ host: endpoint.hostname, port: Number(endpoint.port) });
            server.on('connection', (socket) => {
                socket.on('message', (data) => {
                    const message = JSON.parse(data.toString());
                    if (message.method === 'initialize') {
                        socket.send(JSON.stringify({
                            id: message.id,
                            error: { code: -32600, message: 'initialize rejected' },
                        }));
                    }
                });
            });
            return proc;
        });

        const { CodexAppServerClient, CodexRpcError } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(undefined, { transport: 'websocket' });
        await expect(client.connect()).rejects.toBeInstanceOf(CodexRpcError);
        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
        expect(client.remoteEndpoint).toBeNull();
    });
});
