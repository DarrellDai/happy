import { describe, expect, it } from 'vitest';

import { resolveCodexStartingMode, resolveCodexSwitchAction } from './modeLoop';

describe('resolveCodexStartingMode', () => {
    it('defaults an interactive terminal session to local mode', () => {
        expect(resolveCodexStartingMode({ startedBy: 'terminal', hasTTY: true })).toBe('local');
    });

    it('defaults a non-interactive terminal session to remote mode', () => {
        expect(resolveCodexStartingMode({ startedBy: 'terminal', hasTTY: false })).toBe('remote');
    });

    it('honors an explicit terminal mode', () => {
        expect(resolveCodexStartingMode({
            startedBy: 'terminal',
            requestedMode: 'remote',
            hasTTY: true,
        })).toBe('remote');
        expect(resolveCodexStartingMode({
            startedBy: 'terminal',
            requestedMode: 'local',
            hasTTY: true,
        })).toBe('local');
    });

    it('rejects explicit local mode without an interactive terminal', () => {
        expect(() => resolveCodexStartingMode({
            startedBy: 'terminal',
            requestedMode: 'local',
            hasTTY: false,
        })).toThrow('requires an interactive terminal');
    });

    it('always forces daemon-started sessions to remote mode', () => {
        expect(resolveCodexStartingMode({
            startedBy: 'daemon',
            requestedMode: 'local',
            hasTTY: true,
        })).toBe('remote');
    });
});

describe('resolveCodexSwitchAction', () => {
    it('honors explicit target modes idempotently', () => {
        expect(resolveCodexSwitchAction({
            currentMode: 'remote',
            targetMode: 'remote',
            canRunLocal: true,
        })).toBe('none');
        expect(resolveCodexSwitchAction({
            currentMode: 'local',
            targetMode: 'local',
            canRunLocal: true,
        })).toBe('none');
    });

    it('cancels a pending local transition when remote is requested', () => {
        expect(resolveCodexSwitchAction({
            currentMode: 'remote',
            targetMode: 'remote',
            switchToLocalRequested: true,
            canRunLocal: true,
        })).toBe('switch-to-remote');
    });

    it('rejects local mode without a TTY or during termination', () => {
        expect(resolveCodexSwitchAction({
            currentMode: 'remote',
            targetMode: 'local',
            canRunLocal: false,
        })).toBe('reject');
        expect(resolveCodexSwitchAction({
            currentMode: 'remote',
            targetMode: 'local',
            canRunLocal: true,
            terminating: true,
        })).toBe('reject');
    });
});
