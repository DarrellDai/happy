import type { AddressInfo } from 'node:net';

import WebSocket, { WebSocketServer, type RawData } from 'ws';

export type CodexTuiSelectionMethod =
    | 'thread/start'
    | 'thread/resume'
    | 'thread/fork';

export type CodexTuiThreadSelection = {
    threadId: string;
    method: CodexTuiSelectionMethod;
    /** Root turn that was active in the TUI's successful selection snapshot. */
    activeTurnId?: string;
};

export type CodexTuiWebSocketProxy = {
    endpoint: string;
    waitForIdle(): Promise<void>;
    close(): Promise<void>;
};

export type StartCodexTuiWebSocketProxyOptions = {
    targetEndpoint: string;
    onThreadSelected(selection: CodexTuiThreadSelection): void | Promise<void>;
    onError?(error: Error): void;
    /** Session-scoped MCP servers merged into native-TUI `thread/start` requests. */
    threadStartMcpServers?: Record<string, unknown>;
};

type JsonRpcId = string | number;

type PendingSelection = {
    method: CodexTuiSelectionMethod;
};

type CorrelatedSelection = {
    id: JsonRpcId;
    selection: CodexTuiThreadSelection;
};

type QueuedFrame = {
    data: Buffer;
    isBinary: boolean;
};

const LOOPBACK_HOST = '127.0.0.1';
const SELECTION_METHODS = new Set<CodexTuiSelectionMethod>([
    'thread/start',
    'thread/resume',
    'thread/fork',
]);

function asError(value: unknown, fallback: string): Error {
    if (value instanceof Error) {
        return value;
    }
    return new Error(value == null ? fallback : String(value));
}

function copyFrame(data: RawData, isBinary: boolean): QueuedFrame {
    if (Array.isArray(data)) {
        return { data: Buffer.concat(data), isBinary };
    }
    if (data instanceof ArrayBuffer) {
        return { data: Buffer.from(data.slice(0)), isBinary };
    }
    return { data: Buffer.from(data), isBinary };
}

function parseJsonFrame(frame: QueuedFrame): unknown {
    if (frame.isBinary) {
        return null;
    }
    try {
        return JSON.parse(frame.data.toString('utf8'));
    } catch {
        return null;
    }
}

function jsonRpcMessages(value: unknown): Record<string, unknown>[] {
    const values = Array.isArray(value) ? value : [value];
    return values.filter((item): item is Record<string, unknown> => (
        item !== null && typeof item === 'object' && !Array.isArray(item)
    ));
}

function jsonRpcId(value: unknown): JsonRpcId | null {
    return typeof value === 'string' || typeof value === 'number' ? value : null;
}

function trackSelectionRequests(
    frame: QueuedFrame,
    pendingSelections: Map<JsonRpcId, PendingSelection>,
): void {
    for (const message of jsonRpcMessages(parseJsonFrame(frame))) {
        if (typeof message.method !== 'string') {
            continue;
        }
        const id = jsonRpcId(message.id);
        if (id === null) {
            continue;
        }

        // JSON-RPC request ids are scoped to a connection and may be reused once
        // a request completes. Replacing any older entry keeps correlation tied
        // to the most recent request observed on this exact TUI connection.
        pendingSelections.delete(id);
        if (SELECTION_METHODS.has(message.method as CodexTuiSelectionMethod)) {
            pendingSelections.set(id, {
                method: message.method as CodexTuiSelectionMethod,
            });
        }
    }
}

function injectThreadStartMcpServers(
    frame: QueuedFrame,
    mcpServers: Record<string, unknown> | undefined,
): QueuedFrame {
    if (!mcpServers || Object.keys(mcpServers).length === 0) {
        return frame;
    }
    const parsed = parseJsonFrame(frame);
    let changed = false;
    const inject = (value: unknown): unknown => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            return value;
        }
        const message = value as Record<string, unknown>;
        if (message.method !== 'thread/start') {
            return value;
        }
        const params = message.params !== null
            && typeof message.params === 'object'
            && !Array.isArray(message.params)
            ? message.params as Record<string, unknown>
            : {};
        const config = params.config !== null
            && typeof params.config === 'object'
            && !Array.isArray(params.config)
            ? params.config as Record<string, unknown>
            : {};
        const existingMcpServers = config.mcp_servers !== null
            && typeof config.mcp_servers === 'object'
            && !Array.isArray(config.mcp_servers)
            ? config.mcp_servers as Record<string, unknown>
            : {};
        changed = true;
        return {
            ...message,
            params: {
                ...params,
                config: {
                    ...config,
                    mcp_servers: {
                        ...existingMcpServers,
                        ...mcpServers,
                    },
                },
            },
        };
    };
    const injected = Array.isArray(parsed) ? parsed.map(inject) : inject(parsed);
    if (!changed) {
        return frame;
    }
    return {
        data: Buffer.from(JSON.stringify(injected), 'utf8'),
        isBinary: false,
    };
}

