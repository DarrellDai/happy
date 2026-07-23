/**
 * Codex App Server Client — drives Codex via the v2 JSON-RPC protocol
 * (`codex app-server`), replacing the legacy MCP-based CodexMcpClient.
 *
 * Protocol: JSON-RPC 2.0 over stdio (newline-delimited JSON).
 * Reference: codex-rs/app-server/README.md in the openai/codex repo.
 *
 * WARNING: @openai/codex-sdk (v0.118.0) exists but only wraps `codex exec`
 * (non-interactive, fire-and-forget). It has NO support for `app-server`,
 * interactive approvals, or bidirectional JSON-RPC. We need app-server for
 * mobile approval routing (exec:request, patch:request, mcp:call), which is
 * why this client is hand-rolled. Re-evaluate if the SDK ever adds an
 * app-server wrapper or approval callbacks. See docs/plans/codex-app-server-migration.md.
 */

import { execSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { spawn as crossSpawn } from 'cross-spawn';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import WebSocket from 'ws';
import { logger } from '@/ui/logger';
import {
    signalPosixProcessDescendants,
    signalProcessIds,
    waitForProcessIdsToExit,
} from '@/utils/processTree';
import type {
    InitializeParams,
    NewConversationParams,
    NewConversationResponse,
    ResumeConversationParams,
    ResumeConversationResponse,
    InterruptConversationParams,
    SteerConversationParams,
    SteerConversationResponse,
    ReviewDecision,
    EventMsg,
    JsonRpcRequest,
    JsonRpcResponse,
    ApprovalPolicy,
    SandboxMode,
    InputItem,
    ReasoningEffort,
    McpServerElicitationRequestResponse,
} from './codexAppServerTypes';
import type { SandboxConfig } from '@/persistence';
import { initializeSandbox, wrapForMcpTransport } from '@/sandbox/manager';
import { ensureLocalProxyBypass } from '@/claude/utils/proxyBypass';
import packageJson from '../../package.json';

type PendingRequest = {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    method: string;
    epoch: number;
};

export type CodexAppServerTransport = 'stdio' | 'websocket';

export type CodexAppServerClientOptions = {
    transport?: CodexAppServerTransport;
    /**
     * Whether a root `thread/started` broadcast from another app-server
     * connection may become this client's active thread. Disable this when a
     * connection-scoped selector (such as Happy's native-TUI proxy) owns
     * thread selection.
     */
    adoptExternalRootThreads?: boolean;
};

export type ApprovalHandlingMode = 'active' | 'observer';

export function supportsSharedCodexAppServer(): boolean {
    try {
        const codexHelp = execSync('codex --help', { encoding: 'utf8', windowsHide: true });
        const appServerHelp = execSync('codex app-server --help', { encoding: 'utf8', windowsHide: true });
        return codexHelp.includes('--remote') && appServerHelp.includes('ws://');
    } catch {
        return false;
    }
}

export class CodexRpcError extends Error {
    constructor(
        public readonly method: string,
        public readonly code: number,
        message: string,
        public readonly data?: unknown,
    ) {
        super(`${method}: ${message} (code=${code})`);
        this.name = 'CodexRpcError';
    }
}

async function allocateLoopbackPort(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close(() => reject(new Error('Could not allocate a loopback port for Codex app-server.')));
                return;
            }
            const port = address.port;
            server.close((error) => {
                if (error) reject(error);
                else resolve(port);
            });
        });
    });
}

type LegacyPatchChanges = Record<string, Record<string, unknown>>;

export type ApprovalHandler = (params: {
    type: 'exec' | 'patch' | 'mcp';
    callId: string;
    command?: string[];
    cwd?: string;
    fileChanges?: Record<string, unknown>;
    reason?: string | null;
    toolName?: string;
    input?: unknown;
    serverName?: string;
    message?: string;
}) => Promise<ReviewDecision>;

/**
 * Check that `codex app-server` is available.
 */
function isAppServerAvailable(): boolean {
    try {
        const version = execSync('codex --version', { encoding: 'utf8', windowsHide: true }).trim();
        const match = version.match(/codex-cli\s+(\d+\.\d+\.\d+)/);
        if (!match) return false;
        const [, ver] = match;
        const [major, minor] = ver.split('.').map(Number);
        // app-server available in recent versions
        return major > 0 || minor >= 100;
    } catch {
        return false;
    }
}

