import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { discoverCodexThreadId, findActiveCodexThread, findCodexRolloutPathByThreadId } from './codexThreadDiscovery';

async function writeSessionMeta(
    codexHomeDir: string,
    opts: {
        id: string;
        cwd: string;
        timestamp: string;
        rolloutTimestamp?: string;
        fileDate?: string;
        originator?: string;
        source?: unknown;
        parentThreadId?: string | null;
        baseInstructions?: string;
    },
): Promise<string> {
    const rolloutTimestamp = opts.rolloutTimestamp ?? opts.timestamp;
    const fileDate = opts.fileDate ?? rolloutTimestamp.slice(0, 10);
    const [year, month, day] = fileDate.split('-');
    const sessionDir = join(codexHomeDir, 'sessions', year, month, day);
    await mkdir(sessionDir, { recursive: true });
    const path = join(sessionDir, `rollout-${rolloutTimestamp}-${opts.id}.jsonl`);
    await writeFile(
        path,
        JSON.stringify({
            timestamp: rolloutTimestamp,
            type: 'session_meta',
            payload: {
                id: opts.id,
                cwd: opts.cwd,
                timestamp: opts.timestamp,
                originator: opts.originator ?? 'happy-test-launch',
                source: opts.source ?? 'cli',
                parent_thread_id: opts.parentThreadId,
                base_instructions: opts.baseInstructions,
            },
        }) + '\n',
    );
    return path;
}