function consumeThreadSelections(
    frame: QueuedFrame,
    pendingSelections: Map<JsonRpcId, PendingSelection>,
): CorrelatedSelection[] {
    const selections: CorrelatedSelection[] = [];
    for (const message of jsonRpcMessages(parseJsonFrame(frame))) {
        // A server request can use the same id as a client request because the
        // two directions have independent request namespaces. Only response
        // envelopes (which have no method) can complete a selection request.
        if (typeof message.method === 'string') {
            continue;
        }
        const id = jsonRpcId(message.id);
        if (id === null) {
            continue;
        }
        const pending = pendingSelections.get(id);
        if (!pending) {
            continue;
        }
        pendingSelections.delete(id);

        if (message.error !== undefined) {
            continue;
        }
        const result = message.result;
        if (result === null || typeof result !== 'object' || Array.isArray(result)) {
            continue;
        }
        const thread = (result as Record<string, unknown>).thread;
        if (thread === null || typeof thread !== 'object' || Array.isArray(thread)) {
            continue;
        }
        const threadRecord = thread as Record<string, unknown>;
        if (typeof threadRecord.id !== 'string' || threadRecord.id.length === 0) {
            continue;
        }
        if (threadRecord.parentThreadId !== null && threadRecord.parentThreadId !== undefined) {
            continue;
        }
        const turns = Array.isArray(threadRecord.turns) ? threadRecord.turns : [];
        const activeTurn = [...turns].reverse().find((turn) => (
            turn !== null
            && typeof turn === 'object'
            && !Array.isArray(turn)
            && (turn as Record<string, unknown>).status === 'inProgress'
            && typeof (turn as Record<string, unknown>).id === 'string'
        )) as Record<string, unknown> | undefined;
        selections.push({
            id,
            selection: {
                threadId: threadRecord.id,
                method: pending.method,
                ...(typeof activeTurn?.id === 'string' ? { activeTurnId: activeTurn.id } : {}),
            },
        });
    }
    return selections;
}

function replaceFailedSelectionResponses(
    frame: QueuedFrame,
    failedIds: Set<JsonRpcId>,
): QueuedFrame {
    if (failedIds.size === 0) {
        return frame;
    }
    const parsed = parseJsonFrame(frame);
    const replace = (value: unknown): unknown => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            return value;
        }
        const message = value as Record<string, unknown>;
        const id = jsonRpcId(message.id);
        if (id === null || typeof message.method === 'string' || !failedIds.has(id)) {
            return value;
        }
        return {
            jsonrpc: typeof message.jsonrpc === 'string' ? message.jsonrpc : '2.0',
            id,
            error: {
                code: -32098,
                message: 'Happy could not attach to the selected Codex thread. Please retry.',
            },
        };
    };
    const replaced = Array.isArray(parsed) ? parsed.map(replace) : replace(parsed);
    return {
        data: Buffer.from(JSON.stringify(replaced), 'utf8'),
        isBinary: false,
    };
}

function canForwardCloseCode(code: number): boolean {
    return code >= 1000
        && code <= 4999
        && code !== 1004
        && code !== 1005
        && code !== 1006
        && code !== 1015;
}

function closeSocket(socket: WebSocket, code?: number, reason?: Buffer): void {
    if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
        return;
    }
    if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
        return;
    }
    try {
        if (code !== undefined && canForwardCloseCode(code)) {
            socket.close(code, reason);
        } else {
            socket.close();
        }
    } catch {
        socket.terminate();
    }
}

