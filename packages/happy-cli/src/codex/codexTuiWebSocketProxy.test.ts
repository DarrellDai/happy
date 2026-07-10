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

    it('rejects a second concurrent TUI so selections have one controller', async () => {
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
        const secondTui = await connect(proxy.endpoint);
        await waitForClose(secondTui);
        expect(target.server.clients.size).toBe(1);

        const firstRequest = collectFrames(firstUpstream, 1);
        sendJson(firstTui, { jsonrpc: '2.0', id: 1, method: 'thread/resume', params: {} });
        await firstRequest;

        const firstResponse = collectFrames(firstTui, 1);
        sendJson(firstUpstream, {
            jsonrpc: '2.0', id: 1,
            result: { thread: { id: 'first-root', parentThreadId: null } },
        });
        await firstResponse;
        await proxy.waitForIdle();

        expect(selections).toEqual([
            { threadId: 'first-root', method: 'thread/resume' },
        ]);
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

    it('reports a failed adoption callback and returns an error instead of false success', async () => {
        const target = await createTargetServer();
        const callbackError = new Error('adoption failed');
        const onError = vi.fn();
        const proxy = await startProxy({
            targetEndpoint: target.endpoint,
            onThreadSelected: async () => {
                throw callbackError;
            },
            onError,
        });
        const upstreamConnection = nextConnection(target.server);
        const tui = await connect(proxy.endpoint);
        const upstream = await upstreamConnection;

        const request = collectFrames(upstream, 1);
        sendJson(tui, { jsonrpc: '2.0', id: 12, method: 'thread/resume', params: {} });
        await request;

        const response = {
            jsonrpc: '2.0', id: 12,
            result: { thread: { id: 'not-adopted', parentThreadId: null } },
        };
        const forwarded = collectFrames(tui, 1);
        sendJson(upstream, response);
        const [frame] = await forwarded;
        await proxy.waitForIdle();

        expect(JSON.parse(frame.data.toString('utf8'))).toEqual({
            jsonrpc: '2.0',
            id: 12,
            error: {
                code: -32098,
                message: 'Happy could not attach to the selected Codex thread. Please retry.',
            },
        });
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
