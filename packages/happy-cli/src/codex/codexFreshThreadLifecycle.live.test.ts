import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket, { type RawData } from 'ws';
import { describe, expect, it, vi } from 'vitest';

import { CodexAppServerClient } from './codexAppServerClient';
import { emitReadyForLocalCompletion } from './emitReadyIfIdle';
import { LocalTurnCompletionGate } from './localTurnCompletionGate';
import { sendCodexReadyNotification } from './sendCodexReadyNotification';
import {
    routeFreshThreadNotification,
    routeFreshThreadTurnAccepted,
} from './freshThreadEventBridge';
import { startCodexTuiWebSocketProxy } from './codexTuiWebSocketProxy';

const LIVE_PROBE_ENABLED = process.env.HAPPY_RUN_CODEX_FRESH_THREAD_PROBE === '1';

type RpcResponse = {
    id?: string | number;
    result?: unknown;
    error?: { code?: number; message?: string };
};

class RawAppServerClient {
    private nextId = 1;
    private readonly pending = new Map<number, {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();

    constructor(private readonly socket: WebSocket) {
        socket.on('message', (data) => this.handleMessage(data));
        socket.once('close', () => this.rejectPending(new Error('App-server WebSocket closed')));
        socket.on('error', (error) => this.rejectPending(error));
    }

    request(method: string, params?: unknown, timeoutMs: number = 30_000): Promise<unknown> {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.socket.send(
                JSON.stringify({ jsonrpc: '2.0', id, method, params }),
                (error) => {
                    if (!error) return;
                    const pending = this.pending.get(id);
                    if (!pending) return;
                    this.pending.delete(id);
                    clearTimeout(pending.timer);
                    pending.reject(error);
                },
            );
        });
    }

    notify(method: string, params?: unknown): void {
        this.socket.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
    }

    rejectPending(error: Error): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }

    private handleMessage(data: RawData): void {
        const parsed = JSON.parse(data.toString()) as RpcResponse | RpcResponse[];
        for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
            if (typeof message.id !== 'number') {
                continue;
            }
            const pending = this.pending.get(message.id);
            if (!pending) {
                continue;
            }
            this.pending.delete(message.id);
            clearTimeout(pending.timer);
            if (message.error) {
                pending.reject(new Error(
                    `JSON-RPC ${message.error.code ?? -1}: ${message.error.message ?? 'unknown error'}`,
                ));
            } else {
                pending.resolve(message.result);
            }
        }
    }
}