describe('discoverCodexThreadId', () => {
    it('chooses the one new Codex session matching cwd and launch window', async () => {
        const codexHomeDir = await mkdtemp(join(tmpdir(), 'happy-codex-home-'));
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-outside-date-directories',
            cwd: '/workspace/project',
            timestamp: '2026-05-03T11:00:01.000Z',
        });
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-before-window',
            cwd: '/workspace/project',
            timestamp: '2026-05-04T10:59:59.000Z',
        });
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-other-cwd',
            cwd: '/workspace/other',
            timestamp: '2026-05-04T11:00:01.000Z',
        });
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-match',
            cwd: '/workspace/project',
            timestamp: '2026-05-04T11:00:01.000Z',
        });

        await expect(discoverCodexThreadId({
            codexHomeDir,
            cwd: '/workspace/project',
            startedAt: new Date('2026-05-04T11:00:00.000Z'),
            finishedAt: new Date('2026-05-04T11:00:05.000Z'),
            originator: 'happy-test-launch',
        })).resolves.toEqual('thread-match');
    });

    it('checks both start and finish date directories for windows crossing midnight', async () => {
        const codexHomeDir = await mkdtemp(join(tmpdir(), 'happy-codex-home-'));
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-after-midnight',
            cwd: '/workspace/project',
            timestamp: '2026-05-05T00:00:01.000Z',
        });

        await expect(discoverCodexThreadId({
            codexHomeDir,
            cwd: '/workspace/project',
            startedAt: new Date('2026-05-04T23:59:59.000Z'),
            finishedAt: new Date('2026-05-05T00:00:05.000Z'),
            originator: 'happy-test-launch',
        })).resolves.toEqual('thread-after-midnight');
    });

    it('rejects when no matching new Codex session appears', async () => {
        const codexHomeDir = await mkdtemp(join(tmpdir(), 'happy-codex-home-'));
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-other-cwd',
            cwd: '/workspace/other',
            timestamp: '2026-05-04T11:00:01.000Z',
        });

        await expect(discoverCodexThreadId({
            codexHomeDir,
            cwd: '/workspace/project',
            startedAt: new Date('2026-05-04T11:00:00.000Z'),
            finishedAt: new Date('2026-05-04T11:00:05.000Z'),
            originator: 'happy-test-launch',
        })).rejects.toThrow('Could not discover Codex thread id');
    });

    it('chooses the newest matching thread when the TUI changes threads in-process', async () => {
        const codexHomeDir = await mkdtemp(join(tmpdir(), 'happy-codex-home-'));
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-one',
            cwd: '/workspace/project',
            timestamp: '2026-05-04T11:00:01.000Z',
        });
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-two',
            cwd: '/workspace/project',
            timestamp: '2026-05-04T11:00:02.000Z',
        });

        await expect(discoverCodexThreadId({
            codexHomeDir,
            cwd: '/workspace/project',
            startedAt: new Date('2026-05-04T11:00:00.000Z'),
            finishedAt: new Date('2026-05-04T11:00:05.000Z'),
            originator: 'happy-test-launch',
        })).resolves.toBe('thread-two');
    });

    it('uses the per-launch originator and ignores subagent sessions', async () => {
        const codexHomeDir = await mkdtemp(join(tmpdir(), 'happy-codex-home-'));
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-other-launch',
            cwd: '/workspace/project',
            timestamp: '2026-05-04T11:00:01.000Z',
            originator: 'happy-other-launch',
        });
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-subagent',
            cwd: '/workspace/project',
            timestamp: '2026-05-04T11:00:02.000Z',
            source: { subagent: {} },
            parentThreadId: 'parent-thread',
        });
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-root',
            cwd: '/workspace/project',
            timestamp: '2026-05-04T11:00:03.000Z',
        });

        await expect(discoverCodexThreadId({
            codexHomeDir,
            cwd: '/workspace/project',
            startedAt: new Date('2026-05-04T11:00:00.000Z'),
            finishedAt: new Date('2026-05-04T11:00:05.000Z'),
            originator: 'happy-test-launch',
        })).resolves.toEqual('thread-root');
    });

    it('reads session metadata whose first line is larger than 64 KiB', async () => {
        const codexHomeDir = await mkdtemp(join(tmpdir(), 'happy-codex-home-'));
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-large-meta',
            cwd: '/workspace/project',
            timestamp: '2026-05-04T11:00:01.000Z',
            baseInstructions: 'x'.repeat(80 * 1024),
        });

        await expect(discoverCodexThreadId({
            codexHomeDir,
            cwd: '/workspace/project',
            startedAt: new Date('2026-05-04T11:00:00.000Z'),
            finishedAt: new Date('2026-05-04T11:00:05.000Z'),
            originator: 'happy-test-launch',
        })).resolves.toEqual('thread-large-meta');
    });

    it('finds an existing rollout by its thread id', async () => {
        const codexHomeDir = await mkdtemp(join(tmpdir(), 'happy-codex-home-'));
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-existing',
            cwd: '/workspace/project',
            timestamp: '2026-05-04T11:00:01.000Z',
        });

        const path = await findCodexRolloutPathByThreadId(codexHomeDir, 'thread-existing');
        expect(path).toContain('thread-existing.jsonl');
        await expect(findCodexRolloutPathByThreadId(codexHomeDir, 'thread-missing')).resolves.toBeNull();
    });

    it('tracks the newest user-facing thread even when it is a fork child', async () => {
        const codexHomeDir = await mkdtemp(join(tmpdir(), 'happy-codex-home-'));
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-original',
            cwd: '/workspace/project',
            timestamp: '2026-05-04T11:00:01.000Z',
        });
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-fork',
            cwd: '/workspace/project',
            timestamp: '2026-05-04T11:00:02.000Z',
            parentThreadId: 'thread-original',
        });
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-subagent',
            cwd: '/workspace/project',
            timestamp: '2026-05-04T11:00:03.000Z',
            source: { subagent: {} },
            parentThreadId: 'thread-fork',
        });

        await expect(findActiveCodexThread({
            codexHomeDir,
            startedAt: new Date('2026-05-04T11:00:00.000Z'),
            finishedAt: new Date('2026-05-04T11:00:05.000Z'),
            originator: 'happy-test-launch',
        })).resolves.toMatchObject({
            threadId: 'thread-fork',
            rolloutTimestamp: new Date('2026-05-04T11:00:02.000Z'),
        });
    });

    it('uses rollout time when an in-process resume keeps the thread original timestamp', async () => {
        const codexHomeDir = await mkdtemp(join(tmpdir(), 'happy-codex-home-'));
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-original',
            cwd: '/workspace/project',
            timestamp: '2026-05-04T11:00:01.000Z',
        });
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-resumed',
            cwd: '/workspace/other-project',
            timestamp: '2026-04-01T09:00:00.000Z',
            rolloutTimestamp: '2026-05-04T11:00:02.000Z',
        });

        await expect(findActiveCodexThread({
            codexHomeDir,
            startedAt: new Date('2026-05-04T11:00:00.000Z'),
            finishedAt: new Date('2026-05-04T11:00:05.000Z'),
            originator: 'happy-test-launch',
        })).resolves.toMatchObject({
            threadId: 'thread-resumed',
            rolloutTimestamp: new Date('2026-05-04T11:00:02.000Z'),
        });
    });

    it('prefers an old rollout currently opened by an in-process resume', async () => {
        const codexHomeDir = await mkdtemp(join(tmpdir(), 'happy-codex-home-'));
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-created-this-launch',
            cwd: '/workspace/project',
            timestamp: '2026-05-04T11:00:02.000Z',
        });
        const resumedPath = await writeSessionMeta(codexHomeDir, {
            id: 'thread-old-resumed',
            cwd: '/workspace/project',
            timestamp: '2025-01-01T09:00:00.000Z',
            originator: 'old-codex-launch',
            source: 'vscode',
        });

        await expect(findActiveCodexThread({
            codexHomeDir,
            startedAt: new Date('2026-05-04T11:00:00.000Z'),
            finishedAt: new Date('2026-05-04T11:00:05.000Z'),
            originator: 'happy-test-launch',
            activeRolloutPaths: [resumedPath],
        })).resolves.toMatchObject({
            threadId: 'thread-old-resumed',
            rolloutPath: resumedPath,
        });
    });
});
