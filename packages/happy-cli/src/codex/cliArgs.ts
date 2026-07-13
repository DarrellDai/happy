const CODEX_STARTING_MODES = ['local', 'remote'] as const;
const CODEX_PERMISSION_MODES = ['default', 'read-only', 'safe-yolo', 'yolo'] as const;
const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
const CODEX_APPROVAL_POLICIES = ['untrusted', 'on-request', 'never'] as const;

export type CodexStartingMode = typeof CODEX_STARTING_MODES[number];
export type CodexInitialPermissionMode = typeof CODEX_PERMISSION_MODES[number];

type CodexSandboxMode = typeof CODEX_SANDBOX_MODES[number];
type CodexApprovalPolicy = typeof CODEX_APPROVAL_POLICIES[number];

function readOptionValue(
    args: string[],
    index: number,
    canonicalFlag: string,
    shortFlag?: string,
): { value: string; nextIndex: number } {
    const arg = args[index];
    const equalsPrefixes = [`${canonicalFlag}=`, ...(shortFlag ? [`${shortFlag}=`] : [])];

    const equalsPrefix = equalsPrefixes.find((prefix) => arg.startsWith(prefix));
    if (equalsPrefix) {
        const value = arg.slice(equalsPrefix.length).trim();
        if (!value) {
            throw new Error(`${canonicalFlag} requires a value.`);
        }
        return { value, nextIndex: index };
    }

    if (shortFlag && arg.startsWith(shortFlag) && arg.length > shortFlag.length) {
        const value = arg.slice(shortFlag.length).trim();
        if (!value) {
            throw new Error(`${canonicalFlag} requires a value.`);
        }
        return { value, nextIndex: index };
    }

    const value = args[index + 1];
    if (!value || value.startsWith('-')) {
        throw new Error(`${canonicalFlag} requires a value.`);
    }
    return { value, nextIndex: index + 1 };
}

function assertAllowedValue<T extends string>(
    value: string,
    allowedValues: readonly T[],
    flag: string,
): asserts value is T {
    if (!allowedValues.includes(value as T)) {
        throw new Error(`${flag} must be one of: ${allowedValues.join(', ')}.`);
    }
}

/**
 * Extracts the Codex execution policy flags that Happy must carry across local
 * and remote handoffs. Native Codex policy pairs are converted to the matching
 * Happy permission mode instead of being silently discarded by the wrapper.
 */