async function connectWebSocket(endpoint: string): Promise<WebSocket> {
    const socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });
    return socket;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error(`Condition was not met within ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

describe.skipIf(!LIVE_PROBE_ENABLED)('fresh Codex TUI lifecycle live probe', () => {
    it('produces exactly one ready event and captured direct push', async () => {
        const probeRoot = await mkdtemp(join(tmpdir(), 'happy-codex-fresh-probe-'));
        const probeCodexHome = join(probeRoot, 'codex-home');
        const probeWorkspace = join(probeRoot, 'workspace');
        const priorCodexHome = process.env.CODEX_HOME;
        const sourceCodexHome = priorCodexHome ?? join(homedir(), '.codex');
        const sourceAuth = join(sourceCodexHome, 'auth.json');
        const probeAuth = join(probeCodexHome, 'auth.json');
        let observer: CodexAppServerClient | null = null;
        let proxy: Awaited<ReturnType<typeof startCodexTuiWebSocketProxy>> | null = null;
        let tuiSocket: WebSocket | null = null;
        let tui: RawAppServerClient | null = null;

        try {
            await mkdir(probeCodexHome, { recursive: true });
            await mkdir(probeWorkspace, { recursive: true });
            try {
                await stat(sourceAuth);
                await copyFile(sourceAuth, probeAuth);
            } catch (error) {
                if (!process.env.OPENAI_API_KEY) {
                    throw new Error(`Live probe needs ${sourceAuth} or OPENAI_API_KEY`, { cause: error });
                }
            }
            process.env.CODEX_HOME = probeCodexHome;

            const events: Array<Record<string, unknown>> = [];
            const selections: Array<{ threadId: string; method: string }> = [];
            const mirroredMethods: string[] = [];
            const lifecycleOrder: string[] = [];
            const proxyErrors: Error[] = [];
            const completionGate = new LocalTurnCompletionGate();
            const sendReadyEvent = vi.fn();
            const sendToAllDevices = vi.fn();

            observer = new CodexAppServerClient(undefined, {
                transport: 'websocket',
                adoptExternalRootThreads: false,
            });
            observer.setEventHandler((event) => {
                const message = event as Record<string, unknown>;
                events.push(message);
                const decision = completionGate.classify(message);
                if (!decision.accepted || !decision.successfulCompletion) {
                    return;
                }
                emitReadyForLocalCompletion({
                    message,
                    handoffPending: false,
                    queueSize: () => 0,
                    shouldExit: false,
                    sendReady: () => sendCodexReadyNotification({
                        sessionId: 'fresh-live-probe',
                        metadata: undefined,
                        sendReadyEvent,
                        sendToAllDevices,
                    }),
                });
            });
            await observer.connect();
            if (!observer.remoteEndpoint) {
                throw new Error('Live probe observer did not expose a WebSocket endpoint');
            }

            proxy = await startCodexTuiWebSocketProxy({
                targetEndpoint: observer.remoteEndpoint,
                onThreadSelected: (selection) => {
                    selections.push(selection);
                    observer?.adoptThreadSelection(selection.threadId, selection.activeTurnId);
                },
                onTurnAccepted: (turn) => {
                    if (!observer) return;
                    lifecycleOrder.push(`accepted:${turn.turnId}`);
                    routeFreshThreadTurnAccepted({
                        client: observer,
                        turn,
                        subscription: {
                            subscribedThreadId: null,
                            pendingThreadId: null,
                            pendingMethod: null,
                        },
                    });
                },
                onThreadNotification: (notification) => {
                    if (!observer) return;
                    mirroredMethods.push(notification.method);
                    if (
                        notification.method === 'turn/started'
                        || notification.method === 'turn/completed'
                    ) {
                        const notificationTurnId = (
                            notification.params.turn as { id?: unknown } | undefined
                        )?.id;
                        lifecycleOrder.push(
                            `${notification.method}:${String(notificationTurnId ?? '')}`,
                        );
                    }
                    routeFreshThreadNotification({
                        client: observer,
                        notification,
                        subscription: {
                            subscribedThreadId: null,
                            pendingThreadId: null,
                            pendingMethod: null,
                        },
                    });
                },
                onError: (error) => proxyErrors.push(error),
            });
            tuiSocket = await connectWebSocket(proxy.endpoint);
            tui = new RawAppServerClient(tuiSocket);
            await tui.request('initialize', {
                clientInfo: {
                    name: 'happy-fresh-thread-live-probe',
                    title: 'Happy fresh-thread live probe',
                    version: '1.0.0',
                },
                capabilities: { experimentalApi: true },
            });
            tui.notify('initialized');

            const started = await tui.request('thread/start', {
                cwd: probeWorkspace,
                approvalPolicy: 'never',
                sandbox: 'read-only',
                experimentalRawEvents: false,
            }) as { thread?: { id?: string } };
            const threadId = started.thread?.id;
            if (!threadId) {
                throw new Error('Live probe thread/start returned no thread id');
            }

            const accepted = await tui.request('turn/start', {
                threadId,
                input: [{
                    type: 'text',
                    text: 'Reply exactly FRESH_NOTIFICATION_PROBE_OK. Do not use tools.',
                }],
                cwd: probeWorkspace,
                approvalPolicy: 'never',
                sandboxPolicy: { type: 'readOnly' },
            }) as { turn?: { id?: string } };
            const turnId = accepted.turn?.id;
            if (!turnId) {
                throw new Error('Live probe turn/start returned no turn id');
            }

            await waitFor(() => sendToAllDevices.mock.calls.length === 1, 120_000);
            await waitFor(() => mirroredMethods.includes('turn/completed'), 5_000);
            await proxy.close();
            await proxy.waitForIdle();
            proxy = null;
            tui?.rejectPending(new Error('Live probe completed'));
            tui = null;
            tuiSocket = null;
            await observer.disconnectAndWait();
            observer = null;

            expect(selections).toEqual([{ threadId, method: 'thread/start' }]);
            expect(events.filter((event) => event.type === 'task_started')).toEqual([
                expect.objectContaining({ type: 'task_started', turn_id: turnId }),
            ]);
            expect(events.filter((event) => event.type === 'task_complete')).toEqual([
                expect.objectContaining({ type: 'task_complete', turn_id: turnId }),
            ]);
            expect(events.filter((event) => event.type === 'turn_aborted')).toHaveLength(0);
            expect(mirroredMethods.filter((method) => (
                method === 'turn/started' || method === 'turn/completed'
            ))).toEqual(['turn/started', 'turn/completed']);
            expect(lifecycleOrder).toEqual([
                `accepted:${turnId}`,
                `turn/started:${turnId}`,
                `turn/completed:${turnId}`,
            ]);
            expect(proxyErrors).toEqual([]);
            expect(sendReadyEvent).toHaveBeenCalledTimes(1);
            expect(sendToAllDevices).toHaveBeenCalledTimes(1);
            expect(sendToAllDevices).toHaveBeenCalledWith(
                "It's ready!",
                'Session',
                {
                    sessionId: 'fresh-live-probe',
                    kind: 'done',
                    type: 'ready',
                    provider: 'codex',
                },
            );
        } finally {
            tui?.rejectPending(new Error('Live probe shutting down'));
            tuiSocket?.terminate();
            try {
                if (proxy) {
                    await proxy.close();
                    await proxy.waitForIdle();
                }
            } finally {
                try {
                    await observer?.disconnectAndWait();
                } finally {
                    if (priorCodexHome === undefined) {
                        delete process.env.CODEX_HOME;
                    } else {
                        process.env.CODEX_HOME = priorCodexHome;
                    }
                    await rm(probeRoot, { recursive: true, force: true });
                }
            }
        }
    }, 150_000);
});
