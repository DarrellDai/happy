import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer, type RawData } from 'ws';

import {
    startCodexTuiWebSocketProxy,
    type CodexTuiThreadSelection,
    type CodexTuiWebSocketProxy,
} from './codexTuiWebSocketProxy';

type Frame = {
    data: Buffer;
    isBinary: boolean;
};

const proxies: CodexTuiWebSocketProxy[] = [];
const servers: WebSocketServer[] = [];
const sockets = new Set<WebSocket>();

function copyData(data: RawData): Buffer {
    if (Array.isArray(data)) {
        return Buffer.concat(data);
    }
    if (data instanceof ArrayBuffer) {
        return Buffer.from(data);
    }
    return Buffer.from(data);
}

async function createTargetServer(): Promise<{ server: WebSocketServer; endpoint: string }> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Target WebSocket server did not bind a TCP port');
    }
    return {
        server,
        endpoint: `ws://127.0.0.1:${address.port}`,
    };
}

function nextConnection(server: WebSocketServer): Promise<WebSocket> {
    return new Promise((resolve) => {
        server.once('connection', (socket) => {
            sockets.add(socket);
            resolve(socket);
        });
    });
}

async function connect(endpoint: string): Promise<WebSocket> {
    const socket = new WebSocket(endpoint);
    sockets.add(socket);
    await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });
    return socket;
}

function collectFrames(socket: WebSocket, count: number): Promise<Frame[]> {
    return new Promise((resolve, reject) => {
        const frames: Frame[] = [];
        const onMessage = (data: RawData, isBinary: boolean): void => {
            frames.push({ data: copyData(data), isBinary });
            if (frames.length === count) {
                cleanup();
                resolve(frames);
            }
        };
        const onError = (error: Error): void => {
            cleanup();
            reject(error);
        };
        const onClose = (): void => {
            cleanup();
            reject(new Error(`Socket closed after ${frames.length} of ${count} expected frames`));
        };
        const cleanup = (): void => {
            socket.off('message', onMessage);
            socket.off('error', onError);
            socket.off('close', onClose);
        };
        socket.on('message', onMessage);
        socket.once('error', onError);
        socket.once('close', onClose);
    });
}

function waitForClose(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.CLOSED) {
        return Promise.resolve();
    }
    return new Promise((resolve) => socket.once('close', () => resolve()));
}

function sendJson(socket: WebSocket, value: unknown): void {
    socket.send(JSON.stringify(value));
}

async function startProxy(opts: {
    targetEndpoint: string;
    onThreadSelected(selection: CodexTuiThreadSelection): void | Promise<void>;
    onError?(error: Error): void;
    threadStartMcpServers?: Record<string, unknown>;
}): Promise<CodexTuiWebSocketProxy> {
    const proxy = await startCodexTuiWebSocketProxy(opts);
    proxies.push(proxy);
    return proxy;
}

afterEach(async () => {
    await Promise.allSettled(proxies.splice(0).map((proxy) => proxy.close()));
    for (const socket of sockets) {
        if (socket.readyState !== WebSocket.CLOSED) {
            socket.terminate();
        }
    }
    sockets.clear();
    await Promise.allSettled(servers.splice(0).map(async (server) => {
        for (const client of server.clients) {
            client.terminate();
        }
        if (server.address() !== null) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    }));
});

