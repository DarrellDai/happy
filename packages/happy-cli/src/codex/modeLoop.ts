import type { CodexStartingMode } from './cliArgs';

export type CodexLauncherResult =
    | { type: 'switch'; codexThreadId?: string }
    | { type: 'exit'; code: number; codexThreadId?: string };

export type CodexSwitchAction = 'none' | 'switch-to-local' | 'switch-to-remote' | 'reject';

export function resolveCodexSwitchAction(opts: {
    currentMode: CodexStartingMode;
    targetMode?: CodexStartingMode;
    switchToLocalRequested?: boolean;
    canRunLocal: boolean;
    terminating?: boolean;
}): CodexSwitchAction {
    if (opts.terminating) {
        return 'reject';
    }

    const targetMode = opts.targetMode ?? 'local';
    if (targetMode === 'remote') {
        return opts.currentMode === 'remote' && !opts.switchToLocalRequested
            ? 'none'
            : 'switch-to-remote';
    }

    if (opts.currentMode === 'local' || opts.switchToLocalRequested) {
        return 'none';
    }
    return opts.canRunLocal ? 'switch-to-local' : 'reject';
}

export function resolveCodexStartingMode(opts: {
    startedBy?: 'daemon' | 'terminal';
    requestedMode?: CodexStartingMode;
    hasTTY?: boolean;
}): CodexStartingMode {
    if (opts.startedBy === 'daemon') {
        return 'remote';
    }

    if (opts.requestedMode === 'local' && opts.hasTTY === false) {
        throw new Error('Codex local mode requires an interactive terminal. Use --happy-starting-mode remote for non-TTY sessions.');
    }

    if (opts.requestedMode) {
        return opts.requestedMode;
    }

    return opts.hasTTY === false ? 'remote' : 'local';
}
