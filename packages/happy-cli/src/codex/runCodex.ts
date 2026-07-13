import { render } from "ink";
import React from "react";
import { ApiClient } from '@/api/api';
import {
    CodexAppServerClient,
    CodexRpcError,
    supportsSharedCodexAppServer,
} from './codexAppServerClient';
import type { ReasoningEffort } from './codexAppServerTypes';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { projectPath } from '@/projectPath';
import { join } from 'node:path';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { CodexDisplay } from "@/ui/ink/CodexDisplay";
import { trimIdent } from "@/utils/trimIdent";
import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import { notifyDaemonSessionStarted } from "@/daemon/controlClient";
import { encodeBase64, decodeBase64 } from '@/api/encryption';
import type { Session as ApiSession } from '@/api/types';
import { registerKillSessionHandler } from "@/claude/registerKillSessionHandler";
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import type { ApiSessionClient } from '@/api/apiSession';
import { resolveCodexExecutionPolicy } from './executionPolicy';
import { mapCodexMcpMessageToSessionEnvelopes, mapCodexProcessorMessageToSessionEnvelopes } from './utils/sessionProtocolMapper';
import { resumeExistingThread } from './resumeExistingThread';
import { emitReadyForLocalCompletion, emitReadyIfIdle } from './emitReadyIfIdle';
import type { CodexStartingMode } from './cliArgs';
import { launchNativeCodex, type CodexPermissionMode } from './codexLocalLauncher';
import { resolveCodexStartingMode, resolveCodexSwitchAction } from './modeLoop';
import { cleanupStdinAfterInk } from '@/utils/terminalStdinCleanup';
import { createEnvelope } from '@slopus/happy-wire';
import { normalizeLocalCodexRolloutEvent } from './codexLocalRolloutState';
import { LocalTurnCompletionGate } from './localTurnCompletionGate';
import { sendCodexReadyNotification } from './sendCodexReadyNotification';
import {
    startCodexTuiWebSocketProxy,
    type CodexTuiSelectionMethod,
} from './codexTuiWebSocketProxy';

/**
 * Extracts a human-readable error from a codex task_complete/turn_aborted event.
 * Returns null if the event represents a successful/clean completion.
 */
function describeCodexFailure(msg: any): string | null {
    const hasFailure = msg?.status === 'failed' || (msg?.error !== undefined && msg?.error !== null);
    if (!hasFailure) return null;
    const err = msg.error;
    if (typeof err === 'string' && err.length > 0) return err;
    if (err && typeof err === 'object' && typeof err.message === 'string' && err.message.length > 0) {
        return err.message;
    }
    return 'Unknown error';
}

/**
 * Main entry point for the codex command with ink UI
 */
