import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer, type RawData } from 'ws';

import {
    startCodexTuiWebSocketProxy,
    type CodexTuiThreadNotification,
    type CodexTuiThreadSelection,
    type CodexTuiTurnAccepted,
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
    onThreadNotification?(notification: CodexTuiThreadNotification): void | Promise<void>;
    onTurnAccepted?(turn: CodexTuiTurnAccepted): void | Promise<void>;
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

    it('orders fresh-root turn identity and typed notifications after selection adoption', async () => {
        const target = await createTargetServer();
        let releaseTurnAdoption: () => void = () => undefined;
        const turnAdoptionGate = new Promise<void>((resolve) => {
            releaseTurnAdoption = resolve;
        });
        let markTurnAdoptionStarted: () => void = () => undefined;
        const turnAdoptionStarted = new Promise<void>((resolve) => {
            markTurnAdoptionStarted = resolve;
        });
        const order: string[] = [];
        const turns: CodexTuiTurnAccepted[] = [];
        const notifications: CodexTuiThreadNotification[] = [];
        const proxy = await startProxy({
            targetEndpoint: target.endpoint,
            onThreadSelected: (selection) => {
                order.push(`selected:${selection.threadId}`);
            },
            onTurnAccepted: async (turn) => {
                turns.push(turn);
                order.push(`turn:${turn.turnId}`);
                markTurnAdoptionStarted();
                await turnAdoptionGate;
            },
            onThreadNotification: (notification) => {
                notifications.push(notification);
                order.push(`notification:${notification.method}`);
            },
        });
        const upstreamConnection = nextConnection(target.server);
        const tui = await connect(proxy.endpoint);
        const upstream = await upstreamConnection;

        const selectionRequest = collectFrames(upstream, 1);
        sendJson(tui, { jsonrpc: '2.0', id: 51, method: 'thread/start', params: {} });
        await selectionRequest;
        const selectionResponse = collectFrames(tui, 1);
        sendJson(upstream, {
            jsonrpc: '2.0',
            id: 51,
            result: { thread: { id: 'fresh-root', parentThreadId: null, turns: [] } },
        });
        await selectionResponse;

        const turnRequest = collectFrames(upstream, 1);
        sendJson(tui, {
            jsonrpc: '2.0',
            id: 52,
            method: 'turn/start',
            params: { threadId: 'fresh-root', input: [] },
        });
        await turnRequest;

        const receivedByTui: string[] = [];
        tui.on('message', (data) => receivedByTui.push(copyData(data).toString('utf8')));
        const forwarded = collectFrames(tui, 3);
        const turnResponse = {
            jsonrpc: '2.0',
            id: 52,
            result: { turn: { id: 'fresh-turn', status: 'inProgress' } },
        };
        const laterNotification = {
            jsonrpc: '2.0',
            method: 'turn/started',
            params: {
                threadId: 'fresh-root',
                turn: { id: 'fresh-turn', status: 'inProgress' },
            },
        };
        const completion = {
            jsonrpc: '2.0',
            method: 'turn/completed',
            params: {
                threadId: 'fresh-root',
                turn: { id: 'fresh-turn', status: 'completed', error: null },
            },
        };
        sendJson(upstream, turnResponse);
        sendJson(upstream, laterNotification);
        sendJson(upstream, completion);

        await turnAdoptionStarted;
        const upstreamClosed = waitForClose(upstream);
        upstream.close();
        await upstreamClosed;
        expect(order).toEqual(['selected:fresh-root', 'turn:fresh-turn']);
        expect(turns).toEqual([{ threadId: 'fresh-root', turnId: 'fresh-turn' }]);
        expect(receivedByTui).toEqual([]);

        let idleSettled = false;
        const idle = proxy.waitForIdle().then(() => {
            idleSettled = true;
        });
        await Promise.resolve();
        expect(idleSettled).toBe(false);

        releaseTurnAdoption();
        const frames = await forwarded;
        await idle;
        expect(frames.map((frame) => JSON.parse(frame.data.toString('utf8')))).toEqual([
            turnResponse,
            laterNotification,
            completion,
        ]);
        expect(notifications).toEqual([
            {
                threadId: 'fresh-root',
                method: 'turn/started',
                params: laterNotification.params,
            },
            {
                threadId: 'fresh-root',
                method: 'turn/completed',
                params: completion.params,
            },
        ]);
        expect(order).toEqual([
            'selected:fresh-root',
            'turn:fresh-turn',
            'notification:turn/started',
            'notification:turn/completed',
        ]);
    });

    it('keeps an ephemeral title thread from stealing fresh-root ownership', async () => {
        const target = await createTargetServer();
        const selections: CodexTuiThreadSelection[] = [];
        const notifications: CodexTuiThreadNotification[] = [];
        const proxy = await startProxy({
            targetEndpoint: target.endpoint,
            onThreadSelected: (selection) => {
                selections.push(selection);
            },
            onThreadNotification: (notification) => {
                notifications.push(notification);
            },
        });

        const rootUpstreamConnection = nextConnection(target.server);
        const rootTui = await connect(proxy.endpoint);
        const rootUpstream = await rootUpstreamConnection;
        const rootRequest = collectFrames(rootUpstream, 1);
        sendJson(rootTui, {
            jsonrpc: '2.0', id: 1, method: 'thread/start', params: { ephemeral: false },
        });
        await rootRequest;
        const rootResponse = collectFrames(rootTui, 1);
        sendJson(rootUpstream, {
            jsonrpc: '2.0', id: 1,
            result: {
                thread: {
                    id: 'durable-root',
                    parentThreadId: null,
                    ephemeral: false,
                    turns: [],
                },
            },
        });
        await rootResponse;

        const titleUpstreamConnection = nextConnection(target.server);
        const titleTui = await connect(proxy.endpoint);
        const titleUpstream = await titleUpstreamConnection;
        const titleRequest = collectFrames(titleUpstream, 1);
        sendJson(titleTui, {
            jsonrpc: '2.0', id: 1, method: 'thread/start', params: { ephemeral: true },
        });
        await titleRequest;
        const titleResponse = collectFrames(titleTui, 1);
        sendJson(titleUpstream, {
            jsonrpc: '2.0', id: 1,
            result: {
                thread: {
                    id: 'title-helper',
                    parentThreadId: null,
                    turns: [],
                },
            },
        });
        await titleResponse;

        const responseMarkedRequest = collectFrames(titleUpstream, 1);
        sendJson(titleTui, {
            jsonrpc: '2.0', id: 2, method: 'thread/start', params: {},
        });
        await responseMarkedRequest;
        const responseMarkedResponse = collectFrames(titleTui, 1);
        sendJson(titleUpstream, {
            jsonrpc: '2.0', id: 2,
            result: {
                thread: {
                    id: 'response-marked-helper',
                    parentThreadId: null,
                    ephemeral: true,
                    turns: [],
                },
            },
        });
        await responseMarkedResponse;

        const titleCompletion = {
            jsonrpc: '2.0',
            method: 'turn/completed',
            params: {
                threadId: 'title-helper',
                turn: { id: 'title-turn', status: 'completed', error: null },
            },
        };
        const rootCompletion = {
            jsonrpc: '2.0',
            method: 'turn/completed',
            params: {
                threadId: 'durable-root',
                turn: { id: 'root-turn', status: 'completed', error: null },
            },
        };
        const forwarded = Promise.all([
            collectFrames(titleTui, 1),
            collectFrames(rootTui, 1),
        ]);
        sendJson(titleUpstream, titleCompletion);
        sendJson(rootUpstream, rootCompletion);
        await forwarded;
        await proxy.waitForIdle();

        expect(selections).toEqual([
            { threadId: 'durable-root', method: 'thread/start' },
        ]);
        expect(notifications).toEqual([
            {
                threadId: 'durable-root',
                method: 'turn/completed',
                params: rootCompletion.params,
            },
        ]);
    });

    it('rejects unowned fresh-thread events and keeps forwarding after callback failure', async () => {
        const target = await createTargetServer();
        const callbackError = new Error('observer callback failed');
        const onError = vi.fn();
        const turns: CodexTuiTurnAccepted[] = [];
        const notifications: CodexTuiThreadNotification[] = [];
        const proxy = await startProxy({
            targetEndpoint: target.endpoint,
            onThreadSelected: vi.fn(),
            onTurnAccepted: (turn) => {
                turns.push(turn);
            },
            onThreadNotification: (notification) => {
                notifications.push(notification);
                if (notification.method === 'turn/started') {
                    throw callbackError;
                }
            },
            onError,
        });
        const upstreamConnection = nextConnection(target.server);
        const tui = await connect(proxy.endpoint);
        const upstream = await upstreamConnection;

        const selectionRequest = collectFrames(upstream, 1);
        sendJson(tui, { jsonrpc: '2.0', id: 61, method: 'thread/start', params: {} });
        await selectionRequest;
        const selectionResponse = collectFrames(tui, 1);
        sendJson(upstream, {
            jsonrpc: '2.0', id: 61,
            result: { thread: { id: 'fresh-root', parentThreadId: null, turns: [] } },
        });
        await selectionResponse;

        const requests = collectFrames(upstream, 5);
        sendJson(tui, {
            jsonrpc: '2.0', id: 62, method: 'turn/start',
            params: { threadId: 'child-root', input: [] },
        });
        sendJson(tui, {
            jsonrpc: '2.0', id: 63, method: 'turn/start',
            params: { threadId: 'fresh-root', input: [] },
        });
        sendJson(tui, {
            jsonrpc: '2.0', id: 65, method: 'turn/start',
            params: { threadId: 'fresh-root', input: [] },
        });
        sendJson(tui, {
            jsonrpc: '2.0', id: 66, method: 'turn/start',
            params: { threadId: 'fresh-root', input: [] },
        });
        sendJson(tui, {
            jsonrpc: '2.0', id: 67, method: 'turn/start',
            params: { threadId: 'fresh-root', input: [] },
        });
        await requests;

        const responses = collectFrames(tui, 11);
        sendJson(upstream, {
            jsonrpc: '2.0', id: 62,
            result: { turn: { id: 'child-turn', status: 'inProgress' } },
        });
        sendJson(upstream, {
            jsonrpc: '2.0', id: 63,
            result: { turn: { id: 'fresh-turn', status: 'inProgress' } },
        });
        sendJson(upstream, {
            jsonrpc: '2.0', id: 65,
            error: { code: -32600, message: 'turn rejected' },
        });
        sendJson(upstream, {
            jsonrpc: '2.0', id: 66,
            result: {},
        });
        sendJson(upstream, {
            jsonrpc: '2.0', id: 67,
            result: { turn: { id: 'accepted-once', status: 'inProgress' } },
        });
        sendJson(upstream, {
            jsonrpc: '2.0', id: 67,
            result: { turn: { id: 'duplicate-response', status: 'inProgress' } },
        });
        sendJson(upstream, {
            jsonrpc: '2.0', id: 999,
            result: { turn: { id: 'unmatched-response', status: 'inProgress' } },
        });
        sendJson(upstream, {
            jsonrpc: '2.0', method: 'turn/started',
            params: {
                threadId: 'child-root',
                turn: { id: 'child-turn', status: 'inProgress' },
            },
        });
        sendJson(upstream, {
            jsonrpc: '2.0', method: 'thread/status/changed',
            params: { threadId: 'fresh-root', status: { type: 'idle' } },
        });
        sendJson(upstream, {
            jsonrpc: '2.0', method: 'turn/started',
            params: {
                threadId: 'fresh-root',
                turn: { id: 'fresh-turn', status: 'inProgress' },
            },
        });
        sendJson(upstream, {
            jsonrpc: '2.0', method: 'turn/completed',
            params: {
                threadId: 'fresh-root',
                turn: { id: 'fresh-turn', status: 'completed', error: null },
            },
        });
        await responses;
        await proxy.waitForIdle();

        expect(turns).toEqual([
            { threadId: 'fresh-root', turnId: 'fresh-turn' },
            { threadId: 'fresh-root', turnId: 'accepted-once' },
        ]);
        expect(notifications.map((notification) => notification.method)).toEqual([
            'turn/started',
            'turn/completed',
        ]);
        expect(onError).toHaveBeenCalledWith(callbackError);

        const reselectionRequest = collectFrames(upstream, 1);
        sendJson(tui, { jsonrpc: '2.0', id: 64, method: 'thread/resume', params: {} });
        await reselectionRequest;
        const laterFrames = collectFrames(tui, 4);
        sendJson(upstream, {
            jsonrpc: '2.0', id: 64,
            result: { thread: { id: 'resumed-root', parentThreadId: null, turns: [] } },
        });
        sendJson(upstream, {
            jsonrpc: '2.0', method: 'turn/completed',
            params: {
                threadId: 'fresh-root',
                turn: { id: 'late-fresh-turn', status: 'completed', error: null },
            },
        });
        sendJson(upstream, {
            jsonrpc: '2.0', method: 'turn/started',
            params: {
                threadId: 'resumed-root',
                turn: { id: 'resumed-turn', status: 'inProgress' },
            },
        });
        sendJson(upstream, {
            jsonrpc: '2.0', method: 'turn/completed',
            params: {
                threadId: 'resumed-root',
                turn: { id: 'resumed-turn', status: 'completed', error: null },
            },
        });
        await laterFrames;
        await proxy.waitForIdle();
        expect(notifications).toHaveLength(2);
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
