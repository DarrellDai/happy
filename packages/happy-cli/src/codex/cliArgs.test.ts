import { describe, expect, it } from 'vitest';

import { extractCodexResumeFlag } from './cliArgs';

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
});
