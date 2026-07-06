import { describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildCodexNativeArgs, launchNativeCodex } from './codexLocalLauncher';

async function waitFor(predicate: () => boolean, timeoutMs: number = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error(`Timed out after ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

describe('buildCodexNativeArgs', () => {
    it('builds a fresh native Codex launch with startup defaults', () => {
        expect(buildCodexNativeArgs({
            model: 'gpt-5.5',
            effort: 'medium',
            permissionMode: 'yolo',
        })).toEqual([
            '--model',
            'gpt-5.5',
            '-c',
            'model_reasoning_effort="medium"',
            '--dangerously-bypass-approvals-and-sandbox',
        ]);
    });

    it('uses positional resume syntax when a Codex thread id is known', () => {
        expect(buildCodexNativeArgs({
            codexThreadId: 'thread-123',
            model: 'gpt-5.5',
            effort: 'medium',
            permissionMode: 'yolo',
        })).toEqual([
            'resume',
            'thread-123',
            '--model',
            'gpt-5.5',
            '-c',
            'model_reasoning_effort="medium"',
            '--dangerously-bypass-approvals-and-sandbox',
        ]);
    });

    it('maps read-only permission mode to native approval and sandbox flags', () => {
        expect(buildCodexNativeArgs({
            permissionMode: 'read-only',
        })).toEqual([
            '--ask-for-approval',
            'never',
            '--sandbox',
            'read-only',
        ]);
    });

    it('maps safe-yolo permission mode to native approval and workspace sandbox flags', () => {
        expect(buildCodexNativeArgs({
            permissionMode: 'safe-yolo',
        })).toEqual([
            '--ask-for-approval',
            'on-failure',
            '--sandbox',
            'workspace-write',
        ]);
    });

    it('matches remote default policy and delegates sandboxing to Happy when enabled', () => {
        expect(buildCodexNativeArgs({ permissionMode: 'default' })).toEqual([
            '--ask-for-approval',
            'untrusted',
            '--sandbox',
            'workspace-write',
        ]);
        expect(buildCodexNativeArgs({
            permissionMode: 'read-only',
            sandboxManagedByHappy: true,
        })).toEqual([
            '--ask-for-approval',
            'never',
            '--sandbox',
            'danger-full-access',
        ]);
    });
});

describe('launchNativeCodex', () => {
    it('spawns native Codex with inherited stdio', async () => {
        const spawnCalls: unknown[] = [];

        const result = await launchNativeCodex({
            cwd: '/tmp/project',
            codexThreadId: 'thread-existing',
            originatorOverride: 'happy-test-launch',
            model: 'gpt-5.5',
            effort: 'medium',
            permissionMode: 'yolo',
            spawn: ((command: string, args: string[], options: Record<string, unknown>) => {
                spawnCalls.push({ command, args, options });
                return {
                    once: (event: string, callback: (value: unknown) => void) => {
                        if (event === 'exit') {
                            callback(0);
                        }
                        return undefined;
                    },
                };
            }) as never,
        });

        expect(result).toEqual({ type: 'exit', code: 0, codexThreadId: 'thread-existing' });
        expect(spawnCalls).toEqual([{
            command: 'codex',
            args: [
                'resume',
                'thread-existing',
                '--model',
                'gpt-5.5',
                '-c',
                'model_reasoning_effort="medium"',
                '--dangerously-bypass-approvals-and-sandbox',
            ],
            options: expect.objectContaining({
                cwd: '/tmp/project',
                stdio: 'inherit',
                env: expect.objectContaining({
                    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'happy-test-launch',
                }),
            }),
        }]);
    });

    it('returns a discovered Codex thread id for fresh local sessions', async () => {
        const result = await launchNativeCodex({
            cwd: '/tmp/project',
            codexHomeDir: '/tmp/codex-home',
            now: () => new Date('2026-05-04T11:00:00.000Z'),
            discoverThreadId: async ({ startedAt, finishedAt }) => {
                expect(startedAt).toEqual(new Date('2026-05-04T11:00:00.000Z'));
                expect(finishedAt).toEqual(new Date('2026-05-04T11:00:00.000Z'));
                return 'thread-discovered';
            },
            spawn: ((command: string, args: string[], options: Record<string, unknown>) => {
                return {
                    once: (event: string, callback: (value: unknown) => void) => {
                        if (event === 'exit') {
                            callback(0);
                        }
                        return undefined;
                    },
                };
            }) as never,
        });

        expect(result).toEqual({
            type: 'exit',
            code: 0,
            codexThreadId: 'thread-discovered',
        });
    });

    it('returns the native exit code when a fresh launch exits before discovery', async () => {
        const result = await launchNativeCodex({
            cwd: '/tmp/project',
            codexHomeDir: '/tmp/codex-home',
            discoverThreadId: () => new Promise<string>((_resolve, reject) => {
                setTimeout(() => reject(new Error('Could not discover Codex thread id')), 0);
            }),
            spawn: (() => ({
                once: (event: string, callback: (value: unknown) => void) => {
                    if (event === 'exit') {
                        callback(7);
                    }
                    return undefined;
                },
            })) as never,
        });

        expect(result).toEqual({ type: 'exit', code: 7 });
    });

    it('wraps native Codex in the configured Happy sandbox', async () => {
        const spawnCalls: unknown[] = [];
        const cleanupCalls: string[] = [];

        const result = await launchNativeCodex({
            cwd: '/tmp/project',
            codexThreadId: 'thread-existing',
            sandboxConfig: {
                enabled: true,
                workspaceRoot: '/tmp/project',
                sessionIsolation: 'workspace',
                customWritePaths: [],
                denyReadPaths: [],
                extraWritePaths: [],
                denyWritePaths: [],
                networkMode: 'blocked',
                allowedDomains: [],
                deniedDomains: [],
                allowLocalBinding: false,
            },
            initializeSandbox: async (sandboxConfig, cwd) => {
                expect(sandboxConfig.enabled).toBe(true);
                expect(cwd).toBe('/tmp/project');
                return async () => {
                    cleanupCalls.push('cleanup');
                };
            },
            wrapForSandbox: async (command, args) => ({
                command: 'sh',
                args: ['-c', `sandboxed ${command} ${args.join(' ')}`],
            }),
            spawn: ((command: string, args: string[], options: Record<string, unknown>) => {
                spawnCalls.push({ command, args, options });
                return {
                    once: (event: string, callback: (value: unknown) => void) => {
                        if (event === 'exit') {
                            callback(0);
                        }
                        return undefined;
                    },
                };
            }) as never,
        });

        expect(result).toEqual({ type: 'exit', code: 0, codexThreadId: 'thread-existing' });
        expect(spawnCalls).toEqual([{
            command: 'sh',
            args: ['-c', 'sandboxed codex resume thread-existing --ask-for-approval never --sandbox danger-full-access'],
            options: expect.objectContaining({
                cwd: '/tmp/project',
                stdio: 'inherit',
            }),
        }]);
        expect(cleanupCalls).toEqual(['cleanup']);
    });

    it('publishes a discovered Codex thread id before the native process exits', async () => {
        const exitCallback: { current: ((value: unknown) => void) | null } = { current: null };
        const discovered: string[] = [];
        const launch = launchNativeCodex({
            cwd: '/tmp/project',
            codexHomeDir: '/tmp/codex-home',
            now: () => new Date('2026-05-04T11:00:00.000Z'),
            discoverThreadId: async () => 'thread-discovered',
            onThreadIdDiscovered: (threadId) => {
                discovered.push(threadId);
            },
            spawn: (() => ({
                once: (event: string, callback: (value: unknown) => void) => {
                    if (event === 'exit') {
                        exitCallback.current = callback;
                    }
                    return undefined;
                },
            })) as never,
        });

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(discovered).toEqual(['thread-discovered']);

        if (!exitCallback.current) {
            throw new Error('exit callback was not registered');
        }
        exitCallback.current(0);
        await expect(launch).resolves.toEqual({
            type: 'exit',
            code: 0,
            codexThreadId: 'thread-discovered',
        });
    });

    it('does not start a rollout tail after launcher cleanup has begun', async () => {
        const exitCallback: { current: ((value: unknown) => void) | null } = { current: null };
        const resolveRolloutPath: { current: ((path: string | null) => void) | null } = { current: null };
        let tailStarted = false;
        let settled = false;

        const launch = launchNativeCodex({
            cwd: '/tmp/project',
            codexHomeDir: '/tmp/codex-home',
            exitDiscoveryGraceMs: 1,
            discoverThreadId: async () => 'thread-discovered',
            findRolloutPath: () => new Promise<string | null>((resolve) => {
                resolveRolloutPath.current = resolve;
            }),
            tailRollout: async () => {
                tailStarted = true;
            },
            onRolloutEvent: () => undefined,
            spawn: (() => ({
                once: (event: string, callback: (value: unknown) => void) => {
                    if (event === 'exit') {
                        exitCallback.current = callback;
                    }
                    return undefined;
                },
            })) as never,
        }).then((result) => {
            settled = true;
            return result;
        });

        await waitFor(() => resolveRolloutPath.current !== null);
        exitCallback.current?.(0);
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(settled).toBe(false);

        resolveRolloutPath.current?.('/tmp/codex-home/rollout.jsonl');
        await expect(launch).resolves.toEqual({
            type: 'exit',
            code: 0,
            codexThreadId: 'thread-discovered',
        });
        expect(tailStarted).toBe(false);
    });

    it('keeps native Codex running while fresh thread discovery is temporarily unavailable', async () => {
        const exitCallback: { current: ((value: unknown) => void) | null } = { current: null };
        const killCalls: Array<string | undefined> = [];
        const discovered: string[] = [];
        let attempts = 0;

        const launch = launchNativeCodex({
            cwd: '/tmp/project',
            codexHomeDir: '/tmp/codex-home',
            discoveryPollMs: 1,
            discoverThreadId: async () => {
                attempts++;
                if (attempts < 3) {
                    throw new Error('Could not discover Codex thread id for cwd /tmp/project in launch window.');
                }
                return 'thread-slow';
            },
            onThreadIdDiscovered: (threadId) => {
                discovered.push(threadId);
                exitCallback.current?.(0);
            },
            spawn: (() => ({
                once: (event: string, callback: (value: unknown) => void) => {
                    if (event === 'exit') {
                        exitCallback.current = callback;
                    }
                    return undefined;
                },
                kill: (signal?: string) => {
                    killCalls.push(signal);
                    exitCallback.current?.(null);
                    return true;
                },
            })) as never,
        });

        await expect(launch).resolves.toEqual({
            type: 'exit',
            code: 0,
            codexThreadId: 'thread-slow',
        });
        expect(discovered).toEqual(['thread-slow']);
        expect(killCalls).toEqual([]);
    });

    it('terminates the native process when discovery rejects while it is still running', async () => {
        const exitCallback: { current: ((value: unknown) => void) | null } = { current: null };
        const killCalls: Array<string | undefined> = [];
        const launch = launchNativeCodex({
            cwd: '/tmp/project',
            codexHomeDir: '/tmp/codex-home',
            now: () => new Date('2026-05-04T11:00:00.000Z'),
            discoverThreadId: async () => {
                throw new Error('Ambiguous Codex thread discovery for cwd /tmp/project: one, two');
            },
            spawn: (() => ({
                once: (event: string, callback: (value: unknown) => void) => {
                    if (event === 'exit') {
                        exitCallback.current = callback;
                    }
                    return undefined;
                },
                kill: (signal?: string) => {
                    killCalls.push(signal);
                    exitCallback.current?.(null);
                    return true;
                },
            })) as never,
        });

        await expect(launch).rejects.toThrow('Ambiguous Codex thread discovery');
        expect(killCalls).toEqual(['SIGTERM']);
    });

    it('switches to remote mode when a local handoff is requested', async () => {
        const requestHandoff: { current: (() => void) | null } = { current: null };
        const exitCallback: { current: ((value: unknown) => void) | null } = { current: null };
        const killCalls: Array<string | undefined> = [];

        const launch = launchNativeCodex({
            cwd: '/tmp/project',
            codexThreadId: 'thread-existing',
            onLocalHandoffReady: (handoff) => {
                requestHandoff.current = handoff;
            },
            spawn: (() => ({
                once: (event: string, callback: (value: unknown) => void) => {
                    if (event === 'exit') {
                        exitCallback.current = callback;
                    }
                    return undefined;
                },
                kill: (signal?: string) => {
                    killCalls.push(signal);
                    exitCallback.current?.(null);
                    return true;
                },
            })) as never,
        });

        await new Promise((resolve) => setTimeout(resolve, 0));
        requestHandoff.current?.();

        await expect(launch).resolves.toEqual({ type: 'switch', codexThreadId: 'thread-existing' });
        expect(killCalls).toEqual(['SIGTERM']);
    });

    it('reaps a captured tool descendant even after the Codex wrapper exits', async () => {
        const requestHandoff: { current: (() => void) | null } = { current: null };
        const exitCallback: { current: ((value: unknown) => void) | null } = { current: null };
        const forcedDescendants: number[][] = [];
        let waitCalls = 0;

        const launch = launchNativeCodex({
            cwd: '/tmp/project',
            codexThreadId: 'thread-existing',
            findActiveThread: async () => null,
            signalPosixDescendants: (_pid, signal) => signal === 'SIGTERM' ? [5678] : [],
            signalProcessIds: (pids) => {
                forcedDescendants.push(Array.from(pids));
            },
            waitForProcessIdsExit: async () => (++waitCalls === 1 ? [5678] : []),
            onLocalHandoffReady: (handoff) => {
                requestHandoff.current = handoff;
            },
            spawn: (() => ({
                pid: 1234,
                once: (event: string, callback: (value: unknown) => void) => {
                    if (event === 'exit') exitCallback.current = callback;
                    return undefined;
                },
                kill: () => {
                    exitCallback.current?.(null);
                    return true;
                },
            })) as never,
        });

        await waitFor(() => requestHandoff.current !== null);
        requestHandoff.current?.();

        await expect(launch).resolves.toEqual({ type: 'switch', codexThreadId: 'thread-existing' });
        expect(forcedDescendants).toEqual([[5678]]);
        expect(waitCalls).toBe(2);
    });

    it('hands off the thread selected by an in-process native thread switch', async () => {
        const requestHandoff: { current: (() => void) | null } = { current: null };
        const exitCallback: { current: ((value: unknown) => void) | null } = { current: null };
        const discovered: string[] = [];
        const tailedPaths: string[] = [];
        let activeThreadId = 'thread-a';
        let activeRolloutPath = '/tmp/rollout-a.jsonl';
        let activeLookups = 0;

        const launch = launchNativeCodex({
            cwd: '/tmp/project',
            codexHomeDir: '/tmp/codex-home',
            codexThreadId: 'thread-a',
            activeThreadPollMs: 10_000,
            findRolloutPath: async () => '/tmp/rollout-a.jsonl',
            getRolloutSize: async () => 0,
            findActiveThread: async () => {
                activeLookups++;
                return {
                    threadId: activeThreadId,
                    rolloutPath: activeRolloutPath,
                    rolloutTimestamp: new Date(),
                };
            },
            tailRollout: async ({ path, signal }) => {
                tailedPaths.push(path);
                await new Promise<void>((resolve) => {
                    if (signal.aborted) {
                        resolve();
                        return;
                    }
                    signal.addEventListener('abort', () => resolve(), { once: true });
                });
            },
            onRolloutEvent: () => undefined,
            onThreadIdDiscovered: (threadId) => discovered.push(threadId),
            onLocalHandoffReady: (handoff) => {
                requestHandoff.current = handoff;
            },
            spawn: (() => ({
                once: (event: string, callback: (value: unknown) => void) => {
                    if (event === 'exit') {
                        exitCallback.current = callback;
                    }
                    return undefined;
                },
                kill: () => {
                    exitCallback.current?.(null);
                    return true;
                },
            })) as never,
        });

        await waitFor(() => requestHandoff.current !== null && activeLookups > 0);
        activeThreadId = 'thread-b';
        activeRolloutPath = '/tmp/rollout-b.jsonl';
        requestHandoff.current?.();

        await expect(launch).resolves.toEqual({ type: 'switch', codexThreadId: 'thread-b' });
        expect(discovered).toEqual(['thread-a', 'thread-b']);
        expect(tailedPaths).toEqual(['/tmp/rollout-a.jsonl', '/tmp/rollout-b.jsonl']);
    });

    it('detects /resume by the old rollout opened by the native process', async () => {
        const codexHomeDir = await mkdtemp(join(tmpdir(), 'happy-codex-resume-'));
        const currentDir = join(codexHomeDir, 'sessions', '2026', '07', '06');
        const oldDir = join(codexHomeDir, 'sessions', '2025', '01', '01');
        await mkdir(currentDir, { recursive: true });
        await mkdir(oldDir, { recursive: true });
        const rolloutA = join(currentDir, 'rollout-2026-07-06-thread-a.jsonl');
        const rolloutB = join(oldDir, 'rollout-2025-01-01-thread-b.jsonl');
        await writeFile(rolloutA, `${JSON.stringify({
            timestamp: '2026-07-06T00:00:00.000Z',
            type: 'session_meta',
            payload: {
                id: 'thread-a',
                cwd: '/tmp/project',
                timestamp: '2026-07-06T00:00:00.000Z',
                originator: 'happy-test-launch',
                source: 'cli',
            },
        })}\n`);
        await writeFile(rolloutB, `${JSON.stringify({
            timestamp: '2025-01-01T00:00:00.000Z',
            type: 'session_meta',
            payload: {
                id: 'thread-b',
                cwd: '/tmp/project',
                timestamp: '2025-01-01T00:00:00.000Z',
                originator: 'old-codex-launch',
                source: 'vscode',
            },
        })}\n`);

        const requestHandoff: { current: (() => void) | null } = { current: null };
        const exitCallback: { current: ((value: unknown) => void) | null } = { current: null };
        const discovered: string[] = [];
        const tailedPaths: string[] = [];
        let activeRolloutPath = rolloutA;
        let openRolloutLookups = 0;
        let nativeExited = false;

        const launch = launchNativeCodex({
            cwd: '/tmp/project',
            codexHomeDir,
            codexThreadId: 'thread-a',
            originatorOverride: 'happy-test-launch',
            now: () => new Date('2026-07-06T00:00:00.000Z'),
            activeThreadPollMs: 10_000,
            findOpenRolloutPaths: async () => {
                openRolloutLookups++;
                return nativeExited ? [] : [activeRolloutPath];
            },
            getRolloutSize: async () => 0,
            tailRollout: async ({ path, signal }) => {
                tailedPaths.push(path);
                await new Promise<void>((resolve) => {
                    if (signal.aborted) {
                        resolve();
                        return;
                    }
                    signal.addEventListener('abort', () => resolve(), { once: true });
                });
            },
            onRolloutEvent: () => undefined,
            onThreadIdDiscovered: (threadId) => discovered.push(threadId),
            onLocalHandoffReady: (handoff) => {
                requestHandoff.current = handoff;
            },
            spawn: (() => ({
                pid: 1234,
                once: (event: string, callback: (value: unknown) => void) => {
                    if (event === 'exit') exitCallback.current = callback;
                    return undefined;
                },
                kill: () => {
                    nativeExited = true;
                    exitCallback.current?.(null);
                    return true;
                },
            })) as never,
        });

        await waitFor(() => requestHandoff.current !== null && openRolloutLookups > 0);
        activeRolloutPath = rolloutB;
        requestHandoff.current?.();

        await expect(launch).resolves.toEqual({ type: 'switch', codexThreadId: 'thread-b' });
        expect(discovered).toEqual(['thread-a', 'thread-b']);
        expect(tailedPaths).toEqual([rolloutA, rolloutB]);
    });

    it('cannot miss an immediate handoff requested while callbacks are being installed', async () => {
        let exitCallback: ((value: unknown) => void) | null = null;

        const result = await launchNativeCodex({
            cwd: '/tmp/project',
            codexThreadId: 'thread-existing',
            onLocalHandoffReady: (handoff) => handoff(),
            spawn: (() => ({
                pid: 1234,
                once: (event: string, callback: (value: unknown) => void) => {
                    if (event === 'exit') {
                        exitCallback = callback;
                    }
                    return undefined;
                },
                kill: () => {
                    exitCallback?.(null);
                    return true;
                },
            })) as never,
        });

        expect(result).toEqual({ type: 'switch', codexThreadId: 'thread-existing' });
    });

    it('fails a handoff instead of waiting forever when native Codex cannot be reaped', async () => {
        const killCalls: Array<string | undefined> = [];
        const descendantSignals: Array<[number, string]> = [];

        const launch = launchNativeCodex({
            cwd: '/tmp/project',
            codexThreadId: 'thread-existing',
            terminationGraceMs: 1,
            forceKillWaitMs: 1,
            signalPosixDescendants: (pid, signal) => {
                descendantSignals.push([pid, signal]);
                return [];
            },
            onLocalHandoffReady: (handoff) => handoff(),
            spawn: (() => ({
                pid: 1234,
                once: () => undefined,
                kill: (signal?: string) => {
                    killCalls.push(signal);
                    return true;
                },
            })) as never,
        });

        await expect(launch).rejects.toThrow('did not exit after SIGTERM/SIGKILL');
        expect(killCalls).toEqual(['SIGTERM', 'SIGKILL']);
        expect(descendantSignals).toEqual([
            [1234, 'SIGTERM'],
            [1234, 'SIGKILL'],
        ]);
    });

    it('waits for discovery before terminating native Codex for early fresh handoff', async () => {
        const requestHandoff: { current: (() => void) | null } = { current: null };
        const exitCallback: { current: ((value: unknown) => void) | null } = { current: null };
        const resolveDiscovery: { current: ((threadId: string) => void) | null } = { current: null };
        const killCalls: Array<string | undefined> = [];

        const launch = launchNativeCodex({
            cwd: '/tmp/project',
            codexHomeDir: '/tmp/codex-home',
            discoverThreadId: () => new Promise<string>((resolve) => {
                resolveDiscovery.current = resolve;
            }),
            onLocalHandoffReady: (handoff) => {
                requestHandoff.current = handoff;
            },
            spawn: (() => ({
                once: (event: string, callback: (value: unknown) => void) => {
                    if (event === 'exit') {
                        exitCallback.current = callback;
                    }
                    return undefined;
                },
                kill: (signal?: string) => {
                    killCalls.push(signal);
                    exitCallback.current?.(null);
                    return true;
                },
            })) as never,
        });

        await new Promise((resolve) => setTimeout(resolve, 0));
        requestHandoff.current?.();
        expect(killCalls).toEqual([]);

        resolveDiscovery.current?.('thread-discovered');

        await expect(launch).resolves.toEqual({ type: 'switch', codexThreadId: 'thread-discovered' });
        expect(killCalls).toEqual(['SIGTERM']);
    });

    it('exposes a termination callback that kills native Codex without switching modes', async () => {
        const terminate: { current: (() => void) | null } = { current: null };
        const exitCallback: { current: ((value: unknown) => void) | null } = { current: null };
        const killCalls: Array<string | undefined> = [];

        const launch = launchNativeCodex({
            cwd: '/tmp/project',
            codexThreadId: 'thread-existing',
            onTerminateReady: (terminateNative) => {
                terminate.current = terminateNative;
            },
            spawn: (() => ({
                once: (event: string, callback: (value: unknown) => void) => {
                    if (event === 'exit') {
                        exitCallback.current = callback;
                    }
                    return undefined;
                },
                kill: (signal?: string) => {
                    killCalls.push(signal);
                    exitCallback.current?.(null);
                    return true;
                },
            })) as never,
        });

        await new Promise((resolve) => setTimeout(resolve, 0));
        terminate.current?.();

        await expect(launch).resolves.toEqual({ type: 'exit', code: 0, codexThreadId: 'thread-existing' });
        expect(killCalls).toEqual(['SIGTERM']);
    });

    it('switches without a thread id when takeover happens before a fresh rollout exists', async () => {
        const requestHandoff: { current: (() => void) | null } = { current: null };
        const exitCallback: { current: ((value: unknown) => void) | null } = { current: null };
        const killCalls: Array<string | undefined> = [];

        const launch = launchNativeCodex({
            cwd: '/tmp/project',
            codexHomeDir: '/tmp/codex-home',
            handoffDiscoveryGraceMs: 1,
            discoverThreadId: () => new Promise<string>(() => undefined),
            onLocalHandoffReady: (handoff) => {
                requestHandoff.current = handoff;
            },
            spawn: (() => ({
                once: (event: string, callback: (value: unknown) => void) => {
                    if (event === 'exit') {
                        exitCallback.current = callback;
                    }
                    return undefined;
                },
                kill: (signal?: string) => {
                    killCalls.push(signal);
                    exitCallback.current?.(null);
                    return true;
                },
            })) as never,
        });

        await new Promise((resolve) => setTimeout(resolve, 0));
        requestHandoff.current?.();

        await expect(launch).resolves.toEqual({ type: 'switch' });
        expect(killCalls).toEqual(['SIGTERM']);
    });

    it('lets an explicit termination win over a simultaneous handoff', async () => {
        const requestHandoff: { current: (() => void) | null } = { current: null };
        const terminate: { current: (() => void) | null } = { current: null };
        const exitCallback: { current: ((value: unknown) => void) | null } = { current: null };
        const killCalls: Array<string | undefined> = [];

        const launch = launchNativeCodex({
            cwd: '/tmp/project',
            codexThreadId: 'thread-existing',
            onLocalHandoffReady: (handoff) => {
                requestHandoff.current = handoff;
            },
            onTerminateReady: (terminateNative) => {
                terminate.current = terminateNative;
            },
            spawn: (() => ({
                once: (event: string, callback: (value: unknown) => void) => {
                    if (event === 'exit') {
                        exitCallback.current = callback;
                    }
                    return undefined;
                },
                kill: (signal?: string) => {
                    killCalls.push(signal);
                    return true;
                },
            })) as never,
        });

        await new Promise((resolve) => setTimeout(resolve, 0));
        requestHandoff.current?.();
        terminate.current?.();
        exitCallback.current?.(null);

        await expect(launch).resolves.toEqual({ type: 'exit', code: 0, codexThreadId: 'thread-existing' });
        expect(killCalls).toEqual(['SIGTERM']);
    });

    it('tails only new rollout events while a resumed native session is local', async () => {
        const codexHomeDir = await mkdtemp(join(tmpdir(), 'happy-codex-local-'));
        const sessionDir = join(codexHomeDir, 'sessions', '2026', '07', '06');
        const rolloutPath = join(sessionDir, 'rollout-2026-07-06-thread-existing.jsonl');
        await mkdir(sessionDir, { recursive: true });
        await writeFile(rolloutPath, [
            JSON.stringify({
                type: 'session_meta',
                payload: {
                    id: 'thread-existing',
                    cwd: '/tmp/project',
                    timestamp: '2026-07-06T00:00:00.000Z',
                    originator: 'codex-tui',
                    source: 'cli',
                },
            }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'old' } }),
            '',
        ].join('\n'));

        const exitCallback: { current: ((value: unknown) => void) | null } = { current: null };
        const events: Array<Record<string, unknown>> = [];
        const launch = launchNativeCodex({
            cwd: '/tmp/project',
            codexHomeDir,
            codexThreadId: 'thread-existing',
            onRolloutEvent: (event) => events.push(event),
            spawn: (() => ({
                pid: 1234,
                once: (event: string, callback: (value: unknown) => void) => {
                    if (event === 'exit') {
                        exitCallback.current = callback;
                    }
                    return undefined;
                },
                kill: () => true,
            })) as never,
        });

        await waitFor(() => exitCallback.current !== null);
        await appendFile(rolloutPath, `${JSON.stringify({
            type: 'event_msg',
            payload: { type: 'agent_message', message: 'new' },
        })}\n`);
        await waitFor(() => events.length === 1);
        exitCallback.current?.(0);

        await expect(launch).resolves.toEqual({ type: 'exit', code: 0, codexThreadId: 'thread-existing' });
        expect(events).toEqual([{ type: 'agent_message', message: 'new' }]);
    });
});
