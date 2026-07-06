import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { getCodexRolloutSize, tailCodexRollout } from './codexRolloutTailer';

async function waitFor(predicate: () => boolean, timeoutMs: number = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error(`Timed out after ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

describe('tailCodexRollout', () => {
    it('streams complete event_msg records and ignores other rollout records', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happy-codex-rollout-'));
        const path = join(dir, 'rollout.jsonl');
        await writeFile(path, [
            JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1' } }),
            JSON.stringify({ type: 'response_item', payload: { type: 'message' } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } }),
            '',
        ].join('\n'));

        const events: Array<Record<string, unknown>> = [];
        const abort = new AbortController();
        const tail = tailCodexRollout({
            path,
            signal: abort.signal,
            pollMs: 1,
            onEvent: (event) => events.push(event),
        });

        await waitFor(() => events.length === 1);
        abort.abort();
        await tail;

        expect(events).toEqual([{ type: 'task_started', turn_id: 'turn-1' }]);
    });

    it('starts at an existing EOF and waits for a complete appended line', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happy-codex-rollout-'));
        const path = join(dir, 'rollout.jsonl');
        await writeFile(path, `${JSON.stringify({ type: 'event_msg', payload: { type: 'old' } })}\n`);
        const startOffset = await getCodexRolloutSize(path);

        const events: Array<Record<string, unknown>> = [];
        const abort = new AbortController();
        const tail = tailCodexRollout({
            path,
            startOffset,
            signal: abort.signal,
            pollMs: 1,
            onEvent: (event) => events.push(event),
        });

        const appended = JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'hello' } });
        await appendFile(path, appended.slice(0, 20));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(events).toEqual([]);
        await appendFile(path, `${appended.slice(20)}\n`);
        await waitFor(() => events.length === 1);

        abort.abort();
        await tail;
        expect(events).toEqual([{ type: 'agent_message', message: 'hello' }]);
    });

    it('drains a final valid record even when it has no trailing newline', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happy-codex-rollout-'));
        const path = join(dir, 'rollout.jsonl');
        await writeFile(path, '');

        const events: Array<Record<string, unknown>> = [];
        const abort = new AbortController();
        const tail = tailCodexRollout({
            path,
            signal: abort.signal,
            pollMs: 1,
            onEvent: (event) => events.push(event),
        });

        await appendFile(path, JSON.stringify({
            type: 'event_msg',
            payload: { type: 'agent_message', message: 'final' },
        }));
        abort.abort();
        await tail;

        expect(events).toEqual([{ type: 'agent_message', message: 'final' }]);
    });
});
