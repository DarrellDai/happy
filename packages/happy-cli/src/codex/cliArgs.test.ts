import { describe, expect, it } from 'vitest';

import { extractCodexPermissionFlags, extractCodexResumeFlag } from './cliArgs';

describe('extractCodexPermissionFlags', () => {
    it('maps never + danger-full-access to Happy yolo mode', () => {
        expect(extractCodexPermissionFlags([
            '--sandbox',
            'danger-full-access',
            '--ask-for-approval',
            'never',
            '--started-by',
            'terminal',
        ])).toEqual({
            permissionMode: 'yolo',
            args: ['--started-by', 'terminal'],
        });
    });

    it('supports equals syntax and short native aliases in either order', () => {
        expect(extractCodexPermissionFlags([
            '--ask-for-approval=never',
            '--sandbox=danger-full-access',
        ])).toEqual({ permissionMode: 'yolo', args: [] });
        expect(extractCodexPermissionFlags([
            '-a',
            'never',
            '-s',
            'read-only',
        ])).toEqual({ permissionMode: 'read-only', args: [] });
    });

    it('maps every supported native policy pair', () => {
        expect(extractCodexPermissionFlags([
            '--ask-for-approval', 'untrusted', '--sandbox', 'workspace-write',
        ]).permissionMode).toBe('default');
        expect(extractCodexPermissionFlags([
            '--ask-for-approval', 'never', '--sandbox', 'read-only',
        ]).permissionMode).toBe('read-only');
        expect(extractCodexPermissionFlags([
            '--ask-for-approval', 'never', '--sandbox', 'workspace-write',
        ]).permissionMode).toBe('safe-yolo');
        expect(extractCodexPermissionFlags([
            '--ask-for-approval', 'never', '--sandbox', 'danger-full-access',
        ]).permissionMode).toBe('yolo');
    });

    it('supports attached short native aliases', () => {
        expect(extractCodexPermissionFlags([
            '-a=never',
            '-s=danger-full-access',
        ])).toEqual({ permissionMode: 'yolo', args: [] });
        expect(extractCodexPermissionFlags([
            '-anever',
            '-sworkspace-write',
        ])).toEqual({ permissionMode: 'safe-yolo', args: [] });
    });

    it('accepts Happy permission mode and Codex bypass forms', () => {
        expect(extractCodexPermissionFlags(['--permission-mode=yolo'])).toEqual({
            permissionMode: 'yolo',
            args: [],
        });
        expect(extractCodexPermissionFlags(['--dangerously-bypass-approvals-and-sandbox'])).toEqual({
            permissionMode: 'yolo',
            args: [],
        });
    });

    it('accepts redundant policy forms only when they agree', () => {
        expect(extractCodexPermissionFlags([
            '--permission-mode', 'yolo',
            '--ask-for-approval', 'never',
            '--sandbox', 'danger-full-access',
            '--dangerously-bypass-approvals-and-sandbox',
        ])).toEqual({ permissionMode: 'yolo', args: [] });

        expect(() => extractCodexPermissionFlags([
            '--permission-mode', 'default',
            '--ask-for-approval', 'never',
            '--sandbox', 'danger-full-access',
        ])).toThrow('Conflicting Codex permission flags were provided.');
    });

    it('rejects incomplete and unsupported native policy pairs', () => {
        expect(() => extractCodexPermissionFlags([
            '--sandbox', 'danger-full-access',
        ])).toThrow('requires both --ask-for-approval and --sandbox');
        expect(() => extractCodexPermissionFlags([
            '--ask-for-approval', 'on-request',
            '--sandbox', 'danger-full-access',
        ])).toThrow('Unsupported Codex policy combination');
    });

    it('rejects missing, invalid, and duplicate values', () => {
        expect(() => extractCodexPermissionFlags(['--ask-for-approval'])).toThrow(
            '--ask-for-approval requires a value.',
        );
        expect(() => extractCodexPermissionFlags(['--sandbox='])).toThrow(
            '--sandbox requires a value.',
        );
        expect(() => extractCodexPermissionFlags(['--permission-mode', 'unsafe'])).toThrow(
            '--permission-mode must be one of',
        );
        expect(() => extractCodexPermissionFlags([
            '--ask-for-approval', 'on-failure', '--sandbox', 'workspace-write',
        ])).toThrow('--ask-for-approval must be one of');
        expect(() => extractCodexPermissionFlags([
            '--permission-mode', 'yolo', '--permission-mode=default',
        ])).toThrow('--permission-mode can only be provided once.');
    });

    it('preserves unrelated arguments when no policy is provided', () => {
        expect(extractCodexPermissionFlags(['--started-by', 'daemon'])).toEqual({
            args: ['--started-by', 'daemon'],
        });
    });
});

