type ReadyEventOptions = {
    pending: unknown;
    queueSize: () => number;
    shouldExit: boolean;
    sendReady: () => void;
    notify?: () => void;
};

/**
 * Notify connected clients when Codex finishes processing and the queue is idle.
 * Returns true when a ready event was emitted.
 */
export function emitReadyIfIdle({ pending, queueSize, shouldExit, sendReady, notify }: ReadyEventOptions): boolean {
    if (shouldExit) {
        return false;
    }
    if (pending) {
        return false;
    }
    if (queueSize() > 0) {
        return false;
    }

    sendReady();
    notify?.();
    return true;
}

type LocalCompletionReadyOptions = Omit<ReadyEventOptions, 'pending'> & {
    message: Record<string, unknown>;
    handoffPending: boolean;
};

/**
 * Emit ready after a PC-local Codex turn completes and no phone takeover or
 * queued follow-up is waiting. Aborts are intentionally excluded: the user who
 * cancelled locally does not need an "It's ready!" push on another device.
 */
export function emitReadyForLocalCompletion({
    message,
    handoffPending,
    queueSize,
    shouldExit,
    sendReady,
    notify,
}: LocalCompletionReadyOptions): boolean {
    if (message.type !== 'task_complete') {
        return false;
    }
    if (message.status === 'failed' || (message.error !== undefined && message.error !== null)) {
        return false;
    }

    return emitReadyIfIdle({
        pending: handoffPending ? true : null,
        queueSize,
        shouldExit,
        sendReady,
        notify,
    });
}
