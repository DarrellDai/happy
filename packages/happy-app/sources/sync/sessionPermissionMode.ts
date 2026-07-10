import type { PermissionModeKey } from '@/components/PermissionModeSelector';

export function resolveSessionPermissionMode(options: {
    explicitPermissionMode?: PermissionModeKey | null;
    metadataPermissionMode?: PermissionModeKey | null;
    existingPermissionMode?: PermissionModeKey | null;
    incomingPermissionMode?: PermissionModeKey | null;
    sandboxEnabled: boolean;
}): PermissionModeKey {
    return options.explicitPermissionMode
        ?? options.metadataPermissionMode
        ?? options.existingPermissionMode
        ?? options.incomingPermissionMode
        ?? (options.sandboxEnabled ? 'bypassPermissions' : 'default');
}

export function setExplicitSessionPermissionMode(
    modes: Record<string, PermissionModeKey>,
    sessionId: string,
    mode: PermissionModeKey,
): Record<string, PermissionModeKey> {
    return {
        ...modes,
        [sessionId]: mode,
    };
}