describe('extractCodexResumeFlag', () => {
    it('returns null and preserves args when resume flag is absent', () => {
        const parsed = extractCodexResumeFlag(['--started-by', 'terminal']);

        expect(parsed.resumeThreadId).toBeNull();
        expect(parsed.args).toEqual(['--started-by', 'terminal']);
    });

    it('extracts an explicit resume thread ID', () => {
        const parsed = extractCodexResumeFlag(['--resume', 'thread-123', '--started-by', 'daemon']);

        expect(parsed.resumeThreadId).toBe('thread-123');
        expect(parsed.args).toEqual(['--started-by', 'daemon']);
    });

    it('preserves native positional resume syntax for a picker or thread ID', () => {
        expect(extractCodexResumeFlag([
            'resume',
            '--all',
        ])).toEqual({
            resumeThreadId: null,
            nativeResumeArgs: ['--all'],
            args: [],
        });
        expect(extractCodexResumeFlag([
            'resume',
            'thread-positional',
            'continue now',
            '--started-by',
            'terminal',
        ])).toEqual({
            resumeThreadId: null,
            nativeResumeArgs: ['thread-positional', 'continue now'],
            args: ['--started-by', 'terminal'],
        });
    });

    it('recognizes native resume after Happy wrapper flags', () => {
        expect(extractCodexResumeFlag([
            '--started-by',
            'daemon',
            '--happy-starting-mode',
            'local',
            'resume',
            '--last',
        ])).toEqual({
            resumeThreadId: null,
            nativeResumeArgs: ['--last'],
            startingMode: 'local',
            args: ['--started-by', 'daemon'],
        });
    });

    it('preserves native fork syntax for a picker, flags, thread ID, and prompt', () => {
        expect(extractCodexResumeFlag(['fork'])).toEqual({
            resumeThreadId: null,
            nativeForkArgs: [],
            args: [],
        });
        expect(extractCodexResumeFlag([
            '--started-by',
            'terminal',
            'fork',
            '--last',
        ])).toEqual({
            resumeThreadId: null,
            nativeForkArgs: ['--last'],
            args: ['--started-by', 'terminal'],
        });
        expect(extractCodexResumeFlag([
            'fork',
            'thread-positional',
            'try another approach',
        ])).toEqual({
            resumeThreadId: null,
            nativeForkArgs: ['thread-positional', 'try another approach'],
            args: [],
        });
    });

    it('supports equals syntax', () => {
        const parsed = extractCodexResumeFlag(['--resume=thread-456', '--started-by', 'terminal']);

        expect(parsed.resumeThreadId).toBe('thread-456');
        expect(parsed.args).toEqual(['--started-by', 'terminal']);
    });

    it('extracts Codex starting mode in separate and equals forms', () => {
        expect(extractCodexResumeFlag([
            '--happy-starting-mode',
            'remote',
            '--started-by',
            'daemon',
        ])).toEqual({
            resumeThreadId: null,
            startingMode: 'remote',
            args: ['--started-by', 'daemon'],
        });
        expect(extractCodexResumeFlag(['--happy-starting-mode=local'])).toEqual({
            resumeThreadId: null,
            startingMode: 'local',
            args: [],
        });
    });

    it('rejects an invalid Codex starting mode', () => {
        expect(() => extractCodexResumeFlag(['--happy-starting-mode', 'sideways'])).toThrow(
            'Codex starting mode must be local or remote',
        );
    });

    it('throws when resume flag is missing a thread ID', () => {
        expect(() => extractCodexResumeFlag(['--resume'])).toThrow(
            'Codex resume requires a thread ID: happy codex --resume <thread-id>',
        );
    });

    it('rejects combining positional and flag resume forms', () => {
        expect(() => extractCodexResumeFlag(['resume', '--resume', 'thread-123'])).toThrow(
            'Codex resume flag can only be provided once.',
        );
    });

    it('rejects combining a native fork command with the Happy resume flag', () => {
        expect(() => extractCodexResumeFlag(['fork', '--resume', 'thread-123'])).toThrow(
            'Codex resume and fork commands cannot be combined.',
        );
    });
});
