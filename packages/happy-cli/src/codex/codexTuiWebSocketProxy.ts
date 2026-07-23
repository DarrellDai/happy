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

export type CodexTuiThreadNotification = {
    threadId: string;
    method: string;
    params: Record<string, unknown>;
};

export type CodexTuiTurnAccepted = {
    threadId: string;
    turnId: string;
};

export type CodexTuiWebSocketProxy = {
    endpoint: string;
    waitForIdle(): Promise<void>;
    close(): Promise<void>;
};

export type StartCodexTuiWebSocketProxyOptions = {
    targetEndpoint: string;
    onThreadSelected(selection: CodexTuiThreadSelection): void | Promise<void>;
    /** Mirrors the typed event stream owned by a freshly started TUI thread. */
    onThreadNotification?(notification: CodexTuiThreadNotification): void | Promise<void>;
    /** Seeds root-turn identity even when Codex omits `turn/started`. */
    onTurnAccepted?(turn: CodexTuiTurnAccepted): void | Promise<void>;
    onError?(error: Error): void;
    /** Session-scoped MCP servers merged into native-TUI `thread/start` requests. */
    threadStartMcpServers?: Record<string, unknown>;
};

type JsonRpcId = string | number;

type PendingSelection = {
    method: CodexTuiSelectionMethod;
};

type PendingFreshThreadTurn = {
    threadId: string;
};

type CorrelatedServerEvent =
    | {
        type: 'selection';
        id: JsonRpcId;
        selection: CodexTuiThreadSelection;
    }
    | {
        type: 'notification';
        notification: CodexTuiThreadNotification;
    }
    | {
        type: 'turn-accepted';
        turn: CodexTuiTurnAccepted;
    };

