import { describe, expect, it } from 'vitest';

import { mapCodexMcpMessageToSessionEnvelopes } from './utils/sessionProtocolMapper';
import { normalizeLocalCodexRolloutEvent } from './codexLocalRolloutState';

describe('normalizeLocalCodexRolloutEvent', () => {
    it('carries a persisted error into the following fieldless task completion', () => {
        const error = normalizeLocalCodexRolloutEvent({
            type: 'error',
            message: 'model request failed',
            codex_error_info: { type: 'response_error' },
        }, null);
        expect(error.visibleError).toBe('model request failed');

        const completed = normalizeLocalCodexRolloutEvent(
            { type: 'task_complete' },
            error.pendingFailure,
        );
        expect(completed.message).toEqual({
            type: 'task_complete',
            status: 'failed',
            error: 'model request failed',
        });

        const mapped = mapCodexMcpMessageToSessionEnvelopes(completed.message, {
            currentTurnId: 'turn-1',
        });
        expect(mapped.envelopes[0]?.ev).toEqual({ t: 'turn-end', status: 'failed' });
    });

    it('clears an old failure when a new task starts', () => {
        expect(normalizeLocalCodexRolloutEvent(
            { type: 'task_started' },
            'old failure',
        ).pendingFailure).toBeNull();
    });
});
