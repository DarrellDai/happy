import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn as crossSpawn } from 'cross-spawn';

import type { PermissionMode } from '@/api/types';
import type { SandboxConfig } from '@/persistence';
import { initializeSandbox as defaultInitializeSandbox, wrapForMcpTransport } from '@/sandbox/manager';
import { logger } from '@/ui/logger';
import { ensureLocalProxyBypass } from '@/claude/utils/proxyBypass';
import {
    signalPosixProcessDescendants,
    signalProcessIds as defaultSignalProcessIds,
    waitForProcessIdsToExit,
} from '@/utils/processTree';
import type { ReasoningEffort } from './codexAppServerTypes';
import type { CodexLauncherResult } from './modeLoop';
import { findOpenCodexRolloutPaths } from './codexOpenRollouts';
import {
    discoverCodexThreadId,
    findActiveCodexThread,
    findCodexRolloutPathByThreadId,
    type ActiveCodexThread,
} from './codexThreadDiscovery';
import { getCodexRolloutSize, tailCodexRollout } from './codexRolloutTailer';

export type CodexPermissionMode = Extract<PermissionMode, 'default' | 'read-only' | 'safe-yolo' | 'yolo'>;

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => Pick<ChildProcess, 'kill' | 'once' | 'pid'>;
type DiscoverThreadIdFn = typeof discoverCodexThreadId;
type InitializeSandboxFn = typeof defaultInitializeSandbox;
type WrapForSandboxFn = typeof wrapForMcpTransport;
type FindRolloutPathFn = typeof findCodexRolloutPathByThreadId;
type FindActiveThreadFn = typeof findActiveCodexThread;
type GetRolloutSizeFn = typeof getCodexRolloutSize;
type TailRolloutFn = typeof tailCodexRollout;
type SignalPosixDescendantsFn = typeof signalPosixProcessDescendants;
type SignalProcessIdsFn = typeof defaultSignalProcessIds;
type WaitForProcessIdsToExitFn = typeof waitForProcessIdsToExit;
type FindOpenRolloutPathsFn = typeof findOpenCodexRolloutPaths;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDelay(signal: AbortSignal, ms: number): Promise<void> {
    if (signal.aborted) {
        return;
    }
    await new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        const onAbort = (): void => done();
        signal.addEventListener('abort', onAbort, { once: true });

        function done(): void {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            resolve();
        }
    });
}