export function extractCodexPermissionFlags(args: string[]): {
    permissionMode?: CodexInitialPermissionMode;
    args: string[];
} {
    const remainingArgs: string[] = [];
    let explicitPermissionMode: CodexInitialPermissionMode | undefined;
    let sandboxMode: CodexSandboxMode | undefined;
    let approvalPolicy: CodexApprovalPolicy | undefined;
    let bypassApprovalsAndSandbox = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--permission-mode' || arg.startsWith('--permission-mode=')) {
            if (explicitPermissionMode !== undefined) {
                throw new Error('--permission-mode can only be provided once.');
            }
            const parsed = readOptionValue(args, i, '--permission-mode');
            assertAllowedValue(parsed.value, CODEX_PERMISSION_MODES, '--permission-mode');
            explicitPermissionMode = parsed.value;
            i = parsed.nextIndex;
            continue;
        }

        if (
            arg === '--sandbox'
            || arg === '-s'
            || arg.startsWith('--sandbox=')
            || (arg.startsWith('-s') && arg.length > 2)
        ) {
            if (sandboxMode !== undefined) {
                throw new Error('--sandbox can only be provided once.');
            }
            const parsed = readOptionValue(args, i, '--sandbox', '-s');
            assertAllowedValue(parsed.value, CODEX_SANDBOX_MODES, '--sandbox');
            sandboxMode = parsed.value;
            i = parsed.nextIndex;
            continue;
        }

        if (
            arg === '--ask-for-approval'
            || arg === '-a'
            || arg.startsWith('--ask-for-approval=')
            || (arg.startsWith('-a') && arg.length > 2)
        ) {
            if (approvalPolicy !== undefined) {
                throw new Error('--ask-for-approval can only be provided once.');
            }
            const parsed = readOptionValue(args, i, '--ask-for-approval', '-a');
            assertAllowedValue(parsed.value, CODEX_APPROVAL_POLICIES, '--ask-for-approval');
            approvalPolicy = parsed.value;
            i = parsed.nextIndex;
            continue;
        }

        if (arg === '--dangerously-bypass-approvals-and-sandbox') {
            if (bypassApprovalsAndSandbox) {
                throw new Error('--dangerously-bypass-approvals-and-sandbox can only be provided once.');
            }
            bypassApprovalsAndSandbox = true;
            continue;
        }

        remainingArgs.push(arg);
    }

    let nativePermissionMode: CodexInitialPermissionMode | undefined;
    if (sandboxMode !== undefined || approvalPolicy !== undefined) {
        if (sandboxMode === undefined || approvalPolicy === undefined) {
            throw new Error('Codex native policy requires both --ask-for-approval and --sandbox when used through Happy.');
        }

        const nativePolicyKey = `${approvalPolicy}:${sandboxMode}`;
        nativePermissionMode = ({
            'untrusted:workspace-write': 'default',
            'never:read-only': 'read-only',
            'never:workspace-write': 'safe-yolo',
            'never:danger-full-access': 'yolo',
        } as const)[nativePolicyKey as
            | 'untrusted:workspace-write'
            | 'never:read-only'
            | 'never:workspace-write'
            | 'never:danger-full-access'];

        if (!nativePermissionMode) {
            throw new Error(
                `Unsupported Codex policy combination: --ask-for-approval ${approvalPolicy} --sandbox ${sandboxMode}.`,
            );
        }
    }

    const resolvedModes = [
        explicitPermissionMode,
        nativePermissionMode,
        bypassApprovalsAndSandbox ? 'yolo' as const : undefined,
    ].filter((mode): mode is CodexInitialPermissionMode => mode !== undefined);
    const distinctModes = new Set(resolvedModes);
    if (distinctModes.size > 1) {
        throw new Error('Conflicting Codex permission flags were provided.');
    }

    const permissionMode = resolvedModes[0];
    return {
        ...(permissionMode ? { permissionMode } : {}),
        args: remainingArgs,
    };
}

export function extractCodexResumeFlag(args: string[]): {
    resumeThreadId: string | null;
    nativeResumeArgs?: string[];
    startingMode?: CodexStartingMode;
    args: string[];
} {
    const remainingArgs: string[] = [];
    let resumeThreadId: string | null = null;
    let nativeResumeArgs: string[] | undefined;
    let startingMode: CodexStartingMode | undefined;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--resume' || arg === '-r') {
            if (resumeThreadId !== null || nativeResumeArgs) {
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
            if (resumeThreadId !== null || nativeResumeArgs) {
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

        if (arg === '--started-by') {
            remainingArgs.push(arg);
            if (args[i + 1]) {
                remainingArgs.push(args[++i]);
            }
            continue;
        }

        if (nativeResumeArgs === undefined && arg === 'resume') {
            if (resumeThreadId !== null) {
                throw new Error('Codex resume flag can only be provided once.');
            }
            nativeResumeArgs = [];
            continue;
        }

        if (nativeResumeArgs) {
            // Forward every native resume option, target, and optional prompt
            // unchanged after extracting Happy's own wrapper arguments.
            nativeResumeArgs.push(arg);
            continue;
        }

        remainingArgs.push(arg);
    }

    return {
        resumeThreadId,
        ...(nativeResumeArgs ? { nativeResumeArgs } : {}),
        ...(startingMode ? { startingMode } : {}),
        args: remainingArgs,
    };
}
