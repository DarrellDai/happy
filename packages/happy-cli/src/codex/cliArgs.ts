const CODEX_STARTING_MODES = ['local', 'remote'] as const;

export type CodexStartingMode = typeof CODEX_STARTING_MODES[number];

export function extractCodexResumeFlag(args: string[]): {
    resumeThreadId: string | null;
    startingMode?: CodexStartingMode;
    args: string[];
} {
    const remainingArgs: string[] = [];
    let resumeThreadId: string | null = null;
    let startingMode: CodexStartingMode | undefined;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--resume' || arg === '-r') {
            if (resumeThreadId !== null) {
                throw new Error('Codex resume flag can only be provided once.');
            }

            const nextArg = args[i + 1];
            if (!nextArg || nextArg.startsWith('-')) {
                throw new Error('Codex resume requires a thread ID: happy codex --resume <thread-id>');
            }

            resumeThreadId = nextArg;
            i++;
            continue;
        }

        if (arg.startsWith('--resume=')) {
            if (resumeThreadId !== null) {
                throw new Error('Codex resume flag can only be provided once.');
            }

            const value = arg.slice('--resume='.length).trim();
            if (!value) {
                throw new Error('Codex resume requires a thread ID: happy codex --resume <thread-id>');
            }

            resumeThreadId = value;
            continue;
        }

        if (arg === '--happy-starting-mode' || arg.startsWith('--happy-starting-mode=')) {
            const value = arg.startsWith('--happy-starting-mode=')
                ? arg.slice('--happy-starting-mode='.length).trim()
                : args[++i];
            if (!value || !CODEX_STARTING_MODES.includes(value as CodexStartingMode)) {
                throw new Error('Codex starting mode must be local or remote: happy codex --happy-starting-mode <local|remote>');
            }
            startingMode = value as CodexStartingMode;
            continue;
        }

        remainingArgs.push(arg);
    }

    return {
        resumeThreadId,
        ...(startingMode ? { startingMode } : {}),
        args: remainingArgs,
    };
}
