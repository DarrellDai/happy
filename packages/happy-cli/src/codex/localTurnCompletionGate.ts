export type LocalTurnCompletionDecision = {
    accepted: boolean;
    successfulCompletion: boolean;
};

function getTurnId(message: Record<string, unknown>): string | null {
    const turnId = message.turn_id ?? message.turnId;
    return typeof turnId === 'string' && turnId.length > 0 ? turnId : null;
}

function isFailedCompletion(message: Record<string, unknown>): boolean {
    return message.status === 'failed'
        || (message.error !== undefined && message.error !== null);
}

/**
 * Owns the provider turn identity for the shared local-TUI event stream.
 * Terminal events are accepted only for the active root turn, so stale,
 * duplicate, and nested-thread completions cannot end or notify the root turn.
 */
export class LocalTurnCompletionGate {
    private activeTurnId: string | null = null;

    adoptActiveTurn(turnId: string | null | undefined): void {
        this.activeTurnId = typeof turnId === 'string' && turnId.length > 0
            ? turnId
            : null;
    }

    classify(message: Record<string, unknown>): LocalTurnCompletionDecision {
        if (message.type === 'task_started') {
            const turnId = getTurnId(message);
            if (turnId) {
                this.activeTurnId = turnId;
            }
            return { accepted: true, successfulCompletion: false };
        }

        if (message.type !== 'task_complete' && message.type !== 'turn_aborted') {
            return { accepted: true, successfulCompletion: false };
        }

        const turnId = getTurnId(message);
        if (!turnId || !this.activeTurnId || turnId !== this.activeTurnId) {
            return { accepted: false, successfulCompletion: false };
        }

        // Clear ownership before the caller performs any side effects. A
        // duplicate/re-entrant completion then fails closed.
        this.activeTurnId = null;
        return {
            accepted: true,
            successfulCompletion: message.type === 'task_complete' && !isFailedCompletion(message),
        };
    }
}
