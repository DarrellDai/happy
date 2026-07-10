import { describe, expect, it } from 'vitest';
import { LocalTurnCompletionGate } from './localTurnCompletionGate';

describe('LocalTurnCompletionGate', () => {
    it('accepts one successful completion for the active local root turn', () => {
        const gate = new LocalTurnCompletionGate();

        expect(gate.classify({ type: 'task_started', turn_id: 'turn-1' })).toEqual({
            accepted: true,
            successfulCompletion: false,
        });
        expect(gate.classify({ type: 'task_complete', turn_id: 'turn-1', status: 'completed' })).toEqual({
            accepted: true,
            successfulCompletion: true,
        });
        expect(gate.classify({ type: 'task_complete', turn_id: 'turn-1', status: 'completed' })).toEqual({
            accepted: false,
            successfulCompletion: false,
        });
    });

    it('ignores a stale completion without consuming the newer root turn', () => {
        const gate = new LocalTurnCompletionGate();
        gate.classify({ type: 'task_started', turn_id: 'turn-1' });
        gate.classify({ type: 'task_started', turn_id: 'turn-2' });

        expect(gate.classify({ type: 'task_complete', turn_id: 'turn-1' })).toEqual({
            accepted: false,
            successfulCompletion: false,
        });
        expect(gate.classify({ type: 'task_complete', turn_id: 'turn-2' })).toEqual({
            accepted: true,
            successfulCompletion: true,
        });
    });

    it('ignores a child turn completion while the root turn remains active', () => {
        const gate = new LocalTurnCompletionGate();
        gate.classify({ type: 'task_started', turn_id: 'turn-root' });

        expect(gate.classify({ type: 'task_complete', turn_id: 'turn-child' })).toEqual({
            accepted: false,
            successfulCompletion: false,
        });
        expect(gate.classify({ type: 'task_complete', turn_id: 'turn-root' })).toEqual({
            accepted: true,
            successfulCompletion: true,
        });
    });

    it.each([
        { message: { type: 'turn_aborted', turn_id: 'turn-1', status: 'cancelled' }, name: 'abort' },
        { message: { type: 'task_complete', turn_id: 'turn-1', status: 'failed' }, name: 'failed status' },
        { message: { type: 'task_complete', turn_id: 'turn-1', error: { message: 'boom' } }, name: 'error payload' },
    ])('accepts $name as terminal without marking it successful', ({ message }) => {
        const gate = new LocalTurnCompletionGate();
        gate.classify({ type: 'task_started', turn_id: 'turn-1' });

        expect(gate.classify(message)).toEqual({
            accepted: true,
            successfulCompletion: false,
        });
    });

    it('adopts a turn that was already active when local mode attached', () => {
        const gate = new LocalTurnCompletionGate();
        gate.adoptActiveTurn('turn-existing');

        expect(gate.classify({ type: 'task_complete', turn_id: 'turn-existing' })).toEqual({
            accepted: true,
            successfulCompletion: true,
        });
    });

    it('allows distinct local turns to complete independently', () => {
        const gate = new LocalTurnCompletionGate();

        gate.classify({ type: 'task_started', turn_id: 'turn-1' });
        expect(gate.classify({ type: 'task_complete', turn_id: 'turn-1' }).successfulCompletion).toBe(true);
        gate.classify({ type: 'task_started', turn_id: 'turn-2' });
        expect(gate.classify({ type: 'task_complete', turn_id: 'turn-2' }).successfulCompletion).toBe(true);
    });
});