async function sendFrame(socket: WebSocket, frame: QueuedFrame): Promise<void> {
    if (socket.readyState !== WebSocket.OPEN) {
        throw new Error(`Cannot forward WebSocket frame while destination state is ${socket.readyState}`);
    }
    await new Promise<void>((resolve, reject) => {
        socket.send(frame.data, { binary: frame.isBinary }, (error) => {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

/**
 * Start a connection-scoped relay for a Codex TUI attached to a shared
 * app-server. Selection is derived only from successful request/response pairs
 * observed on the same downstream connection.
 */
export async function startCodexTuiWebSocketProxy(
    opts: StartCodexTuiWebSocketProxyOptions,
): Promise<CodexTuiWebSocketProxy> {
    const targetUrl = new URL(opts.targetEndpoint);
    if (targetUrl.protocol !== 'ws:' && targetUrl.protocol !== 'wss:') {
        throw new Error(`Codex TUI proxy target must use ws:// or wss://: ${opts.targetEndpoint}`);
    }
    if (targetUrl.hash.length > 0) {
        throw new Error(`Codex TUI proxy target cannot contain a URL fragment: ${opts.targetEndpoint}`);
    }

    const sessions = new Set<{ close(): void; terminate(): void }>();
    const upstreamSockets = new Set<WebSocket>();
    const inFlightServerFrames = new Set<Promise<void>>();
    let proxyClosing = false;
    let closePromise: Promise<void> | null = null;

    const reportError = (value: unknown, fallback: string): void => {
        if (!opts.onError) {
            return;
        }
        try {
            opts.onError(asError(value, fallback));
        } catch {
            // Error reporting must never interfere with transport forwarding.
        }
    };

    const trackServerFrame = (promise: Promise<void>): void => {
        inFlightServerFrames.add(promise);
        void promise.finally(() => {
            inFlightServerFrames.delete(promise);
        });
    };

    const server = new WebSocketServer({
        host: LOOPBACK_HOST,
        port: 0,
    });

    server.on('connection', (downstream) => {
        if (proxyClosing) {
            downstream.close(1012, 'proxy closing');
            return;
        }
        // This relay belongs to one launched native TUI. Accepting concurrent
        // controllers would make two connection-scoped selections race for
        // Happy's single active root.
        if (sessions.size > 0) {
            downstream.close(1013, 'native TUI already attached');
            return;
        }

        const pendingSelections = new Map<JsonRpcId, PendingSelection>();
        let upstream: WebSocket;
        try {
            upstream = new WebSocket(opts.targetEndpoint);
        } catch (error) {
            reportError(error, 'Could not create the Codex TUI proxy upstream socket');
            downstream.close(1011, 'upstream unavailable');
            return;
        }
        upstreamSockets.add(upstream);
        let sessionClosed = false;
        let upstreamReadySettled = false;
        let settleUpstreamReady: (ready: boolean) => void = () => undefined;
        const upstreamReady = new Promise<boolean>((resolve) => {
            settleUpstreamReady = resolve;
        });
        let clientToServerTail = Promise.resolve();
        let serverToClientTail = Promise.resolve();

        const resolveUpstreamReady = (ready: boolean): void => {
            if (upstreamReadySettled) {
                return;
            }
            upstreamReadySettled = true;
            settleUpstreamReady(ready);
        };

        const session = {
            close(): void {
                if (sessionClosed) {
                    return;
                }
                sessionClosed = true;
                pendingSelections.clear();
                resolveUpstreamReady(false);
                sessions.delete(session);
                closeSocket(downstream);
                closeSocket(upstream);
            },
            terminate(): void {
                if (!sessionClosed) {
                    sessionClosed = true;
                    pendingSelections.clear();
                    resolveUpstreamReady(false);
                    sessions.delete(session);
                }
                downstream.terminate();
                upstream.terminate();
            },
        };
        sessions.add(session);

        upstream.once('open', () => {
            resolveUpstreamReady(true);
        });

        downstream.on('message', (data, isBinary) => {
            const frame = injectThreadStartMcpServers(
                copyFrame(data, isBinary),
                opts.threadStartMcpServers,
            );
            trackSelectionRequests(frame, pendingSelections);
            clientToServerTail = clientToServerTail.then(async () => {
                const ready = await upstreamReady;
                if (!ready || sessionClosed) {
                    return;
                }
                try {
                    await sendFrame(upstream, frame);
                } catch (error) {
                    if (!sessionClosed && !proxyClosing) {
                        reportError(error, 'Failed to forward a Codex TUI message upstream');
                    }
                }
            });
        });

        upstream.on('message', (data, isBinary) => {
            const frame = copyFrame(data, isBinary);
            // Consume correlation synchronously so a subsequent socket close
            // cannot discard a response that has already arrived.
            const selections = consumeThreadSelections(frame, pendingSelections);
            const task = serverToClientTail.then(async () => {
                const failedSelectionIds = new Set<JsonRpcId>();
                for (const correlated of selections) {
                    try {
                        await opts.onThreadSelected(correlated.selection);
                    } catch (error) {
                        failedSelectionIds.add(correlated.id);
                        reportError(error, `Failed to adopt Codex thread ${correlated.selection.threadId}`);
                    }
                }
                try {
                    await sendFrame(
                        downstream,
                        replaceFailedSelectionResponses(frame, failedSelectionIds),
                    );
                } catch (error) {
                    if (!sessionClosed && !proxyClosing) {
                        reportError(error, 'Failed to forward a Codex app-server message to the TUI');
                    }
                }
            }).catch((error) => {
                reportError(error, 'Unexpected Codex TUI proxy forwarding failure');
            });
            serverToClientTail = task;
            trackServerFrame(task);
        });

        downstream.once('close', (code, reason) => {
            if (!sessionClosed) {
                sessionClosed = true;
                pendingSelections.clear();
                resolveUpstreamReady(false);
                sessions.delete(session);
                closeSocket(upstream, code, reason);
            }
        });
        upstream.once('close', (code, reason) => {
            upstreamSockets.delete(upstream);
            if (!sessionClosed) {
                sessionClosed = true;
                pendingSelections.clear();
                resolveUpstreamReady(false);
                sessions.delete(session);
                // The peer may close immediately after writing its final
                // response. Preserve the admitted response and its selection
                // callback before mirroring the close to the TUI.
                void serverToClientTail.finally(() => {
                    closeSocket(downstream, code, reason);
                });
            }
        });

        downstream.on('error', (error) => {
            if (!sessionClosed && !proxyClosing) {
                reportError(error, 'Codex TUI proxy downstream socket failed');
            }
            session.close();
        });
        upstream.on('error', (error) => {
            resolveUpstreamReady(false);
            if (!sessionClosed && !proxyClosing) {
                reportError(error, 'Codex TUI proxy upstream socket failed');
            }
            if (!sessionClosed) {
                sessionClosed = true;
                pendingSelections.clear();
                sessions.delete(session);
                closeSocket(upstream);
                // Match the normal upstream-close path: an already-received
                // response owns its place in the downstream FIFO even when an
                // error follows it.
                void serverToClientTail.finally(() => {
                    closeSocket(downstream, 1011, Buffer.from('upstream failed'));
                });
            }
        });
    });

    await new Promise<void>((resolve, reject) => {
        const onListening = (): void => {
            server.off('error', onStartupError);
            resolve();
        };
        const onStartupError = (error: Error): void => {
            server.off('listening', onListening);
            reject(error);
        };
        server.once('listening', onListening);
        server.once('error', onStartupError);
    });

    server.on('error', (error) => {
        if (!proxyClosing) {
            reportError(error, 'Codex TUI proxy listener failed');
        }
    });

    const address = server.address() as AddressInfo;
    const endpoint = `ws://${LOOPBACK_HOST}:${address.port}`;

    const waitForIdle = async (): Promise<void> => {
        while (inFlightServerFrames.size > 0) {
            await Promise.allSettled(Array.from(inFlightServerFrames));
        }
    };

    const close = (): Promise<void> => {
        if (closePromise) {
            return closePromise;
        }
        proxyClosing = true;
        const upstreamClosed = Array.from(upstreamSockets).map((socket) => {
            if (socket.readyState === WebSocket.CLOSED) {
                return Promise.resolve();
            }
            return new Promise<void>((resolve) => socket.once('close', () => resolve()));
        });
        const listenerClosed = new Promise<void>((resolve) => {
            server.close(() => resolve());
            for (const session of Array.from(sessions)) {
                session.terminate();
            }
            // Sessions normally own every downstream client, but terminate the
            // server's authoritative client set as a final guard against a
            // peer stuck in a close handshake after its upstream disappeared.
            for (const downstream of server.clients) {
                downstream.terminate();
            }
            for (const upstream of upstreamSockets) {
                upstream.terminate();
            }
        });
        closePromise = Promise.all([listenerClosed, ...upstreamClosed]).then(() => undefined);
        return closePromise;
    };

    return {
        endpoint,
        waitForIdle,
        close,
    };
}
