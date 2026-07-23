import { describe, expect, it, vi } from 'vitest';
import { emitReadyForLocalCompletion } from './emitReadyIfIdle';
import { LocalTurnCompletionGate } from './localTurnCompletionGate';
import { sendCodexReadyNotification } from './sendCodexReadyNotification';

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

    it('emits one ready event and direct push for one fresh-root completion', () => {
        const gate = new LocalTurnCompletionGate();
        const sendReadyEvent = vi.fn();
        const sendToAllDevices = vi.fn();
        const messages = [
            { type: 'task_started', turn_id: 'turn-root' },
            { type: 'task_complete', turn_id: 'turn-child', status: 'completed' },
            { type: 'task_complete', turn_id: 'turn-root', status: 'completed' },
            { type: 'task_complete', turn_id: 'turn-root', status: 'completed' },
        ];

        for (const message of messages) {
            const decision = gate.classify(message);
            if (!decision.accepted || !decision.successfulCompletion) {
                continue;
            }
            emitReadyForLocalCompletion({
                message,
                handoffPending: false,
                queueSize: () => 0,
                shouldExit: false,
                sendReady: () => sendCodexReadyNotification({
                    sessionId: 'fresh-session',
                    metadata: undefined,
                    sendReadyEvent,
                    sendToAllDevices,
                }),
            });
        }

        expect(sendReadyEvent).toHaveBeenCalledTimes(1);
        expect(sendToAllDevices).toHaveBeenCalledTimes(1);
        expect(sendToAllDevices).toHaveBeenCalledWith(
            "It's ready!",
            'Session',
            {
                sessionId: 'fresh-session',
                kind: 'done',
                type: 'ready',
                provider: 'codex',
            },
        );
    });
});
