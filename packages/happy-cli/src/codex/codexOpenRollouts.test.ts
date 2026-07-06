import { describe, expect, it } from 'vitest';

import { findOpenCodexRolloutPaths } from './codexOpenRollouts';

describe('findOpenCodexRolloutPaths', () => {
    it('finds an old rollout opened by the native descendant on Linux', async () => {
        const links: Record<string, string> = {
            '/proc/11/fd/4': '/tmp/codex-home/sessions/2025/01/01/rollout-old-thread.jsonl',
            '/proc/11/fd/5': '/tmp/unrelated.jsonl',
        };

        await expect(findOpenCodexRolloutPaths({
            rootPid: 10,
            codexHomeDir: '/tmp/codex-home',
            platform: 'linux',
            readProcessTable: () => '10 1\n11 10\n',
            readDirectory: async (path) => path === '/proc/11/fd' ? ['4', '5'] : [],
            readLink: async (path) => links[path],
        })).resolves.toEqual([
            '/tmp/codex-home/sessions/2025/01/01/rollout-old-thread.jsonl',
        ]);
    });

    it('parses rollout paths reported by lsof on macOS', async () => {
        await expect(findOpenCodexRolloutPaths({
            rootPid: 10,
            codexHomeDir: '/tmp/codex-home',
            platform: 'darwin',
            readProcessTable: () => '10 1\n11 10\n',
            runLsof: async () => [
                'p11',
                'n/tmp/codex-home/sessions/2025/01/01/rollout-old-thread.jsonl',
                'n/tmp/unrelated.jsonl',
                '',
            ].join('\n'),
        })).resolves.toEqual([
            '/tmp/codex-home/sessions/2025/01/01/rollout-old-thread.jsonl',
        ]);
    });
});
