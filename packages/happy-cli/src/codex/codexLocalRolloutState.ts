export function normalizeLocalCodexRolloutEvent(
    message: Record<string, unknown>,
    pendingFailure: string | null,
): {
    message: Record<string, unknown>;
    pendingFailure: string | null;
    visibleError?: string;
} {
    if (message.type === 'task_started') {
        return { message, pendingFailure: null };
    }

    if (message.type === 'error') {
        const visibleError = typeof message.message === 'string' && message.message.length > 0
            ? message.message
            : 'Unknown local Codex error';
        return { message, pendingFailure: visibleError, visibleError };
    }

    if (message.type === 'task_complete' || message.type === 'turn_aborted') {
        return {
            message: pendingFailure
                ? { ...message, status: 'failed', error: pendingFailure }
                : message,
            pendingFailure: null,
        };
    }

    return { message, pendingFailure };
}
