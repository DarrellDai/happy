import { describe, expect, it, vi } from 'vitest';
import { emitReadyForLocalCompletion, emitReadyIfIdle } from '../emitReadyIfIdle';

describe('emitReadyIfIdle', () => {
    it('emits ready and notification when queue is idle', () => {
        const sendReady = vi.fn();
        const notify = vi.fn();

        const emitted = emitReadyIfIdle({
            pending: null,
            queueSize: () => 0,
            shouldExit: false,
            sendReady,
            notify,
        });

        expect(emitted).toBe(true);
        expect(sendReady).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it('skips when a message is still pending', () => {
        const sendReady = vi.fn();

        const emitted = emitReadyIfIdle({
            pending: {},
            queueSize: () => 0,
            shouldExit: false,
            sendReady,
        });

        expect(emitted).toBe(false);
        expect(sendReady).not.toHaveBeenCalled();
    });

    it('skips when queue still has items', () => {
        const sendReady = vi.fn();

        const emitted = emitReadyIfIdle({
            pending: null,
            queueSize: () => 2,
            shouldExit: false,
            sendReady,
        });

        expect(emitted).toBe(false);
        expect(sendReady).not.toHaveBeenCalled();
    });

    it('skips when shutdown is requested', () => {
        const sendReady = vi.fn();

        const emitted = emitReadyIfIdle({
            pending: null,
            queueSize: () => 0,
            shouldExit: true,
            sendReady,
        });

        expect(emitted).toBe(false);
        expect(sendReady).not.toHaveBeenCalled();
    });
});

describe('emitReadyForLocalCompletion', () => {
    it('emits once for an idle local task completion', () => {
        const sendReady = vi.fn();

        const emitted = emitReadyForLocalCompletion({
            message: { type: 'task_complete', turn_id: 'turn-local' },
            handoffPending: false,
            queueSize: () => 0,
            shouldExit: false,
            sendReady,
        });

        expect(emitted).toBe(true);
        expect(sendReady).toHaveBeenCalledTimes(1);
    });

    it('does not emit for a local abort', () => {
        const sendReady = vi.fn();

        const emitted = emitReadyForLocalCompletion({
            message: { type: 'turn_aborted', turn_id: 'turn-local' },
            handoffPending: false,
            queueSize: () => 0,
            shouldExit: false,
            sendReady,
        });

        expect(emitted).toBe(false);
        expect(sendReady).not.toHaveBeenCalled();
    });

    it.each([
        { type: 'task_complete', status: 'failed' },
        { type: 'task_complete', error: { message: 'boom' } },
    ])('does not emit for a failed local completion: %j', (message) => {
        const sendReady = vi.fn();

        const emitted = emitReadyForLocalCompletion({
            message,
            handoffPending: false,
            queueSize: () => 0,
            shouldExit: false,
            sendReady,
        });

        expect(emitted).toBe(false);
        expect(sendReady).not.toHaveBeenCalled();
    });

    it.each([
        { name: 'phone takeover', handoffPending: true, queueSize: 0, shouldExit: false },
        { name: 'queued follow-up', handoffPending: false, queueSize: 1, shouldExit: false },
        { name: 'session termination', handoffPending: false, queueSize: 0, shouldExit: true },
    ])('does not emit while $name is pending', ({ handoffPending, queueSize, shouldExit }) => {
        const sendReady = vi.fn();

        const emitted = emitReadyForLocalCompletion({
            message: { type: 'task_complete', turn_id: 'turn-local' },
            handoffPending,
            queueSize: () => queueSize,
            shouldExit,
            sendReady,
        });

        expect(emitted).toBe(false);
        expect(sendReady).not.toHaveBeenCalled();
    });
});