function quoteForPosixShell(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function waitForDiscoveredThreadId(opts: {
    discoverThreadId: DiscoverThreadIdFn;
    codexHomeDir: string;
    cwd: string;
    startedAt: Date;
    originator: string;
    now: () => Date;
    pollMs: number;
    signal: AbortSignal;
}): Promise<string> {
    while (!opts.signal.aborted) {
        try {
            const threadId = await opts.discoverThreadId({
                codexHomeDir: opts.codexHomeDir,
                cwd: opts.cwd,
                startedAt: opts.startedAt,
                finishedAt: opts.now(),
                originator: opts.originator,
            });
            if (opts.signal.aborted) {
                break;
            }
            return threadId;
        } catch (error) {
            if (error instanceof Error && error.message.startsWith('Ambiguous Codex thread discovery')) {
                throw error;
            }
        }
        await delay(opts.pollMs);
    }

    throw new Error(`Codex thread discovery cancelled for cwd ${opts.cwd}.`);
}

export function buildCodexNativeArgs(opts: {
    codexThreadId?: string;
    remoteEndpoint?: string;
    model?: string;
    effort?: ReasoningEffort;
    permissionMode?: CodexPermissionMode;
    sandboxManagedByHappy?: boolean;
}): string[] {
    const args: string[] = [];

    if (opts.remoteEndpoint) {
        args.push('--remote', opts.remoteEndpoint);
    }

    if (opts.codexThreadId) {
        args.push('resume', opts.codexThreadId);
    }

    if (opts.model) {
        args.push('--model', opts.model);
    }

    if (opts.effort) {
        args.push('-c', `model_reasoning_effort="${opts.effort}"`);
    }

    if (opts.sandboxManagedByHappy) {
        args.push('--ask-for-approval', 'never', '--sandbox', 'danger-full-access');
        return args;
    }

    switch (opts.permissionMode) {
        case undefined:
        case 'default':
            args.push('--ask-for-approval', 'untrusted', '--sandbox', 'workspace-write');
            break;
        case 'read-only':
            args.push('--ask-for-approval', 'never', '--sandbox', 'read-only');
            break;
        case 'safe-yolo':
            args.push('--ask-for-approval', 'never', '--sandbox', 'workspace-write');
            break;
        case 'yolo':
            args.push('--ask-for-approval', 'never', '--sandbox', 'danger-full-access');
            break;
    }

    return args;
}

export async function launchNativeCodex(opts: {
    cwd: string;
    codexHomeDir?: string;
    codexThreadId?: string;
    remoteEndpoint?: string;
    model?: string;
    effort?: ReasoningEffort;
    permissionMode?: CodexPermissionMode;
    sandboxConfig?: SandboxConfig;
    sandboxManagedByHappy?: boolean;
    spawn?: SpawnFn;
    initializeSandbox?: InitializeSandboxFn;
    wrapForSandbox?: WrapForSandboxFn;
    now?: () => Date;
    discoverThreadId?: DiscoverThreadIdFn;
    findActiveThread?: FindActiveThreadFn;
    findOpenRolloutPaths?: FindOpenRolloutPathsFn;
    findRolloutPath?: FindRolloutPathFn;
    getRolloutSize?: GetRolloutSizeFn;
    tailRollout?: TailRolloutFn;
    signalPosixDescendants?: SignalPosixDescendantsFn;
    signalProcessIds?: SignalProcessIdsFn;
    waitForProcessIdsExit?: WaitForProcessIdsToExitFn;
    discoveryPollMs?: number;
    activeThreadPollMs?: number;
    exitDiscoveryGraceMs?: number;
    handoffDiscoveryGraceMs?: number;
    terminationGraceMs?: number;
    forceKillWaitMs?: number;
    originatorOverride?: string;
    onThreadIdDiscovered?: (threadId: string) => void;
    onRolloutEvent?: (event: Record<string, unknown>) => void;
    onLocalHandoffReady?: (handoff: () => void) => void;
    onTerminateReady?: (terminate: () => void) => void;
}): Promise<CodexLauncherResult> {
    const spawn = opts.spawn ?? crossSpawn;
    const now = opts.now ?? (() => new Date());
    const startedAt = now();
    const originator = opts.originatorOverride ?? `happy-codex-local-${randomUUID()}`;
    const codexHomeDir = opts.codexHomeDir ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
    let sandboxCleanup: (() => Promise<void>) | null = null;
    let removeParentSignalHandlers = (): void => undefined;
    type RolloutTailRun = {
        threadId: string;
        path: string | null;
        abort: AbortController;
        startupPromise: Promise<void> | null;
        promise: Promise<void> | null;
    };
    let activeRolloutTail: RolloutTailRun | null = null;
    let rolloutTailSwitch = Promise.resolve();
    let rolloutTailsClosed = false;
    const activeThreadMonitorAbort = new AbortController();
    let activeThreadMonitorPromise: Promise<void> | null = null;
    let handoffReconciliationPromise: Promise<void> | null = null;

    const startRolloutTail = async (
        threadId: string,
        startAtEnd: boolean,
        knownPath?: string,
    ): Promise<void> => {
        if (!opts.onRolloutEvent) {
            return;
        }
        const switchOperation = rolloutTailSwitch.then(async () => {
            if (rolloutTailsClosed) {
                return;
            }
            if (
                activeRolloutTail?.threadId === threadId &&
                (!knownPath || activeRolloutTail.path === knownPath)
            ) {
                return;
            }

            const previous = activeRolloutTail;
            if (previous) {
                previous.abort.abort();
                await previous.startupPromise;
                await previous.promise;
            }
            if (rolloutTailsClosed) {
                return;
            }

            const findRolloutPath = opts.findRolloutPath ?? findCodexRolloutPathByThreadId;
            const getRolloutSize = opts.getRolloutSize ?? getCodexRolloutSize;
            const tailRollout = opts.tailRollout ?? tailCodexRollout;
            const run: RolloutTailRun = {
                threadId,
                path: knownPath ?? null,
                abort: new AbortController(),
                startupPromise: null,
                promise: null,
            };
            activeRolloutTail = run;
            run.startupPromise = (async () => {
                try {
                    const path = knownPath ?? await findRolloutPath(codexHomeDir, threadId);
                    run.path = path;
                    if (run.abort.signal.aborted || activeRolloutTail !== run) {
                        return;
                    }
                    if (!path) {
                        logger.debug(`[CodexLocal] Could not find rollout path for thread ${threadId}`);
                        return;
                    }
                    const startOffset = startAtEnd ? await getRolloutSize(path) : 0;
                    if (run.abort.signal.aborted || activeRolloutTail !== run) {
                        return;
                    }
                    run.promise = tailRollout({
                        path,
                        startOffset,
                        signal: run.abort.signal,
                        onEvent: opts.onRolloutEvent!,
                    }).catch((error) => {
                        logger.debug(`[CodexLocal] Rollout tail failed: ${String(error)}`);
                    });
                } catch (error) {
                    logger.debug(`[CodexLocal] Could not start rollout tail: ${String(error)}`);
                }
            })();
            await run.startupPromise;
        });
        rolloutTailSwitch = switchOperation.catch((error) => {
            logger.debug(`[CodexLocal] Could not switch rollout tail: ${String(error)}`);
        });
        await switchOperation;
    };

    const stopRolloutTails = async (): Promise<void> => {
        rolloutTailsClosed = true;
        activeRolloutTail?.abort.abort();
        await rolloutTailSwitch;
        activeRolloutTail?.abort.abort();
        await activeRolloutTail?.startupPromise;
        await activeRolloutTail?.promise;
    };

    try {
        if (opts.codexThreadId) {
            await startRolloutTail(opts.codexThreadId, true);
        }
        let command = 'codex';
        let args = buildCodexNativeArgs({
            ...opts,
            sandboxManagedByHappy: opts.sandboxManagedByHappy
                ?? Boolean(opts.sandboxConfig?.enabled && process.platform !== 'win32'),
        });
        if (opts.sandboxConfig?.enabled && process.platform !== 'win32') {
            const initializeSandbox = opts.initializeSandbox ?? defaultInitializeSandbox;
            const wrapForSandbox = opts.wrapForSandbox ?? (async (nativeCommand: string, nativeArgs: string[]) => {
                const wrapped = await wrapForMcpTransport(nativeCommand, nativeArgs.map(quoteForPosixShell));
                return {
                    command: wrapped.command,
                    // Replace the wrapper shell with the sandbox process so a
                    // handoff signal cannot orphan native Codex behind `sh -c`.
                    args: ['-c', `exec ${wrapped.args[1]}`] as ['-c', string],
                };
            });
            sandboxCleanup = await initializeSandbox(opts.sandboxConfig, opts.cwd);
            const wrapped = await wrapForSandbox(command, args);
            command = wrapped.command;
            args = wrapped.args;
        }

        try {
            process.stdin.pause();
        } catch (error) {
            logger.debug(`[CodexLocal] Failed to pause parent stdin: ${String(error)}`);
        }
        const stdinHandle = (process.stdin as NodeJS.ReadStream & { _handle?: { setBlocking?: (blocking: boolean) => void } })._handle;
        if (stdinHandle?.setBlocking) {
            try {
                stdinHandle.setBlocking(true);
            } catch (error) {
                logger.debug(`[CodexLocal] Failed to restore blocking stdin: ${String(error)}`);
            }
        }

        const childEnv: Record<string, string | undefined> = {
            ...process.env,
            CODEX_INTERNAL_ORIGINATOR_OVERRIDE: originator,
        };
        if (opts.remoteEndpoint) {
            ensureLocalProxyBypass(childEnv);
        }
        const child = spawn(command, args, {
            cwd: opts.cwd,
            stdio: 'inherit',
            env: childEnv,
            windowsHide: true,
        });
        let discoveredThreadId = opts.codexThreadId;
        let handoffRequested = false;
        let terminationRequested = false;
        let childExited = false;
        let terminationSignalSent = false;
        let forceKillTimer: NodeJS.Timeout | null = null;
        let terminationFailureTimer: NodeJS.Timeout | null = null;
        let handoffDiscoveryTimer: NodeJS.Timeout | null = null;
        let rejectChildExit: ((error: unknown) => void) | null = null;
        let activeThreadConfirmedByOpenRollout = false;
        const ownedDescendantPids = new Set<number>();
        const signalPosixDescendants = opts.signalPosixDescendants
            ?? (opts.spawn ? (() => []) : signalPosixProcessDescendants);
        const signalProcessIds = opts.signalProcessIds
            ?? (opts.spawn ? (() => undefined) : defaultSignalProcessIds);
        const waitForProcessIdsExit = opts.waitForProcessIdsExit
            ?? (opts.spawn ? (async () => []) : waitForProcessIdsToExit);
        const killWindowsProcessTree = (): void => {
            if (typeof child.pid !== 'number') {
                child.kill('SIGKILL');
                return;
            }
            try {
                const killer = crossSpawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
                    stdio: 'ignore',
                    windowsHide: true,
                });
                killer.once('error', () => {
                    try { child.kill('SIGKILL'); } catch { }
                });
            } catch {
                child.kill('SIGKILL');
            }
        };
        const requestChildTermination = (): void => {
            if (childExited) {
                return;
            }
            if (!terminationSignalSent) {
                terminationSignalSent = true;
                try {
                    if (process.platform === 'win32') {
                        killWindowsProcessTree();
                    } else {
                        if (typeof child.pid === 'number') {
                            for (const pid of signalPosixDescendants(child.pid, 'SIGTERM')) {
                                ownedDescendantPids.add(pid);
                            }
                        }
                        child.kill('SIGTERM');
                    }
                } catch (error) {
                    logger.debug(`[CodexLocal] Failed to terminate native Codex: ${String(error)}`);
                }
            }
            if (!forceKillTimer) {
                forceKillTimer = setTimeout(() => {
                    if (!childExited) {
                        try {
                            if (process.platform === 'win32') {
                                killWindowsProcessTree();
                            } else {
                                if (typeof child.pid === 'number') {
                                    for (const pid of signalPosixDescendants(child.pid, 'SIGKILL')) {
                                        ownedDescendantPids.add(pid);
                                    }
                                }
                                signalProcessIds(ownedDescendantPids, 'SIGKILL');
                                child.kill('SIGKILL');
                            }
                        } catch (error) {
                            logger.debug(`[CodexLocal] Failed to force-kill native Codex: ${String(error)}`);
                        }
                    }
                    if (!childExited && !terminationFailureTimer) {
                        terminationFailureTimer = setTimeout(() => {
                            if (!childExited) {
                                rejectChildExit?.(new Error('Native Codex did not exit after SIGTERM/SIGKILL handoff.'));
                            }
                        }, opts.forceKillWaitMs ?? 1_000);
                    }
                }, opts.terminationGraceMs ?? 3_000);
                forceKillTimer.unref();
            }
        };
        const findActiveThread = opts.findActiveThread ?? findActiveCodexThread;
        const applyActiveThread = async (active: ActiveCodexThread): Promise<void> => {
            const threadChanged = discoveredThreadId !== active.threadId;
            discoveredThreadId = active.threadId;
            if (threadChanged) {
                opts.onThreadIdDiscovered?.(active.threadId);
            }
            await startRolloutTail(
                active.threadId,
                active.rolloutTimestamp < startedAt,
                active.rolloutPath,
            );
        };
        const refreshActiveThread = async (): Promise<void> => {
            try {
                const activeRolloutPaths = typeof child.pid === 'number'
                    ? await (opts.findOpenRolloutPaths ?? findOpenCodexRolloutPaths)({
                        rootPid: child.pid,
                        codexHomeDir,
                    })
                    : [];
                if (childExited && activeThreadConfirmedByOpenRollout && activeRolloutPaths.length === 0) {
                    return;
                }
                const active = await findActiveThread({
                    codexHomeDir,
                    startedAt,
                    finishedAt: now(),
                    originator,
                    activeRolloutPaths,
                });
                if (!activeThreadMonitorAbort.signal.aborted && active) {
                    if (activeRolloutPaths.includes(active.rolloutPath)) {
                        activeThreadConfirmedByOpenRollout = true;
                    }
                    await applyActiveThread(active);
                }
            } catch (error) {
                logger.debug(`[CodexLocal] Could not reconcile active thread: ${String(error)}`);
            }
        };
        const discoveryAbort = new AbortController();
        const exitPromise = new Promise<
            | { kind: 'exit'; status: 'fulfilled'; code: number }
            | { kind: 'exit'; status: 'rejected'; error: unknown }
        >((resolve) => {
            const reject = (error: unknown): void => {
                discoveryAbort.abort();
                resolve({ kind: 'exit', status: 'rejected', error });
            };
            rejectChildExit = reject;
            child.once('error', reject);
            child.once('exit', (code) => {
                childExited = true;
                if (forceKillTimer) {
                    clearTimeout(forceKillTimer);
                    forceKillTimer = null;
                }
                if (terminationFailureTimer) {
                    clearTimeout(terminationFailureTimer);
                    terminationFailureTimer = null;
                }
                if (handoffDiscoveryTimer) {
                    clearTimeout(handoffDiscoveryTimer);
                    handoffDiscoveryTimer = null;
                }
                void (async () => {
                    try {
                        if (terminationSignalSent && process.platform !== 'win32' && ownedDescendantPids.size > 0) {
                            let remaining = await waitForProcessIdsExit(ownedDescendantPids, 50);
                            if (remaining.length > 0) {
                                signalProcessIds(remaining, 'SIGKILL');
                                remaining = await waitForProcessIdsExit(
                                    remaining,
                                    opts.forceKillWaitMs ?? 1_000,
                                );
                            }
                            if (remaining.length > 0) {
                                resolve({
                                    kind: 'exit',
                                    status: 'rejected',
                                    error: new Error(`Native Codex descendants did not exit: ${remaining.join(', ')}`),
                                });
                                return;
                            }
                        }
                        resolve({ kind: 'exit', status: 'fulfilled', code: typeof code === 'number' ? code : 1 });
                    } catch (error) {
                        resolve({ kind: 'exit', status: 'rejected', error });
                    }
                })();
            });
        });
        const handleParentSigint = (): void => {
            // Native Codex shares the foreground terminal and owns Ctrl-C while
            // its TUI is active. Keeping a listener here prevents Node's default
            // SIGINT exit from bypassing child/session cleanup.
            logger.debug('[CodexLocal] Parent received SIGINT while native Codex owns the terminal');
        };
        const handleParentSigterm = (): void => {
            terminationRequested = true;
            requestChildTermination();
        };
        process.on('SIGINT', handleParentSigint);
        process.on('SIGTERM', handleParentSigterm);
        removeParentSignalHandlers = () => {
            process.removeListener('SIGINT', handleParentSigint);
            process.removeListener('SIGTERM', handleParentSigterm);
        };
        opts.onTerminateReady?.(() => {
            terminationRequested = true;
            if (handoffDiscoveryTimer) {
                clearTimeout(handoffDiscoveryTimer);
                handoffDiscoveryTimer = null;
            }
            requestChildTermination();
        });
        opts.onLocalHandoffReady?.(() => {
            handoffRequested = true;
            if (!handoffReconciliationPromise) {
                handoffReconciliationPromise = (async () => {
                    await refreshActiveThread();
                    if (terminationRequested) {
                        return;
                    }
                    if (discoveredThreadId) {
                        requestChildTermination();
                        return;
                    }
                    if (childExited) {
                        return;
                    }
                    if (!handoffDiscoveryTimer) {
                        // A fresh TUI can be handed off before it creates a
                        // rollout. Give discovery a short chance to preserve
                        // context, then switch with no thread id.
                        handoffDiscoveryTimer = setTimeout(() => {
                            handoffDiscoveryTimer = null;
                            requestChildTermination();
                        }, opts.handoffDiscoveryGraceMs ?? 2_000);
                        handoffDiscoveryTimer.unref();
                    }
                })().catch((error) => {
                    logger.debug(`[CodexLocal] Handoff reconciliation failed: ${String(error)}`);
                    requestChildTermination();
                });
            }
        });

        if (opts.codexThreadId) {
            opts.onThreadIdDiscovered?.(opts.codexThreadId);
        }

        const discoverThreadId = opts.discoverThreadId ?? discoverCodexThreadId;
        const discoveryPromise: Promise<
            | { kind: 'discovery'; status: 'fulfilled'; threadId: string }
            | { kind: 'discovery'; status: 'rejected'; error: unknown }
        > = (opts.codexThreadId
            ? Promise.resolve(opts.codexThreadId)
            : waitForDiscoveredThreadId({
                discoverThreadId,
                codexHomeDir,
                cwd: opts.cwd,
                startedAt,
                originator,
                now,
                pollMs: opts.discoveryPollMs ?? 250,
                signal: discoveryAbort.signal,
            }).then(async (threadId) => {
                if (discoveryAbort.signal.aborted) {
                    throw new Error(`Codex thread discovery cancelled for cwd ${opts.cwd}.`);
                }
                discoveredThreadId = threadId;
                opts.onThreadIdDiscovered?.(threadId);
                await startRolloutTail(threadId, false);
                if (discoveryAbort.signal.aborted) {
                    activeRolloutTail?.abort.abort();
                    throw new Error(`Codex thread discovery cancelled for cwd ${opts.cwd}.`);
                }
                if (handoffRequested) {
                    if (handoffDiscoveryTimer) {
                        clearTimeout(handoffDiscoveryTimer);
                        handoffDiscoveryTimer = null;
                    }
                    await refreshActiveThread();
                    requestChildTermination();
                }
                return threadId;
            }))
            .then(
                (threadId) => ({ kind: 'discovery' as const, status: 'fulfilled' as const, threadId }),
                (error) => ({ kind: 'discovery' as const, status: 'rejected' as const, error }),
            );

        activeThreadMonitorPromise = (async () => {
            const discovery = await Promise.race([
                discoveryPromise,
                new Promise<null>((resolve) => {
                    if (activeThreadMonitorAbort.signal.aborted) {
                        resolve(null);
                        return;
                    }
                    activeThreadMonitorAbort.signal.addEventListener(
                        'abort',
                        () => resolve(null),
                        { once: true },
                    );
                }),
            ]);
            if (!discovery || discovery.status === 'rejected') {
                return;
            }
            while (!activeThreadMonitorAbort.signal.aborted && !childExited) {
                await refreshActiveThread();
                await waitForDelay(activeThreadMonitorAbort.signal, opts.activeThreadPollMs ?? 500);
            }
        })();

        const first = await Promise.race([discoveryPromise, exitPromise]);
        if (first.kind === 'exit') {
            if (first.status === 'rejected') {
                throw first.error;
            }
            if (!opts.codexThreadId && !discoveredThreadId) {
                // The rollout is commonly flushed immediately before the native
                // process exits. Give an already-running discovery pass a short,
                // bounded chance to capture that thread so a simultaneous phone
                // takeover does not silently start a new conversation.
                await Promise.race([
                    discoveryPromise,
                    delay(opts.exitDiscoveryGraceMs ?? 250),
                ]);
            }
            await handoffReconciliationPromise;
            await refreshActiveThread();
            discoveryAbort.abort();
            if (terminationRequested) {
                return {
                    type: 'exit',
                    code: 0,
                    ...(discoveredThreadId ? { codexThreadId: discoveredThreadId } : {}),
                };
            }
            if (handoffRequested) {
                return {
                    type: 'switch',
                    ...(discoveredThreadId ? { codexThreadId: discoveredThreadId } : {}),
                };
            }
            return {
                type: 'exit',
                code: terminationRequested ? 0 : first.code,
                ...(discoveredThreadId ? { codexThreadId: discoveredThreadId } : {}),
            };
        }

        if (first.status === 'rejected') {
            requestChildTermination();
            await exitPromise;
            throw first.error;
        }

        const exit = await exitPromise;
        if (exit.status === 'rejected') {
            throw exit.error;
        }
        await handoffReconciliationPromise;
        await refreshActiveThread();
        if (terminationRequested) {
            return {
                type: 'exit',
                code: 0,
                codexThreadId: discoveredThreadId ?? first.threadId,
            };
        }
        if (handoffRequested) {
            return { type: 'switch', codexThreadId: discoveredThreadId ?? first.threadId };
        }

        return {
            type: 'exit',
            code: terminationRequested ? 0 : exit.code,
            codexThreadId: discoveredThreadId ?? first.threadId,
        };
    } finally {
        activeThreadMonitorAbort.abort();
        const stopTailsPromise = stopRolloutTails();
        await handoffReconciliationPromise;
        await activeThreadMonitorPromise;
        await stopTailsPromise;
        removeParentSignalHandlers();
        if (sandboxCleanup) {
            await sandboxCleanup();
        }
    }
}