export async function runCodex(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    noSandbox?: boolean;
    resumeThreadId?: string;
    nativeResumeArgs?: string[];
    startingMode?: CodexStartingMode;
    permissionMode?: CodexPermissionMode;
}): Promise<void> {
    // Early check: ensure Codex CLI is installed before proceeding
    try {
        execSync('codex --version', { encoding: 'utf8', stdio: 'pipe', windowsHide: true });
    } catch {
        console.error('\n\x1b[1m\x1b[33mCodex CLI is not installed\x1b[0m\n');
        console.error('Please install Codex CLI using one of these methods:\n');
        console.error('\x1b[1mOption 1 - npm (recommended):\x1b[0m');
        console.error('  \x1b[36mnpm install -g @openai/codex\x1b[0m\n');
        console.error('\x1b[1mOption 2 - Homebrew (macOS):\x1b[0m');
        console.error('  \x1b[36mbrew install --cask codex\x1b[0m\n');
        console.error('Alternatively, use Claude Code:');
        console.error('  \x1b[36mhappy claude\x1b[0m\n');
        process.exit(1);
    }

    const hasInteractiveTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const canRunLocal = opts.startedBy !== 'daemon' && hasInteractiveTTY;
    const initialRunMode = resolveCodexStartingMode({
        startedBy: opts.startedBy,
        requestedMode: opts.startingMode,
        hasTTY: hasInteractiveTTY,
    });

    // Use shared PermissionMode type for cross-agent compatibility
    type PermissionMode = import('@/api/types').PermissionMode;
    interface EnhancedMode {
        permissionMode: PermissionMode;
        model?: string;
        /** Reasoning effort passed through to Codex's sendTurnAndWait. */
        effort?: ReasoningEffort;
    }

    //
    // Define session
    //

    const sessionTag = randomUUID();

    // Set backend for offline warnings (before any API calls)
    connectionState.setBackend('Codex');

    const api = await ApiClient.create(opts.credentials);

    // Log startup options
    logger.debug(`[codex] Starting with options: startedBy=${opts.startedBy || 'terminal'}`);

    //
    // Machine
    //

    const settings = await readSettings();
    let machineId = settings?.machineId;
    const sandboxConfig = opts.noSandbox ? undefined : settings?.sandboxConfig;
    const useSharedAppServer = canRunLocal
        && (!sandboxConfig?.enabled || sandboxConfig.allowLocalBinding)
        && supportsSharedCodexAppServer();
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/happy-cli/issues`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);
    await api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata
    });

    //
    // Create session
    //

    const { state, metadata } = createSessionMetadata({
        flavor: 'codex',
        machineId,
        startedBy: opts.startedBy,
        sandbox: sandboxConfig,
        dangerouslySkipPermissions: opts.permissionMode === 'yolo',
        permissionMode: opts.permissionMode,
    });

    // Check for session reconnection env vars (set by daemon for resume-in-place)
    const reconnectSessionId = process.env.HAPPY_RECONNECT_SESSION_ID;
    const reconnectKeyBase64 = process.env.HAPPY_RECONNECT_ENCRYPTION_KEY;
    const reconnectVariant = process.env.HAPPY_RECONNECT_ENCRYPTION_VARIANT as 'legacy' | 'dataKey' | undefined;
    const reconnectSeq = process.env.HAPPY_RECONNECT_SEQ;
    const reconnectMetadataVersion = process.env.HAPPY_RECONNECT_METADATA_VERSION;
    const reconnectAgentStateVersion = process.env.HAPPY_RECONNECT_AGENT_STATE_VERSION;

    let response: ApiSession | null;
    if (reconnectSessionId && reconnectKeyBase64 && reconnectVariant) {
        logger.debug(`[START] Reconnecting to existing session ${reconnectSessionId}`);
        response = {
            id: reconnectSessionId,
            seq: parseInt(reconnectSeq || '0', 10),
            encryptionKey: decodeBase64(reconnectKeyBase64),
            encryptionVariant: reconnectVariant,
            metadata,
            metadataVersion: parseInt(reconnectMetadataVersion || '0', 10),
            agentState: state,
            agentStateVersion: parseInt(reconnectAgentStateVersion || '0', 10),
        };
    } else {
        response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    }

    // Handle server unreachable case - create offline stub with hot reconnection
    let session: ApiSessionClient;
    // Permission handler declared here so it can be updated in onSessionSwap callback
    // (assigned later at line ~385 after client setup)
    let permissionHandler: CodexPermissionHandler;
    let client!: CodexAppServerClient;
    let reasoningProcessor!: ReasoningProcessor;
    let abortInProgress: Promise<void> | null = null;
    let bindSessionHandlers: ((targetSession: ApiSessionClient) => void) | null = null;
    let currentRunMode = initialRunMode;
    let activeCodexThreadId = opts.resumeThreadId;
    let nativeResumeArgsPending = opts.nativeResumeArgs;
    let thinking = false;
    const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
        api,
        sessionTag,
        metadata,
        state,
        response,
        onSessionSwap: (newSession) => {
            session = newSession;
            // Update permission handler with new session to avoid stale reference
            if (permissionHandler) {
                permissionHandler.updateSession(newSession);
            }
            bindSessionHandlers?.(newSession);
            newSession.updateAgentState((currentState) => ({
                ...currentState,
                controlledByUser: currentRunMode === 'local',
            }));
            if (activeCodexThreadId) {
                newSession.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    codexThreadId: activeCodexThreadId,
                }));
            }
            newSession.keepAlive(thinking, currentRunMode);
        }
    });
    session = initialSession;

    // On reconnect, un-archive the session and skip replaying old messages.
    if (reconnectSessionId) {
        session.suppressNextArchiveSignal();
        session.skipExistingMessages();
        session.updateMetadata((meta) => ({
            ...meta,
            lifecycleState: 'running',
            archivedBy: undefined,
        }));
    }

    // Always report to daemon if it exists (skip if offline)
    if (response) {
        try {
            logger.debug(`[START] Reporting session ${response.id} to daemon`);
            const result = await notifyDaemonSessionStarted(response.id, metadata, {
                encryptionKey: encodeBase64(response.encryptionKey),
                encryptionVariant: response.encryptionVariant,
                seq: response.seq,
                metadataVersion: response.metadataVersion,
                agentStateVersion: response.agentStateVersion,
            });
            if (result.error) {
                logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
            } else {
                logger.debug(`[START] Reported session ${response.id} to daemon`);
            }
        } catch (error) {
            logger.debug('[START] Failed to report to daemon (may not be running):', error);
        }
    }

    const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
        effort: mode.effort,
    }));

    // Track current overrides to apply per message
    // Use shared PermissionMode type from api/types for cross-agent compatibility
    let currentPermissionMode: import('@/api/types').PermissionMode | undefined = opts.permissionMode;
    let currentModel: string | undefined = undefined;
    let currentEffort: ReasoningEffort | undefined = undefined;
    let localHandoff: (() => void) | null = null;
    let localTerminate: (() => void) | null = null;
    let localHandoffRequested = false;
    let localTerminateRequested = false;
    let switchToLocalRequested = false;
    let terminating = false;
    let subscribeSharedLocalThread: ((
        threadId: string,
        method: CodexTuiSelectionMethod,
        expectedActiveTurnId?: string,
    ) => Promise<void>) | null = null;
    if (useSharedAppServer) {
        client = new CodexAppServerClient(sandboxConfig, {
            transport: 'websocket',
            adoptExternalRootThreads: false,
        });
        client.setApprovalHandlingMode(currentRunMode === 'local' ? 'observer' : 'active');
    }

    // Valid Codex permission modes from remote messages. Matches the modes
    // the mobile UI exposes for Codex sessions (see modelModeOptions.ts:
    // getCodexPermissionModes) and mirrors the Gemini validation pattern at
    // runGemini.ts:222. Anything outside this set is silently ignored — the
    // previous code blindly cast `message.meta.permissionMode as PermissionMode`
    // at runtime, meaning a crafted value like `'totally_unsafe'` would be
    // accepted and then fall through to the `default` branch in
    // resolveCodexExecutionPolicy() — or worse, an attacker-chosen valid value
    // could escalate sandbox scope (issue #1092).
    const VALID_REMOTE_PERMISSION_MODES: readonly PermissionMode[] = [
        'default',
        'read-only',
        'safe-yolo',
        'yolo',
    ];

    const VALID_REMOTE_EFFORTS: readonly ReasoningEffort[] = [
        'none', 'minimal', 'low', 'medium', 'high', 'xhigh',
    ];

    const handleUserMessage: Parameters<ApiSessionClient['onUserMessage']>[0] = (message) => {
        if (terminating) {
            logger.debug('[Codex] Ignoring user message while session termination is in progress');
            return;
        }
        // Resolve permission mode (validate against Codex-native modes)
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            const incoming = message.meta.permissionMode as PermissionMode;
            if (VALID_REMOTE_PERMISSION_MODES.includes(incoming)) {
                messagePermissionMode = incoming;
                currentPermissionMode = messagePermissionMode;
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    dangerouslySkipPermissions: currentPermissionMode === 'yolo',
                    permissionMode: currentPermissionMode,
                }));
                logger.debug(`[Codex] Permission mode updated from user message to: ${currentPermissionMode}`);
            } else {
                logger.debug(`[Codex] Ignoring invalid permission mode from user message: ${String(message.meta.permissionMode)}`);
            }
        } else {
            logger.debug(`[Codex] User message received with no permission mode override, using current: ${currentPermissionMode ?? 'default (effective)'}`);
        }

        // Resolve model; explicit null resets to default (undefined)
        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model || undefined;
            currentModel = messageModel;
            logger.debug(`[Codex] Model updated from user message: ${messageModel || 'reset to default'}`);
        } else {
            logger.debug(`[Codex] User message received with no model override, using current: ${currentModel || 'default'}`);
        }

        // Resolve effort — passed straight to sendTurnAndWait. Validate the
        // incoming value against ReasoningEffort so a stale/garbage entry on
        // the wire doesn't poison the per-turn options.
        let messageEffort = currentEffort;
        if (message.meta?.hasOwnProperty('effort')) {
            const incoming = (message.meta as Record<string, unknown>).effort;
            if (incoming === null || incoming === undefined) {
                messageEffort = undefined;
                currentEffort = undefined;
                logger.debug(`[Codex] Effort reset to default`);
            } else if (typeof incoming === 'string' && (VALID_REMOTE_EFFORTS as readonly string[]).includes(incoming)) {
                messageEffort = incoming as ReasoningEffort;
                currentEffort = messageEffort;
                logger.debug(`[Codex] Effort updated from user message: ${messageEffort}`);
            } else {
                logger.debug(`[Codex] Ignoring invalid effort from user message: ${String(incoming)}`);
            }
        } else {
            logger.debug(`[Codex] User message received with no effort override, using current: ${currentEffort ?? 'default'}`);
        }

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode || 'default',
            model: messageModel,
            effort: messageEffort,
        };
        messageQueue.push(message.content.text, enhancedMode);
        if (currentRunMode === 'local' || switchToLocalRequested) {
            localHandoffRequested = true;
            localHandoff?.();
        }
    };
    let currentTurnId: string | null = null;
    let codexStartedSubagents = new Set<string>();
    let codexActiveSubagents = new Set<string>();
    let codexProviderSubagentToSessionSubagent = new Map<string, string>();
    let pendingLocalTaskStarted: Record<string, unknown> | null = null;
    let pendingLocalFailure: string | null = null;
    const sharedLocalTurnCompletionGate = new LocalTurnCompletionGate();

    const sendReady = () => {
        try {
            // Use the direct Expo path for Codex completion notifications. It
            // sends each token separately with high priority and the audible
            // "AI" Android channel. This path was live-verified as audible on
            // the device where the production server path arrived silently.
            sendCodexReadyNotification({
                sessionId: session.sessionId,
                metadata: session.getMetadata(),
                sendReadyEvent: () => session.sendSessionEvent({ type: 'ready' }),
                sendToAllDevices: (title, body, data) => {
                    api.push().sendToAllDevices(title, body, data);
                },
            });
        } catch (pushError) {
            logger.debug('[Codex] Failed to send ready push', pushError);
        }
    };

    const emitLocalReady = (message: Record<string, unknown>): void => {
        emitReadyForLocalCompletion({
            message,
            handoffPending: localHandoffRequested,
            queueSize: () => messageQueue.size(),
            shouldExit: terminating || localTerminateRequested,
            sendReady,
        });
    };

    const sendMappedCodexEvent = (msg: Record<string, unknown>): void => {
        const mapped = mapCodexMcpMessageToSessionEnvelopes(msg, {
            currentTurnId,
            startedSubagents: codexStartedSubagents,
            activeSubagents: codexActiveSubagents,
            providerSubagentToSessionSubagent: codexProviderSubagentToSessionSubagent,
        });
        currentTurnId = mapped.currentTurnId;
        codexStartedSubagents = mapped.startedSubagents;
        codexActiveSubagents = mapped.activeSubagents;
        codexProviderSubagentToSessionSubagent = mapped.providerSubagentToSessionSubagent;
        for (const envelope of mapped.envelopes) {
            session.sendSessionProtocolMessage(envelope);
        }
    };

    const handleLocalRolloutEvent = (rawMessage: Record<string, unknown>): void => {
        const normalized = normalizeLocalCodexRolloutEvent(rawMessage, pendingLocalFailure);
        const msg = normalized.message;
        pendingLocalFailure = normalized.pendingFailure;

        if (msg.type === 'task_started') {
            thinking = true;
            session.keepAlive(true, 'local');
            pendingLocalTaskStarted = msg;
            return;
        }

        if (normalized.visibleError) {
            session.sendSessionEvent({
                type: 'message',
                message: `Codex error: ${normalized.visibleError}`,
            });
        }

        if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
            thinking = false;
            session.keepAlive(false, 'local');
        }

        if (msg.type === 'user_message') {
            if (typeof msg.message === 'string' && msg.message.length > 0) {
                session.sendSessionProtocolMessage(createEnvelope('user', { t: 'text', text: msg.message }));
            }
            if (pendingLocalTaskStarted) {
                sendMappedCodexEvent(pendingLocalTaskStarted);
                pendingLocalTaskStarted = null;
            }
            return;
        }

        if (pendingLocalTaskStarted) {
            sendMappedCodexEvent(pendingLocalTaskStarted);
            pendingLocalTaskStarted = null;
        }
        // Rollout persistence records command/patch completion but not their
        // corresponding begin event. Synthesize the start with the same call id
        // so the phone receives a well-formed tool lifecycle instead of an
        // orphaned tool-call-end.
        if (msg.type === 'exec_command_end') {
            sendMappedCodexEvent({ ...msg, type: 'exec_command_begin' });
        } else if (msg.type === 'patch_apply_end') {
            sendMappedCodexEvent({ ...msg, type: 'patch_apply_begin' });
        }
        sendMappedCodexEvent(msg);
        emitLocalReady(msg);
    };

    // The shared app-server is the only component that sees local TUI events
    // immediately. A rollout file is written by the app-server process (not by
    // the disposable `codex --remote` TUI), so PID/originator-based rollout
    // discovery cannot reliably attach a tail for a brand-new local thread.
    // Forward the app-server stream while local mode owns the terminal.
    const handleSharedLocalEvent = (msg: Record<string, unknown>): void => {
        const completionDecision = sharedLocalTurnCompletionGate.classify(msg);
        if (!completionDecision.accepted) {
            return;
        }

        if (msg.type === 'thread_started') {
            return;
        }
        if (msg.type === 'thread_active') {
            // `thread/status/changed` is broadcast server-wide and does not
            // identify which connected client selected the thread. The native
            // TUI proxy below provides connection-scoped selection instead.
            return;
        }

        if (msg.type === 'user_message') {
            if (typeof msg.message === 'string' && msg.message.length > 0) {
                session.sendSessionProtocolMessage(createEnvelope('user', { t: 'text', text: msg.message }));
            }
            return;
        }

        if (msg.type === 'task_started') {
            thinking = true;
            session.keepAlive(true, 'local');
        } else if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
            thinking = false;
            session.keepAlive(false, 'local');
            const failure = describeCodexFailure(msg);
            if (failure) {
                session.sendSessionEvent({ type: 'message', message: `Codex error: ${failure}` });
            }
        }

        sendMappedCodexEvent(msg);
        if (completionDecision.successfulCompletion) {
            emitLocalReady(msg);
        }
    };

    if (useSharedAppServer) {
        // Install this before connecting or launching the native TUI. Otherwise
        // all local turns happen while no consumer is attached to the shared
        // app-server event stream and never reach the phone.
        client.setEventHandler((message) => {
            try {
                handleSharedLocalEvent(message);
            } catch (error) {
                // A phone/session rendering failure must not make a successful
                // app-server resume look failed to the selecting TUI.
                logger.warn('[Codex] Failed to forward a shared local event', error);
            }
        });
    }
    session.updateAgentState((currentState) => ({
        ...currentState,
        controlledByUser: currentRunMode === 'local',
    }));
    session.keepAlive(thinking, currentRunMode);
    // Periodic keep-alive; store handle so we can clear on exit
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(thinking, currentRunMode);
    }, 2000);

    type HappyServer = Awaited<ReturnType<typeof startHappyServer>>;
    let happyServer: HappyServer | null = null;
    const stopHappyMcpServer = (): void => {
        const server = happyServer as HappyServer | null;
        happyServer = null;
        server?.stop();
    };

    type SharedTuiProxy = Awaited<ReturnType<typeof startCodexTuiWebSocketProxy>>;
    let sharedTuiProxy: SharedTuiProxy | null = null;
    const ensureSharedTuiProxyEndpoint = async (): Promise<string> => {
        if (!useSharedAppServer) {
            throw new Error('The shared Codex TUI proxy is unavailable without a shared app-server.');
        }
        if (sharedTuiProxy) {
            return sharedTuiProxy.endpoint;
        }
        const targetEndpoint = client.remoteEndpoint;
        if (!targetEndpoint) {
            throw new Error('The shared Codex app-server has no WebSocket endpoint.');
        }
        const threadStartMcpServers = await ensureHappyMcpServers();
        sharedTuiProxy = await startCodexTuiWebSocketProxy({
            targetEndpoint,
            threadStartMcpServers,
            onThreadSelected: async ({ threadId, method, activeTurnId }) => {
                const subscribe = subscribeSharedLocalThread;
                if (!subscribe) {
                    throw new Error('Happy is not ready to subscribe to a local Codex thread.');
                }
                logger.debug(`[Codex] Native TUI selected ${threadId} via ${method}`);
                await subscribe(threadId, method, activeTurnId);
            },
            onError: (error) => {
                logger.warn('[Codex] Native TUI WebSocket proxy error', error);
            },
        });
        logger.debug(`[Codex] Native TUI proxy listening at ${sharedTuiProxy.endpoint}`);
        return sharedTuiProxy.endpoint;
    };
    const stopSharedTuiProxy = async (): Promise<void> => {
        const proxy = sharedTuiProxy;
        sharedTuiProxy = null;
        if (proxy) {
            await proxy.close();
            await proxy.waitForIdle();
        }
    };

    const launchLocalCodexSession = async (codexThreadId: string | undefined): Promise<
        | { type: 'exit'; code: number }
        | { type: 'switch-to-remote' }
    > => {
        let exitCode = 0;
        let switchToRemote = false;
        try {
            if (localTerminateRequested) {
                return { type: 'exit', code: 0 };
            }
            if (messageQueue.size() > 0 || localHandoffRequested) {
                switchToRemote = true;
                localHandoffRequested = false;
                currentRunMode = 'remote';
                session.keepAlive(thinking, 'remote');
                session.updateAgentState((currentState) => ({
                    ...currentState,
                    controlledByUser: false,
                }));
                session.sendSessionEvent({ type: 'switch', mode: 'remote' });
                return { type: 'switch-to-remote' };
            }

            if (codexThreadId) {
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    codexThreadId,
                }));
            }

            const nativePermissionMode = VALID_REMOTE_PERMISSION_MODES.includes(currentPermissionMode as PermissionMode)
                ? currentPermissionMode as CodexPermissionMode
                : undefined;
            if (useSharedAppServer) {
                sharedLocalTurnCompletionGate.adoptActiveTurn(client.turnId);
                permissionHandler?.reset('Local Codex took over approval handling');
                client.setApprovalHandlingMode('observer');
            }
            const result = await launchNativeCodex({
                cwd: process.cwd(),
                codexHomeDir: process.env.CODEX_HOME,
                codexThreadId,
                nativeResumeArgs: !codexThreadId ? nativeResumeArgsPending : undefined,
                remoteEndpoint: useSharedAppServer ? await ensureSharedTuiProxyEndpoint() : undefined,
                // The shared app-server already owns Happy's external sandbox.
                // Wrapping the disposable remote TUI again would create a
                // second sandbox lifecycle around a client that executes no tools.
                sandboxConfig: useSharedAppServer ? undefined : sandboxConfig,
                sandboxManagedByHappy: useSharedAppServer ? client.sandboxEnabled : undefined,
                model: currentModel,
                effort: currentEffort,
                permissionMode: nativePermissionMode,
                // Shared mode streams the canonical events directly from the
                // app-server. Tailing the same rollout would duplicate them.
                onRolloutEvent: useSharedAppServer ? undefined : handleLocalRolloutEvent,
                onThreadIdDiscovered: useSharedAppServer ? undefined : (threadId) => {
                    activeCodexThreadId = threadId;
                    session.updateMetadata((currentMetadata) => ({
                        ...currentMetadata,
                        codexThreadId: threadId,
                    }));
                },
                onLocalHandoffReady: (handoff) => {
                    localHandoff = handoff;
                    if (localHandoffRequested) {
                        handoff();
                    }
                },
                onTerminateReady: (terminate) => {
                    localTerminate = terminate;
                    if (localTerminateRequested) {
                        terminate();
                    }
                },
            });
            nativeResumeArgsPending = undefined;
            // Seal this launch's connection-scoped selector before changing
            // modes. close() waits for an in-flight selection callback, so a
            // terminated TUI cannot mutate ownership later in remote mode.
            if (useSharedAppServer) {
                await stopSharedTuiProxy();
            }
            await sharedLocalSubscriptionPromise;

            if (result.codexThreadId && !useSharedAppServer) {
                activeCodexThreadId = result.codexThreadId;
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    codexThreadId: result.codexThreadId,
                }));
            }

            // killSession can arrive after native Codex has exited but while
            // its rollout/sandbox cleanup is still finishing. Termination must
            // dominate the already-computed handoff result.
            if (localTerminateRequested) {
                exitCode = 0;
                return { type: 'exit', code: 0 };
            }

            if (result.type === 'switch') {
                if (pendingLocalTaskStarted) {
                    sendMappedCodexEvent(pendingLocalTaskStarted);
                    pendingLocalTaskStarted = null;
                }
                if (currentTurnId && !useSharedAppServer) {
                    sendMappedCodexEvent({ type: 'turn_aborted', status: 'cancelled' });
                }
                thinking = useSharedAppServer && client.hasActiveTurn();
                switchToRemote = true;
                localHandoffRequested = false;
                currentRunMode = 'remote';
                activeCodexThreadId = useSharedAppServer
                    ? client.threadId ?? activeCodexThreadId
                    : result.codexThreadId ?? activeCodexThreadId;
                if (activeCodexThreadId) {
                    session.updateMetadata((currentMetadata) => ({
                        ...currentMetadata,
                        codexThreadId: activeCodexThreadId,
                    }));
                }
                session.keepAlive(thinking, 'remote');
                session.updateAgentState((currentState) => ({
                    ...currentState,
                    controlledByUser: false,
                }));
                session.sendSessionEvent({ type: 'switch', mode: 'remote' });
            } else {
                exitCode = result.code;
            }
        } catch (error) {
            exitCode = 1;
            const message = error instanceof Error ? error.message : String(error);
            session.sendSessionEvent({
                type: 'message',
                message: `Codex local launch failed: ${message}`,
            });
            logger.warn('[codex]: Local Codex launch failed', error);
        } finally {
            if (process.stdin.isTTY) {
                try { process.stdin.setRawMode(false); } catch { }
            }
            try { process.stdin.pause(); } catch { }
            localHandoff = null;
            localTerminate = null;
            if (!switchToRemote) {
                await sharedLocalSubscriptionPromise;
                reconnectionHandle?.cancel();
                try {
                    await stopSharedTuiProxy();
                } catch (error) {
                    logger.debug('[codex]: Error while stopping native TUI proxy', error);
                    exitCode = 1;
                }
                try {
                    await client?.disconnectAndWait();
                } catch (error) {
                    logger.debug('[codex]: Error while stopping shared Codex backend', error);
                    exitCode = 1;
                }
                stopHappyMcpServer();
                try {
                    session.sendSessionDeath();
                    await session.flush();
                    await session.close();
                } catch (error) {
                    logger.debug('[codex]: Error while closing local session', error);
                }
                clearInterval(keepAliveInterval);
            }
        }

        return switchToRemote ? { type: 'switch-to-remote' } : { type: 'exit', code: exitCode };
    };

    // Debug helper: log active handles/requests if DEBUG is enabled
    function logActiveHandles(tag: string) {
        if (!process.env.DEBUG) return;
        const anyProc: any = process as any;
        const handles = typeof anyProc._getActiveHandles === 'function' ? anyProc._getActiveHandles() : [];
        const requests = typeof anyProc._getActiveRequests === 'function' ? anyProc._getActiveRequests() : [];
        logger.debug(`[codex][handles] ${tag}: handles=${handles.length} requests=${requests.length}`);
        try {
            const kinds = handles.map((h: any) => (h && h.constructor ? h.constructor.name : typeof h));
            logger.debug(`[codex][handles] kinds=${JSON.stringify(kinds)}`);
        } catch { }
    }

    //
    // Abort handling
    // IMPORTANT: There are two different operations:
    // 1. Abort (handleAbort): Stops the current inference/task but keeps the session alive
    //    - Used by the 'abort' RPC from mobile app
    //    - Similar to Claude Code's abort behavior
    //    - Allows continuing with new prompts after aborting
    // 2. Kill (handleKillSession): Terminates the entire process
    //    - Used by the 'killSession' RPC
    //    - Completely exits the CLI process
    //

    // AbortController is used ONLY to wake messageQueue.waitForMessages when idle.
    // Turn cancellation uses client.interruptTurn() — no AbortController hack needed.
    let abortController = new AbortController();
    let shouldExit = false;

    /**
     * Handles aborting the current task/inference without exiting the process.
     * This is the equivalent of Claude Code's abort - it stops what's currently
     * happening but keeps the session alive for new prompts.
     */
    async function handleAbort() {
        if (abortInProgress) {
            await abortInProgress;
            return;
        }

        logger.debug('[Codex] Abort requested - stopping current task');
        abortInProgress = (async () => {
            try {
                // Resolve any pending permission requests as 'abort' first.
                if (permissionHandler) {
                    permissionHandler.abortAll();
                }

                // Request interruption, then force-restart Codex app-server if
                // it doesn't settle quickly (long-running shell commands).
                if (client) {
                    const abortResult = await client.abortTurnWithFallback({
                        gracePeriodMs: 3000,
                        forceRestartOnTimeout: true,
                    });
                    if (abortResult.forcedRestart) {
                        logger.warn('[Codex] Forced app-server restart after interrupt timeout');
                        session.sendSessionEvent({
                            type: 'message',
                            message: abortResult.resumedThread
                                ? 'Force-stopped active task after interrupt timeout. Codex backend was restarted and the previous thread was resumed.'
                                : 'Force-stopped active task after interrupt timeout. Codex backend was restarted, but the previous thread could not be resumed.',
                        });
                    }
                }

                if (reasoningProcessor) {
                    reasoningProcessor.abort();
                }
                logger.debug('[Codex] Abort completed - session remains active');
            } catch (error) {
                logger.debug('[Codex] Error during abort:', error);
            } finally {
                // Wake up message queue wait if idle
                abortController.abort();
                abortController = new AbortController();
            }
        })();

        await abortInProgress;
        abortInProgress = null;
    }

    const handleSwitchToLocal = async (): Promise<boolean> => {
        if (terminating) {
            return false;
        }
        if (!canRunLocal) {
            session.sendSessionEvent({
                type: 'message',
                message: 'Local Codex mode requires an interactive terminal and is unavailable for daemon sessions.',
            });
            return false;
        }
        if (switchToLocalRequested) {
            return true;
        }
        switchToLocalRequested = true;
        shouldExit = true;
        if (useSharedAppServer) {
            // The TUI will attach to the same persistent app-server after the
            // current remote turn settles. Do not interrupt that turn merely
            // to change which client owns input.
            abortController.abort();
        } else {
            await handleAbort();
        }
        return true;
    };

    const ensureHappyMcpServers = async () => {
        happyServer ??= await startHappyServer(session);
        const bridgeEntrypoint = join(projectPath(), 'bin', 'happy-mcp.mjs');
        return {
            happy: {
                command: process.execPath,
                args: ['--no-warnings', '--no-deprecation', bridgeEntrypoint, '--url', happyServer.url],
            },
        } as const;
    };

    let sharedLocalSubscriptionThreadId: string | null = null;
    let sharedLocalSubscriptionTargetThreadId: string | null = null;
    let sharedLocalSubscriptionTargetPromise: Promise<void> | null = null;
    let sharedLocalSubscriptionPromise: Promise<void> = Promise.resolve();
    subscribeSharedLocalThread = (
        threadId: string,
        method: CodexTuiSelectionMethod,
        expectedActiveTurnId?: string,
    ): Promise<void> => {
        if (!useSharedAppServer || sharedLocalSubscriptionThreadId === threadId) {
            return Promise.resolve();
        }
        if (
            sharedLocalSubscriptionTargetThreadId === threadId
            && sharedLocalSubscriptionTargetPromise
        ) {
            return sharedLocalSubscriptionTargetPromise;
        }

        const operation = sharedLocalSubscriptionPromise.then(async () => {
            // A TUI selection response is held by the proxy until this work
            // finishes, so the selected thread cannot start its first turn
            // before Happy owns the corresponding app-server subscription.
            const resetLocalThreadState = (): void => {
                if (currentTurnId) {
                    try {
                        sendMappedCodexEvent({ type: 'turn_aborted', status: 'cancelled' });
                    } catch (error) {
                        logger.warn('[Codex] Could not close the previous local turn during thread selection', error);
                    }
                }
                currentTurnId = null;
                codexStartedSubagents.clear();
                codexActiveSubagents.clear();
                codexProviderSubagentToSessionSubagent.clear();
                pendingLocalTaskStarted = null;
                pendingLocalFailure = null;
                sharedLocalTurnCompletionGate.adoptActiveTurn(expectedActiveTurnId ?? null);
                thinking = false;
            };
            const commitLocalThreadState = (): void => {
                activeCodexThreadId = threadId;
                sharedLocalSubscriptionThreadId = threadId;
                thinking = client.hasActiveTurn();
                try {
                    session.updateMetadata((currentMetadata) => ({
                        ...currentMetadata,
                        codexThreadId: threadId,
                    }));
                } catch (error) {
                    logger.warn(`[Codex] Could not publish selected thread metadata for ${threadId}`, error);
                }
                try {
                    session.keepAlive(thinking, 'local');
                } catch (error) {
                    logger.warn(`[Codex] Could not publish selected thread activity for ${threadId}`, error);
                }
            };

            if (method === 'thread/start') {
                // A brand-new thread is not materialized on disk until its
                // first turn, so a second connection cannot resume it yet.
                // The proxy-correlated response is authoritative; adopt it
                // locally before releasing the response to the TUI.
                resetLocalThreadState();
                client.adoptThreadSelection(threadId, expectedActiveTurnId);
                commitLocalThreadState();
                logger.debug(`[Codex] Happy adopted new local thread ${threadId}`);
                return;
            }

            const mcpServers = await ensureHappyMcpServers();
            const executionPolicy = resolveCodexExecutionPolicy(
                currentPermissionMode ?? 'default',
                client.sandboxEnabled,
            );
            if (client.threadId !== threadId) {
                for (let attempt = 0; ; attempt += 1) {
                    try {
                        await client.resumeThread({
                            threadId,
                            model: currentModel,
                            cwd: process.cwd(),
                            approvalPolicy: executionPolicy.approvalPolicy,
                            sandbox: executionPolicy.sandbox,
                            mcpServers,
                            emitActiveTurnSnapshot: true,
                            expectedActiveTurnId,
                            beforeEventReplay: resetLocalThreadState,
                        });
                        break;
                    } catch (error) {
                        const rolloutNotReady = error instanceof CodexRpcError
                            && error.code === -32600
                            && error.message.includes('no rollout found');
                        if (!rolloutNotReady || attempt >= 5) {
                            throw error;
                        }
                        await new Promise((resolve) => setTimeout(resolve, 100 + attempt * 100));
                    }
                }
            } else {
                sharedLocalTurnCompletionGate.adoptActiveTurn(client.turnId);
            }
            commitLocalThreadState();
            logger.debug(`[Codex] Happy subscribed to active local thread ${threadId}`);
        });
        sharedLocalSubscriptionTargetThreadId = threadId;
        sharedLocalSubscriptionTargetPromise = operation;
        sharedLocalSubscriptionPromise = operation.then(() => {
            if (sharedLocalSubscriptionTargetPromise === operation) {
                sharedLocalSubscriptionTargetThreadId = null;
                sharedLocalSubscriptionTargetPromise = null;
            }
        }, (error) => {
            if (sharedLocalSubscriptionTargetPromise === operation) {
                sharedLocalSubscriptionTargetThreadId = null;
                sharedLocalSubscriptionTargetPromise = null;
            }
            logger.warn(`[Codex] Could not subscribe to active local thread ${threadId}`, error);
            session.sendSessionEvent({
                type: 'message',
                message: 'Happy could not attach to the active local Codex thread; phone updates may be incomplete.',
            });
        });
        return operation;
    };

    const restoreParentTerminal = (): void => {
        if (process.stdin.isTTY) {
            try { process.stdin.setRawMode(false); } catch { }
        }
        try { process.stdin.pause(); } catch { }
    };

    /**
     * Handles session termination and process exit.
     * This is called when the session needs to be completely killed (not just aborted).
     * Abort stops the current inference but keeps the session alive.
     * Kill terminates the entire process.
     */
    let terminationPromise: Promise<void> | null = null;
    const handleKillSession = (archive: boolean = true): Promise<void> => {
        if (terminationPromise) {
            return terminationPromise;
        }

        terminating = true;
        localTerminateRequested = true;
        shouldExit = true;
        abortController.abort();
        terminationPromise = (async () => {
            logger.debug('[Codex] Kill session requested - terminating process');
            if (archive) {
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason: 'User terminated',
                }));
            }

            if (currentRunMode === 'local') {
                localTerminate?.();
                return;
            }

            // A terminal shutdown must never enter the abort fallback that can
            // restart app-server. Disconnecting resolves the pending turn.
            permissionHandler?.abortAll();
            reasoningProcessor?.abort();
            localTerminate?.();

            try {
                let backendShutdownFailed = false;
                try {
                    await stopSharedTuiProxy();
                } catch (e) {
                    backendShutdownFailed = true;
                    logger.debug('[Codex] Error stopping native TUI proxy during termination', e);
                }
                try {
                    await client?.disconnectAndWait();
                } catch (e) {
                    backendShutdownFailed = true;
                    logger.debug('[Codex] Error disconnecting Codex during termination', e);
                }

                stopHappyMcpServer();
                session.sendSessionDeath();
                await session.flush();
                await session.close();

                logger.debug('[Codex] Session termination complete, exiting');
                restoreParentTerminal();
                process.exit(backendShutdownFailed ? 1 : 0);
            } catch (error) {
                logger.debug('[Codex] Error during session termination:', error);
                restoreParentTerminal();
                process.exit(1);
            }
        })();

        return terminationPromise;
    };

    // In local mode, abort means the phone is taking control. The queued
    // message (if any) is processed after the native TUI hands the thread back.
    const handleAbortRequest = async () => {
        if (terminating) {
            return;
        }
        if (currentRunMode === 'local' || switchToLocalRequested) {
            localHandoffRequested = true;
            localHandoff?.();
            return;
        }
        await handleAbort();
    };

    const handleSwitchRequest = async (request?: { to?: 'remote' | 'local' }): Promise<boolean> => {
        const action = resolveCodexSwitchAction({
            currentMode: currentRunMode,
            targetMode: request?.to,
            switchToLocalRequested,
            canRunLocal,
            terminating,
        });
        if (action === 'reject') {
            return false;
        }
        if (action === 'none') {
            return true;
        }
        if (action === 'switch-to-remote') {
            localHandoffRequested = true;
            localHandoff?.();
            return true;
        }
        return handleSwitchToLocal();
    };

    bindSessionHandlers = (targetSession) => {
        targetSession.onUserMessage(handleUserMessage);
        targetSession.rpcHandlerManager.registerHandler('abort', handleAbortRequest);
        targetSession.rpcHandlerManager.registerHandler<{ to?: 'remote' | 'local' }, boolean>('switch', handleSwitchRequest);
        registerKillSessionHandler(targetSession.rpcHandlerManager, () => handleKillSession(true));
    };
    bindSessionHandlers(session);

    const handleSigterm = (): void => {
        void handleKillSession(false);
    };
    process.on('SIGTERM', handleSigterm);

    if (useSharedAppServer) {
        try {
            const mcpServers = await ensureHappyMcpServers();
            await client.connect();
            const executionPolicy = resolveCodexExecutionPolicy(
                currentPermissionMode ?? 'default',
                client.sandboxEnabled,
            );
            const thread = activeCodexThreadId
                ? await client.resumeThread({
                    threadId: activeCodexThreadId,
                    model: currentModel,
                    cwd: process.cwd(),
                    approvalPolicy: executionPolicy.approvalPolicy,
                    sandbox: executionPolicy.sandbox,
                    mcpServers,
                })
                : currentRunMode === 'local'
                    ? null
                    : await client.startThread({
                    model: currentModel,
                    cwd: process.cwd(),
                    approvalPolicy: executionPolicy.approvalPolicy,
                    sandbox: executionPolicy.sandbox,
                    mcpServers,
                });
            if (thread) {
                activeCodexThreadId = thread.threadId;
                sharedLocalSubscriptionThreadId = thread.threadId;
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    codexThreadId: thread.threadId,
                }));
            }
        } catch (error) {
            try { await client.disconnectAndWait(); } catch { }
            stopHappyMcpServer();
            reconnectionHandle?.cancel();
            clearInterval(keepAliveInterval);
            process.removeListener('SIGTERM', handleSigterm);
            try {
                session.sendSessionDeath();
                await session.flush();
                await session.close();
            } catch (cleanupError) {
                logger.debug('[codex]: Error cleaning up failed shared backend startup', cleanupError);
            }
            throw error;
        }
    }

    if (currentRunMode === 'local') {
        const localResult = await launchLocalCodexSession(activeCodexThreadId);
        await sharedLocalSubscriptionPromise;
        if (localResult.type === 'exit') {
            process.exit(localResult.code);
        }
    }

    while (currentRunMode === 'remote' && !terminating) {
        shouldExit = false;
        switchToLocalRequested = false;
        abortController = new AbortController();
        let shouldRestartRemote = false;
        let fatalHandoffError: Error | null = null;

    //
    // Initialize Ink UI
    //

    const messageBuffer = new MessageBuffer();
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    let inkInstance: any = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(CodexDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
            onExit: async () => {
                // Exit the agent
                logger.debug('[codex]: Exiting agent via Ctrl-C');
                shouldExit = true;
                await handleAbort();
            },
            onSwitchToLocal: handleSwitchToLocal,
        }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding("utf8");
    }

    //
    // Start Context 
    //

    if (!useSharedAppServer) {
        client = new CodexAppServerClient(sandboxConfig);
    }

    permissionHandler = new CodexPermissionHandler(session);
    // Drop any permission requests left in agent state from a previous CLI
    // process that died while a tool prompt was open — see the matching
    // call in claudeRemoteLauncher for the full rationale.
    permissionHandler.reset('Previous CLI process exited before responding');
    reasoningProcessor = new ReasoningProcessor((message) => {
        const envelopes = mapCodexProcessorMessageToSessionEnvelopes(message, { currentTurnId });
        for (const envelope of envelopes) {
            session.sendSessionProtocolMessage(envelope);
        }
    });
    const diffProcessor = new DiffProcessor((message) => {
        const envelopes = mapCodexProcessorMessageToSessionEnvelopes(message, { currentTurnId });
        for (const envelope of envelopes) {
            session.sendSessionProtocolMessage(envelope);
        }
    });

    // Approval handler: routes server → client approval requests to our permission handler
    client.setApprovalHandler(async (params) => {
        const toolName = params.type === 'exec'
            ? 'CodexBash'
            : params.type === 'patch'
                ? 'CodexPatch'
                : (params.toolName ?? 'McpTool');
        const input = params.type === 'exec'
            ? { command: params.command, cwd: params.cwd }
            : params.type === 'patch'
                ? { changes: params.fileChanges }
                : (params.input ?? {});

        try {
            const result = await permissionHandler.handleToolCall(params.callId, toolName, input);
            logger.debug('[Codex] Permission result:', result.decision);
            return result.decision;
        } catch (error) {
            logger.debug('[Codex] Error handling permission:', error);
            return 'denied';
        }
    });

    // Event handler: same EventMsg types as the legacy MCP server — no changes needed
    client.setEventHandler((msg) => {
        if (useSharedAppServer && currentRunMode === 'local') {
            handleSharedLocalEvent(msg);
            return;
        }
        // Phone-originated text is already persisted by the Happy message API.
        // Only the local TUI path needs the app-server's userMessage item.
        if (msg.type === 'user_message') {
            return;
        }
        logger.debug(`[Codex] Event: ${JSON.stringify(msg)}`);

        // Add messages to the ink UI buffer based on message type
        if (msg.type === 'agent_message') {
            messageBuffer.addMessage((msg as any).message, 'assistant');
        } else if (msg.type === 'agent_reasoning_delta') {
            // Skip reasoning deltas in the UI to reduce noise
        } else if (msg.type === 'agent_reasoning') {
            messageBuffer.addMessage(`[Thinking] ${(msg as any).text.substring(0, 100)}...`, 'system');
        } else if (msg.type === 'exec_command_begin') {
            messageBuffer.addMessage(`Executing: ${(msg as any).command}`, 'tool');
        } else if (msg.type === 'exec_command_end') {
            const output = (msg as any).output || (msg as any).error || 'Command completed';
            const truncatedOutput = output.substring(0, 200);
            messageBuffer.addMessage(
                `Result: ${truncatedOutput}${output.length > 200 ? '...' : ''}`,
                'result'
            );
        } else if (msg.type === 'task_started') {
            messageBuffer.addMessage('Starting task...', 'status');
        } else if (msg.type === 'task_complete') {
            // Ready is emitted from the main loop's idle check so pushes only fire once
            // after the queue is actually drained.
            const failure = describeCodexFailure(msg);
            if (failure) {
                messageBuffer.addMessage(`Task failed: ${failure}`, 'status');
                session.sendSessionEvent({ type: 'message', message: `Codex error: ${failure}` });
            } else {
                messageBuffer.addMessage('Task completed', 'status');
            }
        } else if (msg.type === 'turn_aborted') {
            const failure = describeCodexFailure(msg);
            if (failure) {
                messageBuffer.addMessage(`Turn aborted: ${failure}`, 'status');
                session.sendSessionEvent({ type: 'message', message: `Codex error: ${failure}` });
            } else {
                messageBuffer.addMessage('Turn aborted', 'status');
            }
        }

        if (msg.type === 'task_started') {
            if (!thinking) {
                logger.debug('thinking started');
                thinking = true;
                session.keepAlive(thinking, 'remote');
            }
        }
        if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
            if (thinking) {
                logger.debug('thinking completed');
                thinking = false;
                session.keepAlive(thinking, 'remote');
            }
            // Reset diff processor on task end or abort
            diffProcessor.reset();
        }
        if (msg.type === 'agent_reasoning_section_break') {
            reasoningProcessor.handleSectionBreak();
        }
        if (msg.type === 'agent_reasoning_delta') {
            reasoningProcessor.processDelta((msg as any).delta);
        }
        if (msg.type === 'agent_reasoning') {
            reasoningProcessor.complete((msg as any).text);
        }
        if (msg.type === 'patch_apply_begin') {
            const { changes } = msg as any;
            const changeCount = Object.keys(changes).length;
            const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
            messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');
        }
        if (msg.type === 'patch_apply_end') {
            const { stdout, stderr, success } = msg as any;
            if (success) {
                const message = stdout || 'Files modified successfully';
                messageBuffer.addMessage(message.substring(0, 200), 'result');
            } else {
                const errorMsg = stderr || 'Failed to modify files';
                messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
            }
        }
        if (msg.type === 'turn_diff') {
            if ((msg as any).unified_diff) {
                diffProcessor.processDiff((msg as any).unified_diff);
            }
        }

        // Convert events into the unified session-protocol envelope stream.
        // Reasoning deltas are handled by ReasoningProcessor to avoid duplicate text output.
        if (msg.type !== 'agent_reasoning_delta' && msg.type !== 'agent_reasoning' && msg.type !== 'agent_reasoning_section_break' && msg.type !== 'turn_diff') {
            sendMappedCodexEvent(msg);
        }
    });

    if (useSharedAppServer) {
        client.setApprovalHandlingMode('active');
        if (client.hasActiveTurn()) {
            thinking = true;
            session.keepAlive(true, 'remote');
        }
    }

    // Start Happy MCP server (HTTP) and prepare STDIO bridge config for Codex
    const mcpServers = await ensureHappyMcpServers();
    let first = true;

    try {
        logger.debug('[codex]: client.connect begin');
        await client.connect();
        logger.debug('[codex]: client.connect done');

        const threadToResume = activeCodexThreadId ?? client.threadId ?? undefined;
        if (threadToResume) {
            await resumeExistingThread({
                client,
                session,
                messageBuffer,
                threadId: threadToResume,
                cwd: process.cwd(),
                mcpServers,
            });
            activeCodexThreadId = threadToResume;
            first = false;
        }

        let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = null;

        while (!shouldExit) {
            logActiveHandles('loop-top');
            let message: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = pending;
            pending = null;
            if (!message) {
                // Capture the current signal to distinguish idle-abort from queue close
                const waitSignal = abortController.signal;
                const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
                if (!batch) {
                    // If wait was aborted (e.g., remote abort with no active inference), ignore and continue
                    if (waitSignal.aborted && !shouldExit) {
                        logger.debug('[codex]: Wait aborted while idle; ignoring and continuing');
                        continue;
                    }
                    logger.debug(`[codex]: batch=${!!batch}, shouldExit=${shouldExit}`);
                    break;
                }
                message = batch;
            }

            // Defensive check for TS narrowing
            if (!message) {
                break;
            }

            // Display user messages in the UI
            messageBuffer.addMessage(message.message, 'user');

            try {
                // Map permission mode to approval policy and sandbox.
                // With app-server, these are per-turn — no restart needed on mode change.
                const sandboxManagedByHappy = client.sandboxEnabled;
                const executionPolicy = resolveCodexExecutionPolicy(
                    message.mode.permissionMode,
                    sandboxManagedByHappy,
                );

                // Start thread on first turn (thread persists across mode changes)
                if (!client.hasActiveThread()) {
                    const startedThread = await client.startThread({
                        model: message.mode.model,
                        cwd: process.cwd(),
                        approvalPolicy: executionPolicy.approvalPolicy,
                        sandbox: executionPolicy.sandbox,
                        mcpServers,
                    });
                    activeCodexThreadId = startedThread.threadId;
                    session.updateMetadata((currentMetadata) => ({
                        ...currentMetadata,
                        codexThreadId: startedThread.threadId,
                    }));
                }

                const turnPrompt = first
                    ? message.message + '\n\n' + CHANGE_TITLE_INSTRUCTION
                    : message.message;

                if (useSharedAppServer && client.hasActiveTurn()) {
                    try {
                        const steered = await client.steerTurn(message.message, {
                            clientUserMessageId: message.hash,
                        });
                        first = false;
                        logger.debug(`[Codex] Steered phone input into active turn ${steered.turnId}`);
                        const becameIdle = await client.waitForTurnIdle();
                        if (!becameIdle) {
                            throw new Error('Timed out waiting for the steered Codex turn to complete.');
                        }
                        continue;
                    } catch (error) {
                        if (!(error instanceof CodexRpcError) || error.code !== -32600) {
                            throw error;
                        }

                        await client.refreshActiveTurn();
                        if (client.hasActiveTurn()) {
                            try {
                                const steered = await client.steerTurn(message.message, {
                                    clientUserMessageId: message.hash,
                                });
                                first = false;
                                logger.debug(`[Codex] Steered phone input after reconciling active turn ${steered.turnId}`);
                                const becameIdle = await client.waitForTurnIdle();
                                if (!becameIdle) {
                                    throw new Error('Timed out waiting for the reconciled Codex turn to complete.');
                                }
                                continue;
                            } catch (retryError) {
                                if (!(retryError instanceof CodexRpcError) || retryError.code !== -32600) {
                                    throw retryError;
                                }

                                // The active turn is not steerable (for example,
                                // review/compact). Preserve the phone message and
                                // start it exactly once after the root turn idles.
                                pending = message;
                                const becameIdle = await client.waitForTurnIdle();
                                if (!becameIdle) {
                                    throw new Error('Timed out waiting for the active Codex turn before replaying phone input.');
                                }
                                continue;
                            }
                        }
                        // The turn completed between queueing and steering.
                        // Fall through and start a normal next turn.
                        logger.debug('[Codex] Active turn completed before steering; starting phone input as the next turn');
                    }
                }

                const result = await client.sendTurnAndWait(turnPrompt, {
                    model: message.mode.model,
                    approvalPolicy: executionPolicy.approvalPolicy,
                    sandbox: executionPolicy.sandbox,
                    effort: message.mode.effort,
                });
                first = false;

                if (result.aborted) {
                    // Turn was aborted (user abort or permission cancel).
                    // UI handling already done by the event handler (turn_aborted).
                    logger.debug('[Codex] Turn aborted');
                }
            } catch (error) {
                // Only actual errors reach here (process crash, connection failure, etc.)
                logger.warn('Error in codex session:', error);
                messageBuffer.addMessage('Process exited unexpectedly', 'status');
                session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
            } finally {
                // Reset permission handler, reasoning processor, and diff processor
                permissionHandler.reset();
                reasoningProcessor.abort();  // Use abort to properly finish any in-progress tool calls
                diffProcessor.reset();
                thinking = false;
                session.keepAlive(thinking, 'remote');
                emitReadyIfIdle({
                    pending,
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    sendReady,
                });
                logActiveHandles('after-turn');
            }
        }

    } finally {
        const switchingToLocal = switchToLocalRequested && !terminating;
        let canLaunchLocal = true;
        // Clean up resources when the remote runner exits. During a handoff,
        // the Happy session and queue stay alive while only app-server/Ink stop.
        logger.debug('[codex]: Final cleanup start');
        logActiveHandles('cleanup-start');

        // Cancel offline reconnection if still running
        if (reconnectionHandle && !switchingToLocal) {
            logger.debug('[codex]: Cancelling offline reconnection');
            reconnectionHandle.cancel();
        }

        if (!switchingToLocal && !terminating) {
            try {
                logger.debug('[codex]: sendSessionDeath');
                session.sendSessionDeath();
                logger.debug('[codex]: flush begin');
                await session.flush();
                logger.debug('[codex]: flush done');
                logger.debug('[codex]: session.close begin');
                await session.close();
                logger.debug('[codex]: session.close done');
            } catch (error) {
                logger.debug('[codex]: Error while closing session', error);
            }
        }

        const preserveSharedBackend = useSharedAppServer && switchingToLocal;
        if (!preserveSharedBackend) {
            try {
                logger.debug('[codex]: native TUI proxy close begin');
                await stopSharedTuiProxy();
                logger.debug('[codex]: native TUI proxy close done');
            } catch (error) {
                logger.debug('[codex]: Error while stopping native TUI proxy', error);
            }
            try {
                logger.debug('[codex]: client.disconnect begin');
                await client?.disconnectAndWait();
                logger.debug('[codex]: client.disconnect done');
            } catch (error) {
                logger.debug('[codex]: Error while disconnecting client', error);
                if (switchingToLocal) {
                    canLaunchLocal = false;
                    fatalHandoffError = error instanceof Error ? error : new Error(String(error));
                    session.sendSessionEvent({
                        type: 'message',
                        message: 'Could not switch to local mode because the Codex backend did not stop cleanly.',
                    });
                }
            }
        }

        if (!preserveSharedBackend) {
            // Stop Happy MCP server only when the backend itself stops. A
            // shared local/remote handoff keeps tool calls and subagents alive.
            logger.debug('[codex]: happyServer.stop');
            stopHappyMcpServer();
        }

        if (inkInstance) {
            logger.debug('[codex]: inkInstance.unmount()');
            inkInstance.unmount();
        }

        if (switchingToLocal) {
            await cleanupStdinAfterInk({
                stdin: process.stdin,
                drainMs: 150,
                leaveRawMode: canLaunchLocal,
                onDebug: (event) => {
                    logger.debug(`[codex]: stdin drain ${event.bytes}B / ${event.chunks} chunk(s)`);
                },
            });
        } else {
            if (process.stdin.isTTY) {
                logger.debug('[codex]: setRawMode(false)');
                try { process.stdin.setRawMode(false); } catch { }
            }
            if (hasTTY) {
                logger.debug('[codex]: stdin.pause()');
                try { process.stdin.pause(); } catch { }
            }
            logger.debug('[codex]: clearInterval(keepAlive)');
            clearInterval(keepAliveInterval);
        }

        messageBuffer.clear();

        logActiveHandles('cleanup-end');
        logger.debug('[codex]: Final cleanup completed');

        const remoteTakeoverPending = localHandoffRequested || messageQueue.size() > 0;
        if (switchingToLocal && localTerminateRequested && canLaunchLocal && !fatalHandoffError) {
            const localResult = await launchLocalCodexSession(activeCodexThreadId);
            process.exit(localResult.type === 'exit' ? localResult.code : 0);
        } else if (switchingToLocal && canLaunchLocal && !remoteTakeoverPending) {
            currentRunMode = 'local';
            session.keepAlive(thinking, 'local');
            session.updateAgentState((currentState) => ({
                ...currentState,
                controlledByUser: true,
            }));
            session.sendSessionEvent({ type: 'switch', mode: 'local' });
            const localResult = await launchLocalCodexSession(activeCodexThreadId);
            if (localResult.type === 'exit') {
                process.exit(localResult.code);
            }
            shouldRestartRemote = true;
        } else if (switchingToLocal && !fatalHandoffError) {
            localHandoffRequested = false;
            currentRunMode = 'remote';
            session.keepAlive(thinking, 'remote');
            session.updateAgentState((currentState) => ({
                ...currentState,
                controlledByUser: false,
            }));
            shouldRestartRemote = true;
        } else if (fatalHandoffError) {
            reconnectionHandle?.cancel();
            clearInterval(keepAliveInterval);
            try {
                session.sendSessionDeath();
                await session.flush();
                await session.close();
            } catch (error) {
                logger.debug('[codex]: Error closing session after failed backend shutdown', error);
            }
        }
    }

        if (terminating) {
            await terminationPromise;
            break;
        }
        if (fatalHandoffError) {
            throw fatalHandoffError;
        }
        if (!shouldRestartRemote) {
            break;
        }
    }
    process.removeListener('SIGTERM', handleSigterm);
}