type ActiveFreshThreadSelection = {
    connection: symbol;
    threadId: string;
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

function trackFreshThreadTurnRequests(
    frame: QueuedFrame,
    pendingTurns: Map<JsonRpcId, PendingFreshThreadTurn>,
    activeSelection: ActiveFreshThreadSelection | null,
    connection: symbol,
): void {
    for (const message of jsonRpcMessages(parseJsonFrame(frame))) {
        if (typeof message.method !== 'string') {
            continue;
        }
        const id = jsonRpcId(message.id);
        if (id === null) {
            continue;
        }

        pendingTurns.delete(id);
        if (
            message.method !== 'turn/start'
            || !activeSelection
            || activeSelection.connection !== connection
        ) {
            continue;
        }
        const params = message.params;
        if (params === null || typeof params !== 'object' || Array.isArray(params)) {
            continue;
        }
        const threadId = (params as Record<string, unknown>).threadId;
        if (threadId === activeSelection.threadId) {
            pendingTurns.set(id, { threadId });
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

function isMirroredThreadNotification(method: string): boolean {
    return method === 'turn/started'
        || method === 'turn/completed'
        || method === 'thread/tokenUsage/updated'
        || method.startsWith('item/');
}

function consumeCorrelatedServerEvents(
    frame: QueuedFrame,
    pendingSelections: Map<JsonRpcId, PendingSelection>,
    pendingTurns: Map<JsonRpcId, PendingFreshThreadTurn>,
): CorrelatedServerEvent[] {
    const events: CorrelatedServerEvent[] = [];
    for (const message of jsonRpcMessages(parseJsonFrame(frame))) {
        if (
            typeof message.method === 'string'
            && message.id === undefined
            && isMirroredThreadNotification(message.method)
            && message.params !== null
            && typeof message.params === 'object'
            && !Array.isArray(message.params)
        ) {
            const params = message.params as Record<string, unknown>;
            if (typeof params.threadId === 'string' && params.threadId.length > 0) {
                events.push({
                    type: 'notification',
                    notification: {
                        threadId: params.threadId,
                        method: message.method,
                        params,
                    },
                });
            }
            continue;
        }

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
        const pendingTurn = pendingTurns.get(id);
        if (pendingTurn) {
            pendingTurns.delete(id);
            if (message.error !== undefined) {
                continue;
            }
            const result = message.result;
            const turn = result !== null && typeof result === 'object' && !Array.isArray(result)
                ? (result as Record<string, unknown>).turn
                : null;
            const turnId = turn !== null && typeof turn === 'object' && !Array.isArray(turn)
                ? (turn as Record<string, unknown>).id
                : null;
            if (typeof turnId === 'string' && turnId.length > 0) {
                events.push({
                    type: 'turn-accepted',
                    turn: {
                        threadId: pendingTurn.threadId,
                        turnId,
                    },
                });
            }
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
        events.push({
            type: 'selection',
            id,
            selection: {
                threadId: threadRecord.id,
                method: pending.method,
                ...(typeof activeTurn?.id === 'string' ? { activeTurnId: activeTurn.id } : {}),
            },
        });
    }
    return events;
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
 * app-server. Selection and root-turn identity are derived only from
 * successful request/response pairs observed on the same downstream
 * connection. Fresh-thread typed events retain that connection provenance.
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

    type RelaySession = { close(): void; terminate(): void };
    const sessions = new Set<RelaySession>();
    const upstreamSockets = new Set<WebSocket>();
    const inFlightServerFrames = new Set<Promise<void>>();
    let lifecycleTransactionTail = Promise.resolve();
    let activeFreshThreadSelection: ActiveFreshThreadSelection | null = null;
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
        // Codex may use multiple app-server connections during startup and an
        // in-TUI picker. Correlation remains connection-scoped below, while
        // selection adoption is serialized proxy-wide.

        const connection = Symbol('codex-tui-proxy-connection');
        const pendingSelections = new Map<JsonRpcId, PendingSelection>();
        const pendingFreshThreadTurns = new Map<JsonRpcId, PendingFreshThreadTurn>();
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
        let freshSelectionReleaseScheduled = false;

        const scheduleFreshSelectionRelease = (): void => {
            if (freshSelectionReleaseScheduled) {
                return;
            }
            freshSelectionReleaseScheduled = true;
            const release = lifecycleTransactionTail.then(() => {
                if (activeFreshThreadSelection?.connection === connection) {
                    activeFreshThreadSelection = null;
                }
            });
            lifecycleTransactionTail = release;
            trackServerFrame(release);
        };

        const resolveUpstreamReady = (ready: boolean): void => {
            if (upstreamReadySettled) {
                return;
            }
            upstreamReadySettled = true;
            settleUpstreamReady(ready);
        };

        const detachSession = (session: RelaySession): void => {
            sessions.delete(session);
        };
        const session: RelaySession = {
            close(): void {
                if (sessionClosed) {
                    return;
                }
                sessionClosed = true;
                pendingSelections.clear();
                pendingFreshThreadTurns.clear();
                scheduleFreshSelectionRelease();
                resolveUpstreamReady(false);
                detachSession(session);
                closeSocket(downstream);
                closeSocket(upstream);
            },
            terminate(): void {
                if (!sessionClosed) {
                    sessionClosed = true;
                    pendingSelections.clear();
                    pendingFreshThreadTurns.clear();
                    scheduleFreshSelectionRelease();
                    resolveUpstreamReady(false);
                    detachSession(session);
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
            trackFreshThreadTurnRequests(
                frame,
                pendingFreshThreadTurns,
                activeFreshThreadSelection,
                connection,
            );
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
            // cannot discard a response that has already arrived. Ownership
            // and fresh-thread event transactions are reserved here, in
            // server-frame observation order, before a connection FIFO waits.
            const correlatedEvents = consumeCorrelatedServerEvents(
                frame,
                pendingSelections,
                pendingFreshThreadTurns,
            );
            const priorConnectionTail = serverToClientTail;
            const forwardToTui = (outboundFrame: QueuedFrame): Promise<void> => (
                sendFrame(downstream, outboundFrame)
            );

            let task: Promise<void>;
            if (correlatedEvents.length === 0) {
                task = priorConnectionTail.then(() => forwardToTui(frame)).catch((error) => {
                    if (!sessionClosed && !proxyClosing) {
                        reportError(error, 'Failed to forward a Codex app-server message to the TUI');
                    }
                });
            } else {
                // Codex selects on a new main connection after the startup
                // picker, but uses the existing main connection after an
                // in-TUI picker. Every connection is therefore selection-
                // capable. Serialize selections, accepted root turns, and
                // fresh-thread events proxy-wide while retaining each
                // connection's FIFO and request-id namespace.
                const transaction = lifecycleTransactionTail.then(async () => {
                    await priorConnectionTail;
                    const failedSelectionIds = new Set<JsonRpcId>();
                    for (const correlated of correlatedEvents) {
                        if (correlated.type === 'selection') {
                            try {
                                await opts.onThreadSelected(correlated.selection);
                                activeFreshThreadSelection = correlated.selection.method === 'thread/start'
                                    && (opts.onThreadNotification || opts.onTurnAccepted)
                                    ? {
                                        connection,
                                        threadId: correlated.selection.threadId,
                                    }
                                    : null;
                            } catch (error) {
                                failedSelectionIds.add(correlated.id);
                                reportError(error, `Failed to adopt Codex thread ${correlated.selection.threadId}`);
                            }
                            continue;
                        }

                        const activeSelection = activeFreshThreadSelection;
                        if (
                            !activeSelection
                            || activeSelection.connection !== connection
                        ) {
                            continue;
                        }

                        if (correlated.type === 'turn-accepted') {
                            if (
                                correlated.turn.threadId !== activeSelection.threadId
                                || !opts.onTurnAccepted
                            ) {
                                continue;
                            }
                            try {
                                await opts.onTurnAccepted(correlated.turn);
                            } catch (error) {
                                reportError(error, `Failed to adopt Codex turn ${correlated.turn.turnId}`);
                            }
                            continue;
                        }

                        if (
                            correlated.notification.threadId !== activeSelection.threadId
                            || !opts.onThreadNotification
                        ) {
                            continue;
                        }
                        try {
                            await opts.onThreadNotification(correlated.notification);
                        } catch (error) {
                            reportError(
                                error,
                                `Failed to mirror ${correlated.notification.method} for ${correlated.notification.threadId}`,
                            );
                        }
                    }
                    await forwardToTui(replaceFailedSelectionResponses(frame, failedSelectionIds));
                });
                // Keep the internal tail fulfilled so one failed transaction
                // cannot poison later selections. The per-frame task still
                // reports the original unexpected failure before recovering.
                task = transaction.catch((error) => {
                    if (!sessionClosed && !proxyClosing) {
                        reportError(error, 'Failed to deliver a correlated Codex app-server frame to the TUI');
                    }
                });
                lifecycleTransactionTail = task;
            }
            serverToClientTail = task;
            trackServerFrame(task);
        });

        downstream.once('close', (code, reason) => {
            if (!sessionClosed) {
                sessionClosed = true;
                pendingSelections.clear();
                pendingFreshThreadTurns.clear();
                scheduleFreshSelectionRelease();
                resolveUpstreamReady(false);
                detachSession(session);
                closeSocket(upstream, code, reason);
            }
        });
        upstream.once('close', (code, reason) => {
            upstreamSockets.delete(upstream);
            if (!sessionClosed) {
                sessionClosed = true;
                pendingSelections.clear();
                pendingFreshThreadTurns.clear();
                scheduleFreshSelectionRelease();
                resolveUpstreamReady(false);
                detachSession(session);
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
                pendingFreshThreadTurns.clear();
                scheduleFreshSelectionRelease();
                detachSession(session);
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
