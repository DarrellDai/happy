import { describe, expect, it, vi } from 'vitest';

import {
    collectDescendantPids,
    signalPosixProcessDescendants,
    signalProcessIds,
    waitForProcessIdsToExit,
} from './processTree';

const PROCESS_TABLE = `
  10 1
  11 10
  12 10
  13 11
  99 1
`;

describe('processTree', () => {
    it('collects descendants deepest-first without unrelated processes', () => {
        expect(collectDescendantPids(10, PROCESS_TABLE)).toEqual([13, 11, 12]);
    });

    it('signals every descendant before the caller signals the wrapper', () => {
        const kill = vi.fn();
        expect(signalPosixProcessDescendants(10, 'SIGKILL', {
            readProcessTable: () => PROCESS_TABLE,
            kill,
        })).toEqual([13, 11, 12]);
        expect(kill.mock.calls).toEqual([
            [13, 'SIGKILL'],
            [11, 'SIGKILL'],
            [12, 'SIGKILL'],
        ]);
    });

    it('force-signals and verifies captured descendants independently of the wrapper', async () => {
        const alive = new Set([11, 12]);
        const kill = vi.fn((pid: number) => alive.delete(pid));
        expect(await waitForProcessIdsToExit(alive, 0, {
            isAlive: (pid) => alive.has(pid),
        })).toEqual([11, 12]);

        signalProcessIds(alive, 'SIGKILL', kill);

        expect(kill.mock.calls).toEqual([[11, 'SIGKILL'], [12, 'SIGKILL']]);
        await expect(waitForProcessIdsToExit([11, 12], 0, {
            isAlive: (pid) => alive.has(pid),
        })).resolves.toEqual([]);
    });
});