describe('startCodexTuiWebSocketProxy', () => {
    it('forwards ordered text and binary frames in both directions', async () => {
        const target = await createTargetServer();
        const proxy = await startProxy({
            targetEndpoint: target.endpoint,
            onThreadSelected: vi.fn(),
        });
        const upstreamConnection = nextConnection(target.server);
        const tui = await connect(proxy.endpoint);
        const upstream = await upstreamConnection;

        const toUpstream = collectFrames(upstream, 3);
        tui.send('first');
        tui.send(Buffer.from([0, 1, 2]));
        tui.send('third');
        await expect(toUpstream).resolves.toEqual([
            { data: Buffer.from('first'), isBinary: false },
            { data: Buffer.from([0, 1, 2]), isBinary: true },
            { data: Buffer.from('third'), isBinary: false },
        ]);

        const toTui = collectFrames(tui, 3);
        upstream.send('server-first');
        upstream.send(Buffer.from([3, 4, 5]));
        upstream.send('server-third');
        await expect(toTui).resolves.toEqual([
            { data: Buffer.from('server-first'), isBinary: false },
            { data: Buffer.from([3, 4, 5]), isBinary: true },
            { data: Buffer.from('server-third'), isBinary: false },
        ]);
        await proxy.waitForIdle();
    });

    it('injects the session-scoped Happy MCP server into native thread starts', async () => {
        const target = await createTargetServer();
        const proxy = await startProxy({
            targetEndpoint: target.endpoint,
            onThreadSelected: vi.fn(),
            threadStartMcpServers: {
                happy: {
                    command: '/usr/bin/node',
                    args: ['happy-mcp.mjs', '--url', 'http://127.0.0.1:4567/'],
                },
            },
        });
        const upstreamConnection = nextConnection(target.server);
        const tui = await connect(proxy.endpoint);
        const upstream = await upstreamConnection;

        const forwarded = collectFrames(upstream, 1);
        sendJson(tui, {
            jsonrpc: '2.0',
            id: 5,
            method: 'thread/start',
            params: {
                cwd: '/tmp/project',
                config: {
                    experimental: true,
                    mcp_servers: {
                        paper: { url: 'http://127.0.0.1:29979/mcp' },
                    },
                },
            },
        });

        const [frame] = await forwarded;
        expect(JSON.parse(frame.data.toString('utf8'))).toEqual({
            jsonrpc: '2.0',
            id: 5,
            method: 'thread/start',
            params: {
                cwd: '/tmp/project',
                config: {
                    experimental: true,
                    mcp_servers: {
                        paper: { url: 'http://127.0.0.1:29979/mcp' },
                        happy: {
                            command: '/usr/bin/node',
                            args: ['happy-mcp.mjs', '--url', 'http://127.0.0.1:4567/'],
                        },
                    },
                },
            },
        });
    });

    it('holds a selected-root response and later traffic until adoption settles', async () => {
        const target = await createTargetServer();
        let releaseSelection: () => void = () => undefined;
        const selectionGate = new Promise<void>((resolve) => {
            releaseSelection = resolve;
        });
        let markSelectionStarted: () => void = () => undefined;
        const selectionStarted = new Promise<void>((resolve) => {
            markSelectionStarted = resolve;
        });
        const selections: CodexTuiThreadSelection[] = [];
        const proxy = await startProxy({
            targetEndpoint: target.endpoint,
            onThreadSelected: async (selection) => {
                selections.push(selection);
                markSelectionStarted();
                await selectionGate;
            },
        });
        const upstreamConnection = nextConnection(target.server);
        const tui = await connect(proxy.endpoint);
        const upstream = await upstreamConnection;

        const requestAtUpstream = collectFrames(upstream, 1);
        sendJson(tui, {
            jsonrpc: '2.0',
            id: 7,
            method: 'thread/resume',
            params: { threadId: 'requested-root' },
        });
        await requestAtUpstream;

        const forwarded = collectFrames(tui, 2);
        const receivedByTui: string[] = [];
        tui.on('message', (data) => receivedByTui.push(copyData(data).toString('utf8')));
        const response = {
            jsonrpc: '2.0',
            id: 7,
            result: {
                thread: {
                    id: 'selected-root',
                    parentThreadId: null,
                    turns: [{ id: 'selected-turn', status: 'inProgress' }],
                },
            },
        };
        const notification = {
            jsonrpc: '2.0',
            method: 'thread/status/changed',
            params: { threadId: 'selected-root', status: { type: 'active', activeFlags: [] } },
        };
        sendJson(upstream, response);
        sendJson(upstream, notification);

        await selectionStarted;
        expect(selections).toEqual([{
            threadId: 'selected-root',
            method: 'thread/resume',
            activeTurnId: 'selected-turn',
        }]);
        expect(receivedByTui).toEqual([]);

        let idleSettled = false;
        const idle = proxy.waitForIdle().then(() => {
            idleSettled = true;
        });
        await Promise.resolve();
        expect(idleSettled).toBe(false);

        releaseSelection();
        await idle;
        const frames = await forwarded;
        expect(frames.map((frame) => JSON.parse(frame.data.toString('utf8')))).toEqual([
            response,
            notification,
        ]);
    });

    it('correlates start, resume, and fork responses by string or numeric id', async () => {
        const target = await createTargetServer();
        const selections: CodexTuiThreadSelection[] = [];
        const proxy = await startProxy({
            targetEndpoint: target.endpoint,
            onThreadSelected: async (selection) => {
                selections.push(selection);
            },
        });
        const upstreamConnection = nextConnection(target.server);
        const tui = await connect(proxy.endpoint);
        const upstream = await upstreamConnection;

        const requests = collectFrames(upstream, 3);
        sendJson(tui, { jsonrpc: '2.0', id: 1, method: 'thread/start', params: {} });
        sendJson(tui, { jsonrpc: '2.0', id: 'resume-id', method: 'thread/resume', params: {} });
        sendJson(tui, { jsonrpc: '2.0', id: 3, method: 'thread/fork', params: {} });
        await requests;

        const responses = collectFrames(tui, 3);
        sendJson(upstream, {
            jsonrpc: '2.0', id: 3,
            result: { thread: { id: 'fork-root', parentThreadId: null } },
        });
        sendJson(upstream, {
            jsonrpc: '2.0', id: 1,
            result: { thread: { id: 'start-root', parentThreadId: null } },
        });
        sendJson(upstream, {
            jsonrpc: '2.0', id: 'resume-id',
            result: { thread: { id: 'resume-root', parentThreadId: null } },
        });
        await responses;
        await proxy.waitForIdle();

        expect(selections).toEqual([
            { threadId: 'fork-root', method: 'thread/fork' },
            { threadId: 'start-root', method: 'thread/start' },
            { threadId: 'resume-root', method: 'thread/resume' },
        ]);
    });

    it('allows a later picker connection to select a thread', async () => {
        const target = await createTargetServer();
        const selections: CodexTuiThreadSelection[] = [];
        const proxy = await startProxy({
            targetEndpoint: target.endpoint,
            onThreadSelected: async (selection) => {
                selections.push(selection);
            },
        });

        const firstUpstreamConnection = nextConnection(target.server);
        const firstTui = await connect(proxy.endpoint);
        const firstUpstream = await firstUpstreamConnection;

        const secondUpstreamConnection = nextConnection(target.server);
        const secondTui = await connect(proxy.endpoint);
        const secondUpstream = await secondUpstreamConnection;
        expect(target.server.clients.size).toBe(2);

        const pickerRequest = collectFrames(secondUpstream, 1);
        sendJson(secondTui, { jsonrpc: '2.0', id: 20, method: 'thread/list', params: {} });
        await pickerRequest;
        const pickerResponse = collectFrames(secondTui, 1);
        sendJson(secondUpstream, {
            jsonrpc: '2.0', id: 20,
            result: { data: [], nextCursor: null },
        });
        await pickerResponse;

        const selectionRequest = collectFrames(secondUpstream, 1);
        sendJson(secondTui, { jsonrpc: '2.0', id: 1, method: 'thread/resume', params: {} });
        await selectionRequest;

        const selectionResponse = collectFrames(secondTui, 1);
        sendJson(secondUpstream, {
            jsonrpc: '2.0', id: 1,
            result: { thread: { id: 'picker-root', parentThreadId: null } },
        });
        await selectionResponse;
        await proxy.waitForIdle();

        expect(selections).toEqual([
            { threadId: 'picker-root', method: 'thread/resume' },
        ]);
        expect(firstTui.readyState).toBe(WebSocket.OPEN);
        expect(firstUpstream.readyState).toBe(WebSocket.OPEN);
    });

    it('serializes overlapping selections across connections with connection-scoped request ids', async () => {
        const target = await createTargetServer();
        let releaseFirstSelection: () => void = () => undefined;
        const firstSelectionGate = new Promise<void>((resolve) => {
            releaseFirstSelection = resolve;
        });
        let markFirstSelectionStarted: () => void = () => undefined;
        const firstSelectionStarted = new Promise<void>((resolve) => {
            markFirstSelectionStarted = resolve;
        });
        const selections: CodexTuiThreadSelection[] = [];
        const proxy = await startProxy({
            targetEndpoint: target.endpoint,
            onThreadSelected: async (selection) => {
                selections.push(selection);
                if (selection.threadId === 'first-root') {
                    markFirstSelectionStarted();
                    await firstSelectionGate;
                }
            },
        });

        const firstUpstreamConnection = nextConnection(target.server);
        const firstTui = await connect(proxy.endpoint);
        const firstUpstream = await firstUpstreamConnection;
        const secondUpstreamConnection = nextConnection(target.server);
        const secondTui = await connect(proxy.endpoint);
        const secondUpstream = await secondUpstreamConnection;

        const requests = Promise.all([
            collectFrames(firstUpstream, 1),
            collectFrames(secondUpstream, 1),
        ]);
        // The same request ID is valid because JSON-RPC IDs are scoped to each
        // WebSocket connection.
        sendJson(firstTui, { jsonrpc: '2.0', id: 21, method: 'thread/resume', params: {} });
        sendJson(secondTui, { jsonrpc: '2.0', id: 21, method: 'thread/resume', params: {} });
        await requests;

        const receivedByFirst: string[] = [];
        const receivedBySecond: string[] = [];
        firstTui.on('message', (data) => receivedByFirst.push(copyData(data).toString('utf8')));
        secondTui.on('message', (data) => receivedBySecond.push(copyData(data).toString('utf8')));
        const firstForwarded = collectFrames(firstTui, 1);
        const secondForwarded = collectFrames(secondTui, 1);
        sendJson(firstUpstream, {
            jsonrpc: '2.0', id: 21,
            result: { thread: { id: 'first-root', parentThreadId: null } },
        });
        await firstSelectionStarted;
        sendJson(secondUpstream, {
            jsonrpc: '2.0', id: 21,
            result: { thread: { id: 'second-root', parentThreadId: null } },
        });
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(selections).toEqual([
            { threadId: 'first-root', method: 'thread/resume' },
        ]);
        expect(receivedByFirst).toEqual([]);
        expect(receivedBySecond).toEqual([]);

        releaseFirstSelection();
        await Promise.all([firstForwarded, secondForwarded]);
        await proxy.waitForIdle();

        expect(selections).toEqual([
            { threadId: 'first-root', method: 'thread/resume' },
            { threadId: 'second-root', method: 'thread/resume' },
        ]);
        expect(receivedByFirst).toHaveLength(1);
        expect(receivedBySecond).toHaveLength(1);
    });

    it('keeps a batch of selections atomic against another connection', async () => {
        const target = await createTargetServer();
        let releaseFirstSelection: () => void = () => undefined;
        const firstSelectionGate = new Promise<void>((resolve) => {
            releaseFirstSelection = resolve;
        });
        let markFirstSelectionStarted: () => void = () => undefined;
        const firstSelectionStarted = new Promise<void>((resolve) => {
            markFirstSelectionStarted = resolve;
        });
        const selectionOrder: string[] = [];
        const proxy = await startProxy({
            targetEndpoint: target.endpoint,
            onThreadSelected: async (selection) => {
                selectionOrder.push(selection.threadId);
                if (selection.threadId === 'batch-first') {
                    markFirstSelectionStarted();
                    await firstSelectionGate;
                }
            },
        });

        const firstUpstreamConnection = nextConnection(target.server);
        const firstTui = await connect(proxy.endpoint);
        const firstUpstream = await firstUpstreamConnection;
        const secondUpstreamConnection = nextConnection(target.server);
        const secondTui = await connect(proxy.endpoint);
        const secondUpstream = await secondUpstreamConnection;

        const requests = Promise.all([
            collectFrames(firstUpstream, 1),
            collectFrames(secondUpstream, 1),
        ]);
        sendJson(firstTui, [
            { jsonrpc: '2.0', id: 31, method: 'thread/resume', params: {} },
            { jsonrpc: '2.0', id: 32, method: 'thread/fork', params: {} },
        ]);
        sendJson(secondTui, {
            jsonrpc: '2.0', id: 33, method: 'thread/resume', params: {},
        });
        await requests;

        const firstForwarded = collectFrames(firstTui, 1);
        const secondForwarded = collectFrames(secondTui, 1);
        sendJson(firstUpstream, [
            {
                jsonrpc: '2.0', id: 31,
                result: { thread: { id: 'batch-first', parentThreadId: null } },
            },
            {
                jsonrpc: '2.0', id: 32,
                result: { thread: { id: 'batch-second', parentThreadId: null } },
            },
        ]);
        await firstSelectionStarted;
        sendJson(secondUpstream, {
            jsonrpc: '2.0', id: 33,
            result: { thread: { id: 'other-connection', parentThreadId: null } },
        });
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(selectionOrder).toEqual(['batch-first']);

        releaseFirstSelection();
        await Promise.all([firstForwarded, secondForwarded]);
        await proxy.waitForIdle();

        expect(selectionOrder).toEqual([
            'batch-first',
            'batch-second',
            'other-connection',
        ]);
    });

    it('delivers one selection response before adopting from another connection', async () => {
        const target = await createTargetServer();
        const selectionOrder: string[] = [];
        const proxy = await startProxy({
            targetEndpoint: target.endpoint,
            onThreadSelected: async (selection) => {
                selectionOrder.push(selection.threadId);
            },
        });

        const firstUpstreamConnection = nextConnection(target.server);
        const firstTui = await connect(proxy.endpoint);
        const firstUpstream = await firstUpstreamConnection;
        const secondUpstreamConnection = nextConnection(target.server);
        const secondTui = await connect(proxy.endpoint);
        const secondUpstream = await secondUpstreamConnection;

        const requests = Promise.all([
            collectFrames(firstUpstream, 1),
            collectFrames(secondUpstream, 1),
        ]);
        sendJson(firstTui, { jsonrpc: '2.0', id: 41, method: 'thread/resume', params: {} });
        sendJson(secondTui, { jsonrpc: '2.0', id: 42, method: 'thread/resume', params: {} });
        await requests;

        let markSendCallbackHeld: () => void = () => undefined;
        const sendCallbackHeld = new Promise<void>((resolve) => {
            markSendCallbackHeld = resolve;
        });
        let releaseSendCallback: () => void = () => undefined;
        const originalSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function delayedSelectionResponse(
            this: WebSocket,
            ...args: unknown[]
        ): void {
            const data = args[0];
            const text = typeof data === 'string'
                ? data
                : Buffer.isBuffer(data) ? data.toString('utf8') : '';
            const callbackIndex = typeof args[2] === 'function'
                ? 2
                : typeof args[1] === 'function' ? 1 : -1;
            if (
                callbackIndex >= 0
                && text.includes('"id":41')
                && text.includes('first-response-root')
            ) {
                const callback = args[callbackIndex] as (error?: Error) => void;
                const delayedArgs = [...args];
                delayedArgs[callbackIndex] = (error?: Error): void => {
                    releaseSendCallback = () => callback(error);
                    markSendCallbackHeld();
                };
                Reflect.apply(originalSend, this, delayedArgs);
                return;
            }
            Reflect.apply(originalSend, this, args);
        } as typeof originalSend;

        try {
            const firstForwarded = collectFrames(firstTui, 1);
            const secondForwarded = collectFrames(secondTui, 1);
            sendJson(firstUpstream, {
                jsonrpc: '2.0', id: 41,
                result: { thread: { id: 'first-response-root', parentThreadId: null } },
            });
            await Promise.all([firstForwarded, sendCallbackHeld]);

            sendJson(secondUpstream, {
                jsonrpc: '2.0', id: 42,
                result: { thread: { id: 'second-response-root', parentThreadId: null } },
            });
            await new Promise<void>((resolve) => setImmediate(resolve));

            expect(selectionOrder).toEqual(['first-response-root']);

            releaseSendCallback();
            await secondForwarded;
            await proxy.waitForIdle();
            expect(selectionOrder).toEqual([
                'first-response-root',
                'second-response-root',
            ]);
        } finally {
            releaseSendCallback();
            WebSocket.prototype.send = originalSend;
        }
    });

    it('ignores errors, unrelated responses, malformed results, duplicates, and child threads', async () => {
        const target = await createTargetServer();
        const onThreadSelected = vi.fn();
        const proxy = await startProxy({
            targetEndpoint: target.endpoint,
            onThreadSelected,
        });
        const upstreamConnection = nextConnection(target.server);
        const tui = await connect(proxy.endpoint);
        const upstream = await upstreamConnection;

        const requests = collectFrames(upstream, 4);
        sendJson(tui, { jsonrpc: '2.0', id: 1, method: 'thread/start', params: {} });
        sendJson(tui, { jsonrpc: '2.0', id: 2, method: 'thread/resume', params: {} });
        sendJson(tui, { jsonrpc: '2.0', id: 3, method: 'thread/fork', params: {} });
        sendJson(tui, { jsonrpc: '2.0', id: 4, method: 'model/list', params: {} });
        await requests;

        const responses = collectFrames(tui, 7);
        sendJson(upstream, { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'no' } });
        sendJson(upstream, {
            jsonrpc: '2.0', id: 2,
            result: { thread: { id: 'child', parentThreadId: 'parent' } },
        });
        sendJson(upstream, { jsonrpc: '2.0', id: 3, result: { thread: {} } });
        sendJson(upstream, {
            jsonrpc: '2.0', id: 4,
            result: { thread: { id: 'unrelated-root', parentThreadId: null } },
        });
        sendJson(upstream, {
            jsonrpc: '2.0', id: 999,
            result: { thread: { id: 'unknown-root', parentThreadId: null } },
        });
        sendJson(upstream, {
            jsonrpc: '2.0', id: 2,
            result: { thread: { id: 'duplicate-root', parentThreadId: null } },
        });
        sendJson(upstream, {
            jsonrpc: '2.0', id: 1, method: 'server/request', params: {},
        });
        await responses;
        await proxy.waitForIdle();

        expect(onThreadSelected).not.toHaveBeenCalled();
    });

    it('returns an adoption error and recovers the selection queue for later responses', async () => {
        const target = await createTargetServer();
        const callbackError = new Error('adoption failed');
        const onError = vi.fn();
        const selections: string[] = [];
        const proxy = await startProxy({
            targetEndpoint: target.endpoint,
            onThreadSelected: async (selection) => {
                selections.push(selection.threadId);
                if (selection.threadId === 'not-adopted') {
                    throw callbackError;
                }
            },
            onError,
        });
        const upstreamConnection = nextConnection(target.server);
        const tui = await connect(proxy.endpoint);
        const upstream = await upstreamConnection;

        const requests = collectFrames(upstream, 2);
        sendJson(tui, { jsonrpc: '2.0', id: 12, method: 'thread/resume', params: {} });
        sendJson(tui, { jsonrpc: '2.0', id: 13, method: 'thread/resume', params: {} });
        await requests;

        const failedResponse = {
            jsonrpc: '2.0', id: 12,
            result: { thread: { id: 'not-adopted', parentThreadId: null } },
        };
        const recoveredResponse = {
            jsonrpc: '2.0', id: 13,
            result: { thread: { id: 'adopted-after-failure', parentThreadId: null } },
        };
        const forwarded = collectFrames(tui, 2);
        sendJson(upstream, failedResponse);
        sendJson(upstream, recoveredResponse);
        const frames = await forwarded;
        await proxy.waitForIdle();

        expect(frames.map((frame) => JSON.parse(frame.data.toString('utf8')))).toEqual([
            {
                jsonrpc: '2.0',
                id: 12,
                error: {
                    code: -32098,
                    message: 'Happy could not attach to the selected Codex thread. Please retry.',
                },
            },
            recoveredResponse,
        ]);
        expect(selections).toEqual(['not-adopted', 'adopted-after-failure']);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(callbackError);
    });

    it('delivers an admitted selection response before mirroring an upstream close', async () => {
        const target = await createTargetServer();
        let releaseSelection: () => void = () => undefined;
        const selectionGate = new Promise<void>((resolve) => {
            releaseSelection = resolve;
        });
        let markSelectionStarted: () => void = () => undefined;
        const selectionStarted = new Promise<void>((resolve) => {
            markSelectionStarted = resolve;
        });
        const proxy = await startProxy({
            targetEndpoint: target.endpoint,
            onThreadSelected: async () => {
                markSelectionStarted();
                await selectionGate;
            },
        });
        const upstreamConnection = nextConnection(target.server);
        const tui = await connect(proxy.endpoint);
        const upstream = await upstreamConnection;

        const request = collectFrames(upstream, 1);
        sendJson(tui, { jsonrpc: '2.0', id: 13, method: 'thread/resume', params: {} });
        await request;
        const forwarded = collectFrames(tui, 1);
        const response = {
            jsonrpc: '2.0', id: 13,
            result: { thread: { id: 'selected-before-close', parentThreadId: null } },
        };
        sendJson(upstream, response);
        upstream.close();
        await selectionStarted;

        releaseSelection();
        const [frame] = await forwarded;
        expect(JSON.parse(frame.data.toString('utf8'))).toEqual(response);
        await proxy.waitForIdle();
    });

    it('waits for an in-flight selection callback after the TUI disconnects', async () => {
        const target = await createTargetServer();
        let releaseSelection: () => void = () => undefined;
        const selectionGate = new Promise<void>((resolve) => {
            releaseSelection = resolve;
        });
        let markSelectionStarted: () => void = () => undefined;
        const selectionStarted = new Promise<void>((resolve) => {
            markSelectionStarted = resolve;
        });
        const proxy = await startProxy({
            targetEndpoint: target.endpoint,
            onThreadSelected: async () => {
                markSelectionStarted();
                await selectionGate;
            },
        });
        const upstreamConnection = nextConnection(target.server);
        const tui = await connect(proxy.endpoint);
        const upstream = await upstreamConnection;

        const request = collectFrames(upstream, 1);
        sendJson(tui, { jsonrpc: '2.0', id: 14, method: 'thread/resume', params: {} });
        await request;
        sendJson(upstream, {
            jsonrpc: '2.0', id: 14,
            result: { thread: { id: 'selected-before-exit', parentThreadId: null } },
        });
        await selectionStarted;

        const tuiClosed = waitForClose(tui);
        tui.terminate();
        await tuiClosed;
        let idleSettled = false;
        const idle = proxy.waitForIdle().then(() => {
            idleSettled = true;
        });
        await Promise.resolve();
        expect(idleSettled).toBe(false);

        releaseSelection();
        await idle;
        expect(idleSettled).toBe(true);
    });

    it('closes every relay socket and is idempotent', async () => {
        const target = await createTargetServer();
        const proxy = await startProxy({
            targetEndpoint: target.endpoint,
            onThreadSelected: vi.fn(),
        });
        const upstreamConnection = nextConnection(target.server);
        const tui = await connect(proxy.endpoint);
        const upstream = await upstreamConnection;
        const tuiClosed = waitForClose(tui);
        const upstreamClosed = waitForClose(upstream);

        const firstClose = proxy.close();
        const secondClose = proxy.close();
        await Promise.all([firstClose, secondClose, tuiClosed, upstreamClosed]);
        await proxy.close();
        await proxy.waitForIdle();

        expect(tui.readyState).toBe(WebSocket.CLOSED);
        expect(upstream.readyState).toBe(WebSocket.CLOSED);
    });
});