function normalizeRawFileChangeList(changes: unknown): LegacyPatchChanges | undefined {
    if (!Array.isArray(changes)) {
        return undefined;
    }

    const normalized: LegacyPatchChanges = {};
    for (const change of changes) {
        if (!change || typeof change !== 'object' || Array.isArray(change)) {
            continue;
        }

        const path = typeof change.path === 'string' ? change.path : null;
        if (!path) {
            continue;
        }

        const entry: Record<string, unknown> = {};
        if (typeof change.diff === 'string') {
            entry.diff = change.diff;
        }
        if (change.kind && typeof change.kind === 'object' && !Array.isArray(change.kind)) {
            entry.kind = change.kind;
        }

        normalized[path] = entry;
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * Time budget for connectWebSocket() to wait for a freshly-spawned
 * `codex app-server` to begin accepting WebSocket connections.
 *
 * The app-server can be slow to bind its loopback port on a cold start — the
 * first launch after a reboot, a cold page cache, or bubblewrap/user-namespace
 * sandbox probing can each push the first successful connect past a few
 * seconds. The previous 5s budget was too tight for that case and surfaced as
 * a hard `Timed out connecting to Codex app-server … ECONNREFUSED` error.
 *
 * A genuinely crashed app-server still fails fast: connectWebSocket() checks
 * proc.exitCode / signalCode on each iteration and throws immediately on exit,
 * so a larger budget only extends the wait for the alive-but-not-yet-listening
 * (slow-start) case — never for an outright failure.
 *
 * Override with HAPPY_CODEX_APP_SERVER_CONNECT_TIMEOUT_MS (positive integer ms).
 */
const APP_SERVER_CONNECT_TIMEOUT_MS = ((): number => {
    const raw = process.env.HAPPY_CODEX_APP_SERVER_CONNECT_TIMEOUT_MS;
    const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
})();

export class CodexAppServerClient {
    private process: ChildProcess | null = null;
    private socket: WebSocket | null = null;
    private _remoteEndpoint: string | null = null;
    private disconnectWaitPromise: Promise<void> | null = null;
    private terminalDisconnectRequested = false;
    private processDescendantPids = new WeakMap<ChildProcess, Set<number>>();
    private readline: ReadlineInterface | null = null;
    private nextId = 1;
    private pending = new Map<number, PendingRequest>();
    private processEpoch = 0;
    private connected = false;
    private sandboxConfig?: SandboxConfig;
    private sandboxCleanup: (() => Promise<void>) | null = null;
    public sandboxEnabled = false;

    // Session state
    private _threadId: string | null = null;
    private _turnId: string | null = null;
    private threadDefaults: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    } | null = null;

    // Turn completion tracking for the currently active sendTurnAndWait call.
    // A completion event only resolves once we have seen task_started for this turn.
    private pendingTurnCompletion: {
        resolve: (aborted: boolean) => void;
        turnId: string | null;
    } | null = null;

    // Tracks in-flight interruptTurn() RPCs so sendTurnAndWait can wait for them
    // before starting a new turn (prevents stale turn/interrupt from aborting the next turn).
    private pendingInterrupt: Promise<void> | null = null;
    private notificationProtocol: 'unknown' | 'legacy' | 'raw' = 'unknown';
    private completedTurnIds = new Set<string>();
    private rawStartedTurnIds = new Set<string>();
    private rawFileChangesByItemId = new Map<string, LegacyPatchChanges>();
    private rawUserMessageItemIds = new Set<string>();
    private proxiedTurnId: string | null = null;
    private turnIdleWaiters = new Set<() => void>();

    // Handlers set by the consumer (runCodex.ts)
    private eventHandler: ((msg: EventMsg) => void) | null = null;
    private approvalHandler: ApprovalHandler | null = null;
    private approvalHandlingMode: ApprovalHandlingMode = 'active';
    private deferredApprovalRequests = new Map<number | string, { method: string; params: any }>();
    private approvalOwnershipEpoch = 0;
    private inFlightServerRequests = new Map<number | string, number>();
    private externallyResolvedServerRequests = new Set<number | string>();
    private websocketRecoveryPromise: Promise<void> | null = null;

    constructor(
        sandboxConfig?: SandboxConfig,
        private readonly options: CodexAppServerClientOptions = {},
    ) {
        this.sandboxConfig = sandboxConfig;
    }

    get threadId(): string | null {
        return this._threadId;
    }

    get turnId(): string | null {
        return this._turnId;
    }

    get remoteEndpoint(): string | null {
        return this._remoteEndpoint;
    }

    setEventHandler(handler: (msg: EventMsg) => void): void {
        this.eventHandler = handler;
    }

    setApprovalHandler(handler: ApprovalHandler): void {
        this.approvalHandler = handler;
        if (this.approvalHandlingMode === 'active') {
            setTimeout(() => this.drainDeferredApprovalRequests(), 0);
        }
    }

    setApprovalHandlingMode(mode: ApprovalHandlingMode): void {
        if (this.approvalHandlingMode === mode) return;
        this.approvalHandlingMode = mode;
        this.approvalOwnershipEpoch += 1;
        // Give any serverRequest/resolved notification already queued by the
        // departing TUI one event-loop turn to remove its request before Happy
        // assumes ownership.
        if (mode === 'active') {
            setTimeout(() => this.drainDeferredApprovalRequests(), 0);
        }
    }

    private drainDeferredApprovalRequests(): void {
        if (
            this.approvalHandlingMode !== 'active'
            || !this.approvalHandler
            || this.deferredApprovalRequests.size === 0
        ) return;

        const deferred = Array.from(this.deferredApprovalRequests.entries());
        this.deferredApprovalRequests.clear();
        for (const [id, request] of deferred) {
            void this.dispatchServerRequest(id, request.method, request.params).catch((error) => {
                logger.debug('[CodexAppServer] Error handling deferred approval request:', error);
            });
        }
    }

    private isApprovalRequestMethod(method: string): boolean {
        return method === 'mcpServer/elicitation/request'
            || method === 'item/commandExecution/requestApproval'
            || method === 'execCommandApproval'
            || method === 'item/fileChange/requestApproval'
            || method === 'applyPatchApproval'
            || method === 'item/permissions/requestApproval'
            || method === 'item/tool/requestUserInput';
    }

    private extractTurnId(params: any): string | null {
        const turnId = params?.turn?.id ?? params?.turnId ?? params?.turn_id ?? null;
        return typeof turnId === 'string' && turnId.length > 0 ? turnId : null;
    }

    private extractTurnStatus(params: any): string | null {
        const status = params?.turn?.status ?? params?.status ?? null;
        return typeof status === 'string' && status.length > 0 ? status : null;
    }

    private emitRawUserMessage(item: any): void {
        if (
            !item
            || typeof item !== 'object'
            || item.type !== 'userMessage'
            || typeof item.id !== 'string'
            || this.rawUserMessageItemIds.has(item.id)
        ) {
            return;
        }
        const content = Array.isArray(item.content) ? item.content : [];
        const text = content
            .filter((input: unknown): input is { type: 'text'; text: string } => (
                !!input
                && typeof input === 'object'
                && (input as { type?: unknown }).type === 'text'
                && typeof (input as { text?: unknown }).text === 'string'
            ))
            .map((input: { type: 'text'; text: string }) => input.text)
            .join('\n');
        this.rawUserMessageItemIds.add(item.id);
        if (text.length > 0) {
            this.eventHandler?.({
                type: 'user_message',
                message: text,
                item_id: item.id,
                ...(typeof item.clientId === 'string' ? { client_id: item.clientId } : {}),
            });
        }
    }

    private emitRawTaskStarted(turnId: string | null): void {
        if (turnId) {
            this._turnId = turnId;
            this.markPendingTurnStarted(turnId);
            if (this.rawStartedTurnIds.has(turnId)) {
                return;
            }
            this.rawStartedTurnIds.add(turnId);
        }
        this.eventHandler?.({
            type: 'task_started',
            ...(turnId ? { turn_id: turnId } : {}),
        });
    }

    private emitActiveTurnSnapshot(thread: unknown): void {
        const turns = (thread as { turns?: unknown } | null)?.turns;
        if (!Array.isArray(turns)) {
            return;
        }
        const activeTurn = [...turns].reverse().find((turn) => (
            turn
            && typeof turn === 'object'
            && (turn as { status?: unknown }).status === 'inProgress'
            && typeof (turn as { id?: unknown }).id === 'string'
        )) as { id: string; items?: unknown[] } | undefined;
        if (!activeTurn) {
            return;
        }
        for (const item of Array.isArray(activeTurn.items) ? activeTurn.items : []) {
            this.emitRawUserMessage(item);
        }
        this.emitRawTaskStarted(activeTurn.id);
    }

    private isRawNotificationMethod(method: string): boolean {
        return method === 'thread/started'
            || method === 'turn/started'
            || method === 'turn/completed'
            || method === 'thread/status/changed'
            || method === 'thread/tokenUsage/updated'
            || method.startsWith('item/');
    }

    private shouldHandleRawNotification(method: string): boolean {
        const isRawNotification = this.isRawNotificationMethod(method);

        if (!isRawNotification) {
            return false;
        }

        if (this.notificationProtocol === 'legacy') {
            return false;
        }

        if (this.notificationProtocol === 'unknown') {
            this.notificationProtocol = 'raw';
        }

        return true;
    }

    private emitRawTurnCompletion(
        turnId: string | null,
        status: string | null,
        error: unknown,
        source: string,
    ): void {
        const aborted = status === 'cancelled' || status === 'canceled' || status === 'aborted' || status === 'interrupted';

        if (this.isStaleTurnCompletion(turnId, source)) {
            return;
        }

        this.tryResolvePendingTurn(aborted, turnId, source);
        this.clearActiveTurn(turnId);

        if (turnId && this.completedTurnIds.has(turnId)) {
            return;
        }
        if (turnId) {
            this.completedTurnIds.add(turnId);
        }

        if (aborted) {
            this.eventHandler?.({
                type: 'turn_aborted',
                ...(turnId ? { turn_id: turnId } : {}),
                ...(status ? { status } : {}),
                ...(error !== undefined && error !== null ? { error } : {}),
            });
            return;
        }

        this.eventHandler?.({
            type: 'task_complete',
            ...(turnId ? { turn_id: turnId } : {}),
            ...(status ? { status } : {}),
            ...(error !== undefined && error !== null ? { error } : {}),
        });
    }

    private isStaleTurnCompletion(turnId: string | null, source: string): boolean {
        if (turnId && this._turnId && turnId !== this._turnId) {
            logger.debug(
                `[CodexAppServer] Ignoring stale ${source} for ${turnId}; active turn is ${this._turnId}`,
            );
            return true;
        }
        return false;
    }

    private clearActiveTurn(turnId: string | null): void {
        if (turnId && this._turnId && turnId !== this._turnId) {
            logger.debug(`[CodexAppServer] Ignoring stale completion for ${turnId}; active turn is ${this._turnId}`);
            return;
        }
        this._turnId = null;
        if (!turnId || this.proxiedTurnId === turnId) {
            this.proxiedTurnId = null;
        }
        for (const resolve of this.turnIdleWaiters) resolve();
        this.turnIdleWaiters.clear();
    }

    private handleRawNotification(method: string, params: any, force: boolean = false): boolean {
        if (
            force
                ? !this.isRawNotificationMethod(method)
                : !this.shouldHandleRawNotification(method)
        ) {
            return false;
        }
        if (force && this.notificationProtocol === 'unknown') {
            this.notificationProtocol = 'raw';
        }

        if (method === 'thread/started') {
            const threadId = params?.thread?.id ?? params?.threadId ?? null;
            const parentThreadId = params?.thread?.parentThreadId ?? null;
            if (
                this.options.adoptExternalRootThreads !== false
                && !this._threadId
                && parentThreadId == null
                && typeof threadId === 'string'
                && threadId.length > 0
            ) {
                this._threadId = threadId;
                this.eventHandler?.({
                    type: 'thread_started',
                    thread_id: threadId,
                });
            } else if (threadId && threadId !== this._threadId) {
                logger.debug(`[CodexAppServer] Ignoring non-owned thread start ${threadId}`);
            }
            return true;
        }

        const notificationThreadId = params?.threadId ?? params?.thread_id ?? null;
        if (
            this.options.adoptExternalRootThreads === false
            && !this._threadId
            && typeof notificationThreadId === 'string'
        ) {
            logger.debug(
                `[CodexAppServer] Ignoring ${method} before connection-scoped thread selection (${notificationThreadId})`,
            );
            return true;
        }
        if (
            this._threadId
            && typeof notificationThreadId === 'string'
            && notificationThreadId !== this._threadId
        ) {
            logger.debug(
                `[CodexAppServer] Ignoring ${method} for non-owned thread ${notificationThreadId}; root is ${this._threadId}`,
            );
            return true;
        }

        if (method === 'turn/started') {
            const turnId = this.extractTurnId(params);
            const turnItems = Array.isArray(params?.turn?.items) ? params.turn.items : [];
            for (const item of turnItems) {
                this.emitRawUserMessage(item);
            }
            this.emitRawTaskStarted(turnId);
            return true;
        }

        if (method === 'turn/completed') {
            this.emitRawTurnCompletion(
                this.extractTurnId(params),
                this.extractTurnStatus(params),
                params?.turn?.error ?? params?.error,
                method,
            );
            return true;
        }

        if (method === 'thread/status/changed') {
            const statusType = params?.status?.type;
            if (statusType === 'active' && this._threadId) {
                this.eventHandler?.({
                    type: 'thread_active',
                    thread_id: this._threadId,
                });
            }
            if (
                statusType === 'idle'
                && this._turnId
                && this._turnId !== this.proxiedTurnId
            ) {
                this.emitRawTurnCompletion(this._turnId, 'completed', null, method);
            }
            return true;
        }

        if (method === 'thread/tokenUsage/updated') {
            const tokenUsage = params?.tokenUsage;
            if (tokenUsage && typeof tokenUsage === 'object') {
                this.eventHandler?.({
                    type: 'token_count',
                    ...tokenUsage,
                });
            }
            return true;
        }

        const item = params?.item;
        if (!item || typeof item !== 'object') {
            return method.startsWith('item/');
        }

        if (item.type === 'userMessage') {
            this.emitRawUserMessage(item);
            return true;
        }

        if (method === 'item/started' && item.type === 'commandExecution') {
            const callId = typeof item.id === 'string' ? item.id : '';
            this.eventHandler?.({
                type: 'exec_command_begin',
                call_id: callId,
                callId,
                command: item.command,
                cwd: item.cwd,
                description: item.command,
            });
            return true;
        }

        if (method === 'item/completed' && item.type === 'commandExecution') {
            const callId = typeof item.id === 'string' ? item.id : '';
            this.eventHandler?.({
                type: 'exec_command_end',
                call_id: callId,
                callId,
                output: item.aggregatedOutput ?? '',
                exit_code: item.exitCode ?? null,
                duration_ms: item.durationMs ?? null,
                status: item.status,
                cwd: item.cwd,
                command: item.command,
            });
            return true;
        }

        if (item.type === 'fileChange') {
            const callId = typeof item.id === 'string' ? item.id : '';
            const changes = normalizeRawFileChangeList(item.changes);

            if (callId && changes) {
                this.rawFileChangesByItemId.set(callId, changes);
            }

            if (method === 'item/started') {
                this.eventHandler?.({
                    type: 'patch_apply_begin',
                    call_id: callId,
                    callId,
                    changes: changes ?? {},
                });
                return true;
            }

            if (method === 'item/completed') {
                this.eventHandler?.({
                    type: 'patch_apply_end',
                    call_id: callId,
                    callId,
                    status: item.status,
                });

                if (callId && (item.status === 'completed' || item.status === 'failed' || item.status === 'declined')) {
                    this.rawFileChangesByItemId.delete(callId);
                }
                return true;
            }
        }

        if (method === 'item/completed' && item.type === 'agentMessage') {
            const text = typeof item.text === 'string' ? item.text : '';
            if (text.length > 0) {
                this.eventHandler?.({
                    type: 'agent_message',
                    message: text,
                    item_id: item.id,
                    phase: item.phase,
                });
            }

            if (item.phase === 'final_answer' && this.pendingTurnCompletion) {
                this.emitRawTurnCompletion(
                    this.extractTurnId(params),
                    'completed',
                    null,
                    `${method}:final_answer`,
                );
            }
            return true;
        }

        return method.startsWith('item/');
    }

    // ─── Lifecycle ──────────────────────────────────────────────

    async connect(): Promise<void> {
        if (this.connected) return;

        if (!isAppServerAvailable()) {
            throw new Error(
                'Codex CLI is not installed\n\n' +
                'Please install Codex CLI using one of these methods:\n\n' +
                'Option 1 - npm (recommended):\n  npm install -g @openai/codex\n\n' +
                'Option 2 - Homebrew (macOS):\n  brew install --cask codex\n\n' +
                'Alternatively, use Claude Code:\n  happy claude',
            );
        }

        const transport = this.options.transport ?? 'stdio';
        this._remoteEndpoint = transport === 'websocket'
            ? `ws://127.0.0.1:${await allocateLoopbackPort()}`
            : null;
        const listener = this._remoteEndpoint ?? 'stdio://';
        const nativeArgs = ['app-server', '--listen', listener];
        let command = 'codex';
        let args = nativeArgs;
        this.sandboxEnabled = false;

        if (this.sandboxConfig?.enabled && process.platform !== 'win32') {
            try {
                this.sandboxCleanup = await initializeSandbox(this.sandboxConfig, process.cwd());
                const wrapped = await wrapForMcpTransport('codex', nativeArgs);
                command = wrapped.command;
                // Replace the transport shell so lifecycle signals target the
                // sandbox owner instead of leaving it alive as a descendant.
                args = ['-c', `exec ${wrapped.args[1]}`];
                this.sandboxEnabled = true;
                logger.info(`[CodexAppServer] Sandbox enabled`);
            } catch (error) {
                logger.warn('[CodexAppServer] Failed to initialize sandbox; continuing without.', error);
                this.sandboxCleanup = null;
            }
        }

        // Build env — same filtering as the old MCP client
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (typeof value === 'string') env[key] = value;
        }
        ensureLocalProxyBypass(env);
        // Mute noisy rollout list logging
        const filter = 'codex_core::rollout::list=off';
        if (!env.RUST_LOG) {
            env.RUST_LOG = filter;
        } else if (!env.RUST_LOG.includes('codex_core::rollout::list=')) {
            env.RUST_LOG += `,${filter}`;
        }
        if (this.sandboxEnabled) {
            env.CODEX_SANDBOX = 'seatbelt';
        }

        logger.debug(`[CodexAppServer] Spawning: ${command} ${args.join(' ')}`);

        const epoch = ++this.processEpoch;
        // Use cross-spawn so npm-installed wrappers (codex.cmd / codex.ps1) resolve on Windows.
        // Native child_process.spawn fails with ENOENT for .cmd shims (issues #980, #1016).
        const proc = crossSpawn(command, args, {
            stdio: transport === 'websocket'
                ? ['ignore', 'pipe', 'pipe']
                : ['pipe', 'pipe', 'pipe'],
            env,
            windowsHide: true,
        });
        this.process = proc;

        proc.on('error', (err) => {
            logger.debug('[CodexAppServer] Process error:', err);
        });

        proc.on('exit', (code, signal) => {
            logger.debug(`[CodexAppServer] Process exited: code=${code} signal=${signal}`);
            // Ignore stale process exits from prior generations during reconnect.
            if (this.process !== proc || this.processEpoch !== epoch) {
                logger.debug('[CodexAppServer] Ignoring stale process exit');
                return;
            }
            this.connected = false;
            // Reject all pending requests
            for (const [id, req] of this.pending) {
                if (req.epoch !== epoch) continue;
                req.reject(new Error(`Codex process exited (code=${code}) while waiting for ${req.method}`));
                this.pending.delete(id);
            }
            // Resolve pending turn completion (treat as abort)
            this.resolvePendingTurn(true);
            this.clearActiveTurn(null);
        });

        // Pipe stderr for debug logging
        proc.stderr?.on('data', (chunk: Buffer) => {
            if (this.process !== proc || this.processEpoch !== epoch) return;
            const text = chunk.toString().trim();
            if (text) logger.debug(`[CodexAppServer:stderr] ${text}`);
        });

        try {
            if (transport === 'websocket') {
                proc.stdout?.on('data', (chunk: Buffer) => {
                    if (this.process !== proc || this.processEpoch !== epoch) return;
                    const text = chunk.toString().trim();
                    if (text) logger.debug(`[CodexAppServer:stdout] ${text}`);
                });
                await this.connectWebSocket(listener, proc, epoch);
            } else {
                // Parse newline-delimited JSON from stdout.
                this.readline = createInterface({ input: proc.stdout! });
                this.readline.on('line', (line) => {
                    if (this.process !== proc || this.processEpoch !== epoch) return;
                    this.handleLine(line, epoch);
                });
            }

            await this.initializeRpcConnection();
            logger.debug('[CodexAppServer] Connected and initialized');
        } catch (error) {
            logger.debug('[CodexAppServer] Startup failed; reaping app-server', error);
            try {
                await this.disconnectAndWait(1_000, {
                    preserveThreadState: true,
                    allowReconnect: true,
                });
            } catch (cleanupError) {
                logger.debug('[CodexAppServer] Startup cleanup failed', cleanupError);
            }
            throw error;
        }
    }

    private async initializeRpcConnection(): Promise<void> {
        const initParams: InitializeParams = {
            clientInfo: {
                name: 'happy-codex',
                title: 'Happy Codex Client',
                version: packageJson.version,
            },
            capabilities: {
                experimentalApi: true,
            },
        };
        await this.request('initialize', initParams);
        this.notify('initialized');
        this.connected = true;
    }

    private async connectWebSocket(endpoint: string, proc: ChildProcess, epoch: number): Promise<void> {
        const deadline = Date.now() + APP_SERVER_CONNECT_TIMEOUT_MS;
        let lastError: Error | null = null;

        while (Date.now() < deadline) {
            if (this.process !== proc || this.processEpoch !== epoch) {
                throw new Error('Codex app-server changed while opening its WebSocket transport.');
            }
            if (typeof proc.exitCode === 'number' || (proc.signalCode !== null && proc.signalCode !== undefined)) {
                throw new Error(`Codex app-server exited before accepting WebSocket connections at ${endpoint}.`);
            }

            try {
                const socket = await new Promise<WebSocket>((resolve, reject) => {
                    const candidate = new WebSocket(endpoint, { handshakeTimeout: 250 });
                    const onOpen = (): void => {
                        candidate.removeListener('error', onError);
                        resolve(candidate);
                    };
                    const onError = (error: Error): void => {
                        candidate.removeListener('open', onOpen);
                        try { candidate.terminate(); } catch { }
                        reject(error);
                    };
                    candidate.once('open', onOpen);
                    candidate.once('error', onError);
                });

                if (this.process !== proc || this.processEpoch !== epoch) {
                    socket.terminate();
                    throw new Error('Codex app-server changed while opening its WebSocket transport.');
                }

                this.socket = socket;
                socket.on('message', (data) => {
                    if (this.socket !== socket || this.process !== proc || this.processEpoch !== epoch) return;
                    this.handleLine(data.toString(), epoch);
                });
                socket.on('error', (error) => {
                    if (this.socket === socket) {
                        logger.debug('[CodexAppServer] WebSocket error:', error);
                    }
                });
                socket.on('close', () => {
                    if (this.socket !== socket || this.process !== proc || this.processEpoch !== epoch) return;
                    const shouldRecover = this.connected && !this.terminalDisconnectRequested;
                    this.socket = null;
                    this.connected = false;
                    for (const [id, request] of this.pending) {
                        if (request.epoch !== epoch) continue;
                        request.reject(new Error(`Codex WebSocket closed while waiting for ${request.method}`));
                        this.pending.delete(id);
                    }
                    if (shouldRecover) {
                        void this.recoverWebSocket(endpoint, proc, epoch);
                    }
                });
                return;
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        }

        throw new Error(`Timed out connecting to Codex app-server at ${endpoint} after ${APP_SERVER_CONNECT_TIMEOUT_MS}ms: ${lastError?.message ?? 'unknown error'}`);
    }

    private async recoverWebSocket(endpoint: string, proc: ChildProcess, epoch: number): Promise<void> {
        if (this.websocketRecoveryPromise) {
            return this.websocketRecoveryPromise;
        }

        const operation = (async () => {
            const threadId = this._threadId;
            try {
                logger.debug(`[CodexAppServer] Reconnecting WebSocket transport at ${endpoint}`);
                await this.connectWebSocket(endpoint, proc, epoch);
                await this.initializeRpcConnection();
                if (threadId) {
                    await this.resumeThread({ threadId });
                }
                logger.debug('[CodexAppServer] WebSocket transport recovered');
            } catch (error) {
                logger.warn('[CodexAppServer] WebSocket recovery failed; stopping owned app-server', error);
                try {
                    await this.disconnectAndWait(1_000, {
                        preserveThreadState: true,
                        allowReconnect: true,
                    });
                } finally {
                    this.resolvePendingTurn(true);
                    this.clearActiveTurn(null);
                }
            }
        })();
        this.websocketRecoveryPromise = operation;
        try {
            await operation;
        } finally {
            if (this.websocketRecoveryPromise === operation) {
                this.websocketRecoveryPromise = null;
            }
        }
    }

    private async disconnectInternal(opts?: { preserveThreadState?: boolean }): Promise<void> {
        if (!this.connected && !this.process && !this.socket) return;

        const proc = this.process;
        const pid = proc?.pid;
        const epoch = this.processEpoch;
        logger.debug(`[CodexAppServer] Disconnecting; pid=${pid ?? 'none'}`);

        this.readline?.close();
        this.readline = null;
        const socket = this.socket;
        this.socket = null;
        if (socket) {
            try {
                socket.close();
            } catch {
                try { socket.terminate(); } catch { }
            }
        }

        // Force kill after 2s (unref so timer doesn't block process exit).
        // Install exit listeners before SIGTERM so even a very fast exit clears
        // the timer before the pid could be reused.
        if (
            proc &&
            typeof proc.exitCode !== 'number' &&
            (proc.signalCode === null || proc.signalCode === undefined)
        ) {
            const killTimer = setTimeout(() => {
                try {
                    this.terminateProcessTree(proc, 'SIGKILL');
                } catch { /* already dead */ }
            }, 2000);
            killTimer.unref();
            const clearKillTimer = (): void => clearTimeout(killTimer);
            proc.once('exit', clearKillTimer);
            proc.once('close', clearKillTimer);
        }

        try {
            proc?.stdin?.end();
            if (proc) this.terminateProcessTree(proc, 'SIGTERM');
        } catch { /* ignore */ }

        this.process = null;
        this.connected = false;
        this._remoteEndpoint = null;
        this.clearActiveTurn(null);
        this.notificationProtocol = 'unknown';
        this.completedTurnIds.clear();
        this.deferredApprovalRequests.clear();
        if (!opts?.preserveThreadState) {
            this._threadId = null;
            this.threadDefaults = null;
            this.rawStartedTurnIds.clear();
            this.rawUserMessageItemIds.clear();
            this.rawFileChangesByItemId.clear();
        }

        // Fail in-flight requests from this process generation.
        for (const [id, req] of this.pending) {
            if (req.epoch !== epoch) continue;
            req.reject(new Error(`Codex process disconnected while waiting for ${req.method}`));
            this.pending.delete(id);
        }

        // Resolve pending turn completion (treat as abort)
        this.resolvePendingTurn(true);

        if (this.sandboxCleanup) {
            try { await this.sandboxCleanup(); } catch { /* ignore */ }
            this.sandboxCleanup = null;
        }
        this.sandboxEnabled = false;

        logger.debug('[CodexAppServer] Disconnected');
    }

    async disconnect(): Promise<void> {
        await this.disconnectInternal();
    }

    /**
     * Disconnect and wait until the owned app-server process is fully reaped.
     * Mode handoff must not resume the same thread in the native TUI while the
     * previous app-server still owns it.
     */
    async disconnectAndWait(
        timeoutMs: number = 3_000,
        opts?: { preserveThreadState?: boolean; allowReconnect?: boolean },
    ): Promise<void> {
        if (!opts?.allowReconnect) {
            this.terminalDisconnectRequested = true;
        }
        if (this.disconnectWaitPromise) {
            // A full disconnect is stronger than a state-preserving restart.
            // Apply it even when this caller joins an existing reaper.
            if (!opts?.preserveThreadState) {
                this._threadId = null;
                this.threadDefaults = null;
            }
            return this.disconnectWaitPromise;
        }

        const operation = this.disconnectAndWaitOnce(timeoutMs, opts);
        this.disconnectWaitPromise = operation;
        try {
            await operation;
        } finally {
            if (this.disconnectWaitPromise === operation) {
                this.disconnectWaitPromise = null;
            }
        }
    }

    private async disconnectAndWaitOnce(
        timeoutMs: number,
        opts?: { preserveThreadState?: boolean; allowReconnect?: boolean },
    ): Promise<void> {
        const proc = this.process;
        if (!proc) {
            await this.disconnectInternal(opts);
            return;
        }

        let resolveExit!: () => void;
        const exited = new Promise<void>((resolve) => {
            resolveExit = resolve;
            if (typeof proc.exitCode === 'number' || (proc.signalCode !== null && proc.signalCode !== undefined)) {
                resolve();
                return;
            }
            proc.once('exit', resolve);
            proc.once('close', resolve);
        });

        await this.disconnectInternal(opts);

        const wait = async (ms: number): Promise<boolean> => {
            let timer: NodeJS.Timeout | null = null;
            const timedOut = new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), ms);
            });
            const didExit = await Promise.race([
                exited.then(() => true),
                timedOut,
            ]);
            if (timer) clearTimeout(timer);
            return didExit;
        };

        if (await wait(timeoutMs)) {
            await this.ensureProcessDescendantsExited(proc);
            return;
        }

        try {
            this.terminateProcessTree(proc, 'SIGKILL');
        } catch {
            // The process may have exited between the timeout and this call.
        }
        if (!(await wait(1_000))) {
            // Release listeners retained by the local promise before failing.
            resolveExit();
            throw new Error(`Codex app-server did not exit after ${timeoutMs + 1_000}ms`);
        }
        await this.ensureProcessDescendantsExited(proc);
    }

    private async ensureProcessDescendantsExited(proc: ChildProcess): Promise<void> {
        const knownDescendants = this.processDescendantPids.get(proc);
        if (!knownDescendants || knownDescendants.size === 0 || process.platform === 'win32') {
            return;
        }

        let remaining = await waitForProcessIdsToExit(knownDescendants, 50);
        if (remaining.length > 0) {
            signalProcessIds(remaining, 'SIGKILL');
            remaining = await waitForProcessIdsToExit(remaining, 1_000);
        }
        this.processDescendantPids.delete(proc);
        if (remaining.length > 0) {
            throw new Error(`Codex app-server descendants did not exit: ${remaining.join(', ')}`);
        }
    }

    private terminateProcessTree(proc: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
        if (process.platform !== 'win32') {
            if (typeof proc.pid === 'number') {
                const knownDescendants = this.processDescendantPids.get(proc) ?? new Set<number>();
                for (const pid of signalPosixProcessDescendants(proc.pid, signal)) {
                    knownDescendants.add(pid);
                }
                this.processDescendantPids.set(proc, knownDescendants);
                if (signal === 'SIGKILL') {
                    signalProcessIds(knownDescendants, 'SIGKILL');
                }
            }
            proc.kill(signal);
            return;
        }

        if (typeof proc.pid !== 'number') {
            proc.kill(signal);
            return;
        }

        // npm-installed Codex resolves through a cmd.exe shim on Windows. Kill
        // its complete tree so the native app-server cannot survive the shim.
        try {
            const killer = crossSpawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
                stdio: 'ignore',
                windowsHide: true,
            });
            killer.once('error', () => {
                try { proc.kill('SIGKILL'); } catch { /* already dead */ }
            });
        } catch {
            proc.kill('SIGKILL');
        }
    }

    private buildThreadConfig(mcpServers?: Record<string, unknown>): Record<string, unknown> | null {
        return mcpServers ? { mcp_servers: mcpServers } : null;
    }

    private rememberThreadDefaults(opts: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    }): void {
        this.threadDefaults = {
            model: opts.model,
            cwd: opts.cwd,
            approvalPolicy: opts.approvalPolicy,
            sandbox: opts.sandbox,
            mcpServers: opts.mcpServers,
        };
    }

    private reconcileTurnStateFromThread(thread: unknown, previousTurnId: string | null): void {
        const turns = (thread as { turns?: unknown } | null)?.turns;
        if (!Array.isArray(turns) || turns.length === 0) {
            this._turnId = previousTurnId;
            return;
        }

        const activeTurn = [...turns].reverse().find((turn) => (
            turn
            && typeof turn === 'object'
            && (turn as { status?: unknown }).status === 'inProgress'
            && typeof (turn as { id?: unknown }).id === 'string'
        )) as { id: string } | undefined;

        const completedPreviousTurn = previousTurnId
            ? turns.find((turn) => (
                turn
                && typeof turn === 'object'
                && (turn as { id?: unknown }).id === previousTurnId
            )) as { id?: string; status?: string; error?: unknown } | undefined
            : undefined;

        if (activeTurn) {
            if (completedPreviousTurn?.id && completedPreviousTurn.id !== activeTurn.id) {
                this.emitRawTurnCompletion(
                    completedPreviousTurn.id,
                    completedPreviousTurn.status ?? 'completed',
                    completedPreviousTurn.error,
                    'thread snapshot',
                );
            }
            this._turnId = activeTurn.id;
            this.markPendingTurnStarted(activeTurn.id);
            return;
        }

        if (completedPreviousTurn?.id) {
            this.emitRawTurnCompletion(
                completedPreviousTurn.id,
                completedPreviousTurn.status ?? 'completed',
                completedPreviousTurn.error,
                'thread snapshot',
            );
            return;
        }

        this.clearActiveTurn(previousTurnId);
        this.resolvePendingTurn(true);
    }

    // ─── Thread management ──────────────────────────────────────

    /**
     * Adopt a root selected through a connection-scoped transport signal.
     * This is used for a brand-new TUI thread, which has no persisted rollout
     * yet and therefore cannot be resumed from a second connection.
     */
    adoptThreadSelection(threadId: string, activeTurnId?: string): void {
        if (!threadId) {
            throw new Error('Cannot adopt an empty Codex thread id.');
        }
        this._threadId = threadId;
        this._turnId = activeTurnId ?? null;
        this.proxiedTurnId = null;
        if (activeTurnId) {
            this.markPendingTurnStarted(activeTurnId);
        }
        logger.debug('[CodexAppServer] Adopted connection-scoped thread:', threadId);
    }

    /**
     * Seed a turn accepted by the selected TUI connection. Codex may omit the
     * matching `turn/started` notification for a fast turn, so the correlated
     * response is the authoritative fallback identity.
     */
    adoptThreadTurn(threadId: string, turnId: string): boolean {
        if (!threadId || !turnId || this._threadId !== threadId) {
            logger.debug(
                `[CodexAppServer] Ignoring adopted turn ${turnId || '<empty>'} for non-owned thread ${threadId || '<empty>'}`,
            );
            return false;
        }
        this.proxiedTurnId = turnId;
        this.emitRawTaskStarted(turnId);
        return true;
    }

    /**
     * Ingest a typed notification from the selected fresh TUI connection.
     * Only explicit, owned-root turn/item notifications are accepted; global
     * status broadcasts cannot synthesize a completion through this seam.
     */
    ingestThreadNotification(notification: {
        threadId: string;
        method: string;
        params: Record<string, unknown>;
    }): boolean {
        const { threadId, method, params } = notification;
        const lifecycleTurnId = method === 'turn/started' || method === 'turn/completed'
            ? (params.turn as { id?: unknown } | null | undefined)?.id
            : null;
        if (
            this._threadId !== threadId
            || params.threadId !== threadId
            || (
                (method === 'turn/started' || method === 'turn/completed')
                && (typeof lifecycleTurnId !== 'string' || lifecycleTurnId.length === 0)
            )
            || !(
                method === 'turn/started'
                || method === 'turn/completed'
                || method === 'thread/tokenUsage/updated'
                || method.startsWith('item/')
            )
        ) {
            logger.debug(`[CodexAppServer] Ignoring proxied ${method} for non-owned thread ${threadId}`);
            return false;
        }
        const handled = this.handleRawNotification(method, params, true);
        if (handled) {
            logger.debug(`[CodexAppServer] Proxied fresh-thread notification: ${method}`);
        }
        return handled;
    }

    async startThread(opts: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    }): Promise<{ threadId: string; model: string }> {
        const params: NewConversationParams = {
            model: opts.model ?? null,
            modelProvider: null,
            profile: null,
            cwd: opts.cwd ?? process.cwd(),
            approvalPolicy: opts.approvalPolicy ?? null,
            sandbox: opts.sandbox ?? null,
            config: this.buildThreadConfig(opts.mcpServers),
            baseInstructions: null,
            developerInstructions: null,
            compactPrompt: null,
            includeApplyPatchTool: null,
            experimentalRawEvents: false,
            persistExtendedHistory: true,
        };

        const result = await this.request('thread/start', params) as NewConversationResponse;
        this._threadId = result.thread.id;
        this._turnId = null;
        this.proxiedTurnId = null;
        this.rememberThreadDefaults(opts);
        logger.debug('[CodexAppServer] Thread started:', this._threadId);
        return { threadId: result.thread.id, model: result.model };
    }

    async resumeThread(opts?: {
        threadId?: string;
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
        emitActiveTurnSnapshot?: boolean;
        /** Turn observed active by the selecting client before this connection resumed it. */
        expectedActiveTurnId?: string;
        /** Runs after a successful server response but before ownership and replayed events change. */
        beforeEventReplay?: () => void;
    }): Promise<{ threadId: string; model: string }> {
        const threadId = opts?.threadId ?? this._threadId;
        if (!threadId) {
            throw new Error('No thread available to resume.');
        }

        const activeTurnId = opts?.expectedActiveTurnId
            ?? (this._threadId === threadId ? this._turnId : null);
        const defaults = this.threadDefaults ?? {};
        const params: ResumeConversationParams = {
            threadId,
            model: opts?.model ?? defaults.model ?? null,
            modelProvider: null,
            cwd: opts?.cwd ?? defaults.cwd ?? process.cwd(),
            approvalPolicy: opts?.approvalPolicy ?? defaults.approvalPolicy ?? null,
            sandbox: opts?.sandbox ?? defaults.sandbox ?? null,
            config: this.buildThreadConfig(opts?.mcpServers ?? defaults.mcpServers),
            baseInstructions: null,
            developerInstructions: null,
            persistExtendedHistory: true,
        };

        const result = await this.request('thread/resume', params) as ResumeConversationResponse;
        if (result.thread.id !== threadId) {
            throw new Error(`thread/resume returned ${result.thread.id} while resuming ${threadId}`);
        }
        opts?.beforeEventReplay?.();
        this._threadId = result.thread.id;
        this._turnId = result.thread.id === threadId ? activeTurnId : null;
        this.proxiedTurnId = null;
        this.reconcileTurnStateFromThread(
            result.thread,
            result.thread.id === threadId ? activeTurnId : null,
        );
        if (opts?.emitActiveTurnSnapshot) {
            this.emitActiveTurnSnapshot(result.thread);
        }
        this.rememberThreadDefaults({
            model: opts?.model ?? defaults.model,
            cwd: opts?.cwd ?? defaults.cwd,
            approvalPolicy: opts?.approvalPolicy ?? defaults.approvalPolicy,
            sandbox: opts?.sandbox ?? defaults.sandbox,
            mcpServers: opts?.mcpServers ?? defaults.mcpServers,
        });
        logger.debug('[CodexAppServer] Thread resumed:', this._threadId);
        return { threadId: result.thread.id, model: result.model };
    }

    async refreshActiveTurn(): Promise<string | null> {
        if (!this._threadId) return null;
        const threadId = this._threadId;
        const previousTurnId = this._turnId;
        const result = await this.request('thread/read', {
            threadId,
            includeTurns: true,
        }) as { thread?: { id?: string; turns?: unknown[] } };
        if (result.thread?.id !== threadId) {
            throw new Error(`thread/read returned ${String(result.thread?.id)} while refreshing ${threadId}`);
        }
        this.reconcileTurnStateFromThread(result.thread, previousTurnId);
        return this._turnId;
    }

    async reconnectAndResumeThread(): Promise<boolean> {
        if (this.terminalDisconnectRequested) {
            return false;
        }
        const threadId = this._threadId;
        await this.disconnectAndWait(3_000, {
            preserveThreadState: !!threadId,
            allowReconnect: true,
        });
        if (this.terminalDisconnectRequested) {
            return false;
        }
        await this.connect();

        if (this.terminalDisconnectRequested) {
            await this.disconnectAndWait();
            return false;
        }

        if (!threadId) {
            return false;
        }

        try {
            await this.resumeThread({ threadId });
            return true;
        } catch (error) {
            logger.warn('[CodexAppServer] Failed to resume thread after reconnect', error);
            this._threadId = null;
            this.threadDefaults = null;
            return false;
        }
    }

    // ─── Turn management ────────────────────────────────────────

    /** Default grace period after interrupt before forcing a restart (ms). */
    private static readonly ABORT_GRACE_MS = 3_000;

    private hasPendingTurnCompletion(): boolean {
        return this.pendingTurnCompletion !== null;
    }

    private resolvePendingTurn(aborted: boolean): void {
        if (!this.pendingTurnCompletion) return;
        this.pendingTurnCompletion.resolve(aborted);
        this.pendingTurnCompletion = null;
    }

    private markPendingTurnStarted(turnId?: string | null): void {
        if (!this.pendingTurnCompletion) return;
        if (turnId) {
            this.pendingTurnCompletion.turnId = turnId;
        }
    }

    private tryResolvePendingTurn(aborted: boolean, turnId: string | null, source: string): void {
        const pending = this.pendingTurnCompletion;
        if (!pending) return;

        // Guard against stale completion notifications from a *different* turn.
        // We use turn ID matching instead of the `started` flag because Codex
        // can skip the turn/started notification entirely for fast turns,
        // which would cause us to discard a valid turn/completed and hang forever.
        if (pending.turnId && turnId && pending.turnId !== turnId) {
            logger.debug(
                `[CodexAppServer] Ignoring ${source} for turn ${turnId}; awaiting ${pending.turnId}`,
            );
            return;
        }

        this.resolvePendingTurn(aborted);
    }

    private async waitForTurnCompletion(timeoutMs: number): Promise<boolean> {
        if (!this.hasPendingTurnCompletion()) {
            return true;
        }

        const deadline = Date.now() + Math.max(0, timeoutMs);
        while (this.hasPendingTurnCompletion()) {
            if (Date.now() >= deadline) {
                return false;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return true;
    }

    /**
     * Request turn interruption and optionally force-restart the app-server if
     * the turn does not settle within a short grace period.
     */
    async abortTurnWithFallback(opts?: {
        gracePeriodMs?: number;
        forceRestartOnTimeout?: boolean;
    }): Promise<{ hadActiveTurn: boolean; aborted: boolean; forcedRestart: boolean; resumedThread: boolean }> {
        const hadActiveTurn = this.hasPendingTurnCompletion() || this.hasActiveTurn();

        // No active turn pending in this client call-site.
        if (!hadActiveTurn) {
            return { hadActiveTurn: false, aborted: false, forcedRestart: false, resumedThread: false };
        }

        // Best-effort interrupt request first.
        await this.interruptTurn();

        const gracePeriodMs = opts?.gracePeriodMs ?? CodexAppServerClient.ABORT_GRACE_MS;
        const completionSettled = await this.waitForTurnCompletion(gracePeriodMs);
        const turnBecameIdle = completionSettled
            ? await this.waitForTurnIdle(gracePeriodMs)
            : false;
        const settled = completionSettled && turnBecameIdle;
        if (settled) {
            return { hadActiveTurn: true, aborted: true, forcedRestart: false, resumedThread: false };
        }

        const shouldForceRestart = opts?.forceRestartOnTimeout ?? true;
        if (!shouldForceRestart) {
            return { hadActiveTurn: true, aborted: false, forcedRestart: false, resumedThread: false };
        }

        logger.warn(`[CodexAppServer] interrupt did not settle turn in ${gracePeriodMs}ms; force-restarting app-server`);
        const pendingTurnId = this.pendingTurnCompletion?.turnId ?? this._turnId;
        if (this.pendingTurnCompletion || this._turnId) {
            this.eventHandler?.({
                type: 'turn_aborted',
                reason: 'interrupted',
                ...(pendingTurnId ? { turn_id: pendingTurnId } : {}),
                forced_restart: true,
            });
        }
        const resumedThread = await this.reconnectAndResumeThread();
        return { hadActiveTurn: true, aborted: true, forcedRestart: true, resumedThread };
    }

    /**
     * Send a user turn and wait for it to complete.
     * Returns when task_complete or turn_aborted is received.
     */
    async sendTurn(prompt: string, opts?: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        effort?: ReasoningEffort;
    }): Promise<void> {
        if (!this._threadId) {
            throw new Error('No active thread. Call startThread first.');
        }

        const input: InputItem[] = [
            { type: 'text', text: prompt },
        ];

        // Build params — only include optional fields when set (server uses thread defaults otherwise)
        const params: Record<string, unknown> = {
            threadId: this._threadId,
            input,
        };
        if (opts?.cwd) params.cwd = opts.cwd;
        if (opts?.approvalPolicy) params.approvalPolicy = opts.approvalPolicy;
        if (opts?.model) params.model = opts.model;
        if (opts?.effort) params.effort = opts.effort;

        // Map sandbox mode to the camelCase policy format the server expects
        if (opts?.sandbox) {
            switch (opts.sandbox) {
                case 'workspace-write':
                    params.sandboxPolicy = { type: 'workspaceWrite' };
                    break;
                case 'danger-full-access':
                    params.sandboxPolicy = { type: 'dangerFullAccess' };
                    break;
                case 'read-only':
                    params.sandboxPolicy = { type: 'readOnly' };
                    break;
            }
        }

        // turn/start returns immediately; turn completes via events.
        // We don't await completion here — the caller's event handler
        // tracks task_complete / turn_aborted.
        const result = await this.request('turn/start', params) as { turn?: { id?: string | null } };
        const turnId = result?.turn?.id;
        if (typeof turnId === 'string' && turnId.length > 0) {
            this._turnId = turnId;
            if (this.pendingTurnCompletion) {
                this.pendingTurnCompletion.turnId = turnId;
            }
        }
    }

    /** Default timeout for waiting on turn completion (ms). 10 minutes. */
    private static readonly TURN_TIMEOUT_MS = 10 * 60 * 1000;

    /**
     * Send a user turn and wait for it to complete (task_complete or turn_aborted).
     * Returns { aborted: true } if the turn was aborted (user cancel, permission reject, etc.).
     */
    async sendTurnAndWait(prompt: string, opts?: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        effort?: ReasoningEffort;
        turnTimeoutMs?: number;
    }): Promise<{ aborted: boolean }> {
        // Wait for any in-flight interruptTurn() to complete before starting a new
        // turn. Otherwise the stale turn/interrupt RPC can reach Codex after our
        // turn/start and abort the wrong turn.
        if (this.pendingInterrupt) {
            await this.pendingInterrupt;
            // Yield to the event loop so any stale turn_aborted/task_complete
            // notifications queued by the interrupted turn are processed now
            // (harmlessly, since pendingTurnCompletion is null at this point).
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        const timeoutMs = opts?.turnTimeoutMs ?? CodexAppServerClient.TURN_TIMEOUT_MS;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const completion = new Promise<boolean>((resolve) => {
            this.pendingTurnCompletion = {
                resolve,
                turnId: null,
            };

            timer = setTimeout(() => {
                if (this.pendingTurnCompletion) {
                    logger.warn(`[CodexAppServer] Turn timed out after ${timeoutMs}ms — treating as abort`);
                    this.resolvePendingTurn(true);
                }
            }, timeoutMs);
        });

        try {
            await this.sendTurn(prompt, opts);
        } catch (err) {
            if (timer) clearTimeout(timer);
            this.pendingTurnCompletion = null;
            throw err;
        }

        const aborted = await completion;
        if (timer) clearTimeout(timer);
        return { aborted };
    }

    async interruptTurn(): Promise<void> {
        if (!this._threadId) return;
        if (!this._turnId) {
            logger.debug('[CodexAppServer] interruptTurn: no active turnId, skipping');
            return;
        }
        const params: InterruptConversationParams = {
            threadId: this._threadId,
            turnId: this._turnId,
        };
        const doInterrupt = async () => {
            try {
                await this.request('turn/interrupt', params);
            } catch (err) {
                // Ignore if no turn is active
                logger.debug('[CodexAppServer] interruptTurn error (may be expected):', err);
            } finally {
                this.pendingInterrupt = null;
            }
        };
        this.pendingInterrupt = doInterrupt();
        return this.pendingInterrupt;
    }

    async steerTurn(
        prompt: string,
        opts?: { threadId?: string; expectedTurnId?: string; clientUserMessageId?: string },
    ): Promise<{ turnId: string }> {
        const threadId = opts?.threadId ?? this._threadId;
        const expectedTurnId = opts?.expectedTurnId ?? this._turnId;
        if (!threadId) {
            throw new Error('Cannot steer a turn without an active thread.');
        }
        if (!expectedTurnId) {
            throw new Error('Cannot steer because there is no active turn.');
        }

        const params: SteerConversationParams = {
            threadId,
            expectedTurnId,
            input: [{ type: 'text', text: prompt }],
            ...(opts?.clientUserMessageId ? { clientUserMessageId: opts.clientUserMessageId } : {}),
        };
        let result: SteerConversationResponse;
        try {
            result = await this.request('turn/steer', params) as SteerConversationResponse;
        } catch (error) {
            if (error instanceof CodexRpcError && /no active turn/i.test(error.message)) {
                this.clearActiveTurn(expectedTurnId);
            }
            throw error;
        }
        const turnId = result?.turnId;
        if (typeof turnId !== 'string' || turnId.length === 0) {
            throw new Error('turn/steer returned no turn id.');
        }
        // A very fast turn may complete before the steer response reaches us.
        // Do not resurrect it after turn/completed already cleared local state.
        if (this._turnId === expectedTurnId) {
            this._turnId = turnId;
        }
        return { turnId };
    }

    // ─── State queries ──────────────────────────────────────────

    hasActiveThread(): boolean {
        return this._threadId !== null;
    }

    hasActiveTurn(): boolean {
        return this._turnId !== null;
    }

    async waitForTurnIdle(timeoutMs: number = CodexAppServerClient.TURN_TIMEOUT_MS): Promise<boolean> {
        if (!this._turnId) return true;

        return new Promise<boolean>((resolve) => {
            let settled = false;
            const finish = (idle: boolean): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.turnIdleWaiters.delete(onIdle);
                resolve(idle);
            };
            const onIdle = (): void => finish(true);
            const timer = setTimeout(() => finish(false), timeoutMs);
            this.turnIdleWaiters.add(onIdle);
            if (!this._turnId) onIdle();
        });
    }

    // ─── JSON-RPC transport ─────────────────────────────────────

    /** Default timeout for RPC requests (ms). */
    private static readonly REQUEST_TIMEOUT_MS = 30_000;

    private canSendRpc(): boolean {
        return this.socket?.readyState === WebSocket.OPEN || Boolean(this.process?.stdin?.writable);
    }

    private sendRpc(message: JsonRpcRequest | JsonRpcResponse): boolean {
        const payload = JSON.stringify(message);
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(payload);
            return true;
        }
        if (this.process?.stdin?.writable) {
            this.process.stdin.write(payload + '\n');
            return true;
        }
        return false;
    }

    private request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
        const timeout = timeoutMs ?? CodexAppServerClient.REQUEST_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
            if (!this.canSendRpc()) {
                reject(new Error(`Cannot send ${method}: app-server transport is not writable`));
                return;
            }
            const id = this.nextId++;

            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out after ${timeout}ms (id=${id})`));
            }, timeout);

            this.pending.set(id, {
                resolve: (result) => { clearTimeout(timer); resolve(result); },
                reject: (err) => { clearTimeout(timer); reject(err); },
                method,
                epoch: this.processEpoch,
            });

            const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
            logger.debug(`[CodexAppServer] → ${method} (id=${id})`);
            if (!this.sendRpc(msg)) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(new Error(`Cannot send ${method}: app-server transport closed`));
            }
        });
    }

    private notify(method: string, params?: unknown): void {
        const msg: JsonRpcRequest = { jsonrpc: '2.0', method, params };
        if (!this.sendRpc(msg)) return;
        logger.debug(`[CodexAppServer] → ${method} (notification)`);
    }

    private respond(id: number | string, result: unknown): void {
        const msg: JsonRpcResponse = { jsonrpc: '2.0', id, result };
        if (!this.sendRpc(msg)) return;
        logger.debug(`[CodexAppServer] → response (id=${id})`);
    }

    private handleLine(line: string, sourceEpoch: number = this.processEpoch): void {
        if (sourceEpoch !== this.processEpoch) {
            return;
        }
        if (!line.trim()) return;

        let msg: any;
        try {
            msg = JSON.parse(line);
        } catch {
            logger.debug('[CodexAppServer] Non-JSON line:', line.substring(0, 200));
            return;
        }

        // Response to our request
        if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
            const pending = this.pending.get(msg.id);
            if (pending) {
                if (pending.epoch !== sourceEpoch) {
                    logger.debug(`[CodexAppServer] Ignoring response from stale epoch for id=${msg.id}`);
                    return;
                }
                this.pending.delete(msg.id);
                if (msg.error) {
                    pending.reject(new CodexRpcError(
                        pending.method,
                        typeof msg.error.code === 'number' ? msg.error.code : -1,
                        typeof msg.error.message === 'string' ? msg.error.message : 'Unknown app-server error',
                        msg.error.data,
                    ));
                } else {
                    pending.resolve(msg.result);
                }
            }
            return;
        }

        // Server → client request (approvals)
        if (msg.id != null && msg.method) {
            if (
                this.approvalHandlingMode === 'observer'
                || (this.isApprovalRequestMethod(msg.method) && !this.approvalHandler)
            ) {
                this.deferredApprovalRequests.set(msg.id, { method: msg.method, params: msg.params });
                logger.debug(`[CodexAppServer] Observing approval request ${msg.id}; local TUI owns the response`);
                return;
            }
            this.dispatchServerRequest(msg.id, msg.method, msg.params).catch((err) => {
                logger.debug('[CodexAppServer] Error handling server request:', err);
            });
            return;
        }

        // Notification (no id)
        if (msg.method) {
            this.handleNotification(msg.method, msg.params);
            return;
        }

        logger.debug('[CodexAppServer] Unhandled message:', JSON.stringify(msg).substring(0, 300));
    }

    /**
     * Map our internal ReviewDecision to the wire format the server expects.
     * Server uses: accept, acceptForSession, decline, cancel
     * Our handler uses: approved, approved_for_session, denied, abort
     */
    /**
     * Map our internal ReviewDecision to the wire format codex expects.
     * v2 methods (item/*) use: accept/acceptForSession/decline/cancel
     * Legacy methods (execCommandApproval/applyPatchApproval) use: approved/approved_for_session/denied/abort
     */
    private mapDecisionToWire(decision: ReviewDecision, legacy: boolean): string | Record<string, unknown> {
        if (typeof decision === 'string') {
            if (legacy) {
                // Legacy wire format — pass through as-is (approved/denied/abort)
                return decision;
            }
            // v2 wire format
            switch (decision) {
                case 'approved': return 'accept';
                case 'approved_for_session': return 'acceptForSession';
                case 'denied': return 'decline';
                case 'abort': return 'cancel';
                default: return 'decline';
            }
        }
        // Translate Happy's legacy decision shape to the v2 app-server shape.
        if ('approved_execpolicy_amendment' in decision) {
            return {
                acceptWithExecpolicyAmendment: {
                    execpolicy_amendment: decision.approved_execpolicy_amendment.proposed_execpolicy_amendment,
                },
            };
        }
        return legacy ? 'denied' : 'decline';
    }

    private parseToolNameFromElicitationMessage(message: unknown): string | null {
        if (typeof message !== 'string') {
            return null;
        }
        const match = message.match(/tool "([^"]+)"/i);
        return match?.[1] ?? null;
    }

    private mapDecisionToMcpElicitationResponse(
        decision: ReviewDecision,
        params: any,
    ): McpServerElicitationRequestResponse {
        if (typeof decision === 'string') {
            switch (decision) {
                case 'approved':
                case 'approved_for_session':
                    return {
                        action: 'accept',
                        content: params?.mode === 'form' ? {} : null,
                        _meta: null,
                    };
                case 'abort':
                    return {
                        action: 'cancel',
                        content: null,
                        _meta: null,
                    };
                case 'denied':
                default:
                    return {
                        action: 'decline',
                        content: null,
                        _meta: null,
                    };
            }
        }

        return {
            action: 'decline',
            content: null,
            _meta: null,
        };
    }

    private async dispatchServerRequest(id: number | string, method: string, params: any): Promise<void> {
        const ownershipEpoch = this.approvalOwnershipEpoch;
        this.inFlightServerRequests.set(id, ownershipEpoch);
        try {
            await this.handleServerRequest(id, method, params, ownershipEpoch);
        } finally {
            this.inFlightServerRequests.delete(id);
            this.externallyResolvedServerRequests.delete(id);
        }
    }

    private respondToServerRequest(id: number | string, result: unknown, ownershipEpoch: number): void {
        if (
            this.approvalHandlingMode !== 'active'
            || ownershipEpoch !== this.approvalOwnershipEpoch
            || this.externallyResolvedServerRequests.has(id)
        ) {
            logger.debug(`[CodexAppServer] Suppressing stale response for server request ${String(id)}`);
            return;
        }
        this.respond(id, result);
    }

    private async handleServerRequest(
        id: number | string,
        method: string,
        params: any,
        ownershipEpoch: number,
    ): Promise<void> {
        if (method === 'mcpServer/elicitation/request') {
            const toolName = this.parseToolNameFromElicitationMessage(params?.message) ?? params?.serverName ?? 'McpTool';
            const decision = await this.handleApproval({
                type: 'mcp',
                callId: `${params?.serverName ?? 'mcp'}:${id}`,
                toolName,
                input: params?._meta?.tool_params ?? {},
                serverName: params?.serverName,
                message: params?.message,
            });
            this.respondToServerRequest(id, this.mapDecisionToMcpElicitationResponse(decision, params), ownershipEpoch);
            return;
        }

        // Command execution approval
        if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
            const legacy = method === 'execCommandApproval';
            const callId = params.itemId ?? params.callId ?? String(id);
            const decision = await this.handleApproval({
                type: 'exec',
                callId,
                command: params.command != null ? [params.command] : [],
                cwd: params.cwd,
                reason: params.reason,
            });
            this.respondToServerRequest(id, { decision: this.mapDecisionToWire(decision, legacy) }, ownershipEpoch);
            return;
        }

        // File change / patch approval
        if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
            const legacy = method === 'applyPatchApproval';
            const callId = params.itemId ?? params.callId ?? String(id);
            const decision = await this.handleApproval({
                type: 'patch',
                callId,
                fileChanges: params.fileChanges ?? (typeof callId === 'string'
                    ? this.rawFileChangesByItemId.get(callId)
                    : undefined),
                reason: params.reason,
            });
            this.respondToServerRequest(id, { decision: this.mapDecisionToWire(decision, legacy) }, ownershipEpoch);
            return;
        }

        if (method === 'item/permissions/requestApproval') {
            // Happy does not yet expose the fine-grained permission editor.
            // An empty grant is the schema-valid safe response.
            this.respondToServerRequest(id, { permissions: {}, scope: 'turn' }, ownershipEpoch);
            return;
        }

        if (method === 'item/tool/requestUserInput') {
            // The mobile wire protocol has no structured-question surface yet.
            // Return no answers instead of an invalid empty JSON-RPC result.
            this.respondToServerRequest(id, { answers: {} }, ownershipEpoch);
            return;
        }

        // Unknown server request — respond so server doesn't hang
        logger.debug(`[CodexAppServer] Unknown server request: ${method}`);
        this.respondToServerRequest(id, {}, ownershipEpoch);
    }

    private async handleApproval(params: Parameters<ApprovalHandler>[0]): Promise<ReviewDecision> {
        if (this.approvalHandler) {
            try {
                return await this.approvalHandler(params);
            } catch (err) {
                logger.debug('[CodexAppServer] Approval handler error:', err);
                return 'denied';
            }
        }
        return 'denied'; // default: deny if no handler
    }

    private handleNotification(method: string, params: any): void {
        if (method === 'serverRequest/resolved') {
            const requestId = params?.requestId;
            if (requestId !== undefined && requestId !== null) {
                this.deferredApprovalRequests.delete(requestId);
                if (this.inFlightServerRequests.has(requestId)) {
                    this.externallyResolvedServerRequests.add(requestId);
                }
            }
            logger.debug(`[CodexAppServer] Approval request resolved by another subscribed client: ${String(requestId)}`);
            return;
        }

        // codex/event notifications: either `codex/event` or `codex/event/<type>`
        if (method === 'codex/event' || method.startsWith('codex/event/')) {
            this.notificationProtocol = 'legacy';
            const msg = params?.msg;
            if (msg) {
                // Extract turn_id from task_started events
                if (msg.type === 'task_started' && msg.turn_id) {
                    this._turnId = msg.turn_id;
                }
                if (msg.type === 'task_started') {
                    this.markPendingTurnStarted(msg.turn_id ?? msg.turnId ?? null);
                }
                if (
                    (msg.type === 'task_complete' || msg.type === 'turn_aborted')
                    && this.isStaleTurnCompletion(
                        msg.turn_id ?? msg.turnId ?? null,
                        `codex/event/${msg.type}`,
                    )
                ) {
                    return;
                }
                // Fire event handler first (so consumer processes the event)
                this.eventHandler?.(msg);
                // Then resolve turn completion promise
                if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
                    const turnId = msg.turn_id ?? msg.turnId ?? null;
                    // Mark as completed so v2 turn/completed doesn't duplicate
                    if (turnId) {
                        this.completedTurnIds.add(turnId);
                    }
                    this.tryResolvePendingTurn(
                        msg.type === 'turn_aborted',
                        turnId,
                        `codex/event/${msg.type}`,
                    );
                    this.clearActiveTurn(turnId);
                }
            }
            return;
        }

        if (this.handleRawNotification(method, params)) {
            logger.debug(`[CodexAppServer] Raw notification: ${method}`);
            return;
        }

        // v2 lifecycle notifications
        if (method === 'thread/started' || method === 'turn/started' ||
            method === 'turn/completed' || method === 'thread/status/changed') {
            logger.debug(`[CodexAppServer] Lifecycle notification: ${method}`);
            // Mark the turn as started so the completion guard lets it through.
            if (method === 'turn/started') {
                const turnId = this.extractTurnId(params);
                if (turnId) {
                    this._turnId = turnId;
                }
                this.markPendingTurnStarted(turnId);
            }
            // turn/completed is a fallback signal — for mid-inference interrupts,
            // Codex may only signal completion here (not via codex/event turn_aborted).
            // emitRawTurnCompletion deduplicates via completedTurnIds if legacy already handled it.
            if (method === 'turn/completed') {
                this.emitRawTurnCompletion(
                    this.extractTurnId(params),
                    this.extractTurnStatus(params),
                    params?.turn?.error ?? params?.error,
                    method,
                );
            }
            return;
        }

        // MCP server lifecycle: log payload so we can diagnose failed launches
        // (e.g. happy-mcp bridge failing on Windows due to shebang execution).
        if (method === 'mcpServer/startupStatus/updated') {
            logger.debug(`[CodexAppServer] mcpServer startup status:`, params);
            return;
        }

        logger.debug(`[CodexAppServer] Notification: ${method}`);
    }
}
