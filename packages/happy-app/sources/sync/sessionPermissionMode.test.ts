import { describe, expect, it } from 'vitest';

import {
    resolveSessionPermissionMode,
    setExplicitSessionPermissionMode,
} from './sessionPermissionMode';

describe('resolveSessionPermissionMode', () => {
    it('uses fresh CLI metadata over an implicit existing default', () => {
        expect(resolveSessionPermissionMode({
            existingPermissionMode: 'default',
            metadataPermissionMode: 'yolo',
            sandboxEnabled: false,
        })).toBe('yolo');
    });

    it('keeps an explicit phone default over CLI metadata', () => {
        expect(resolveSessionPermissionMode({
            explicitPermissionMode: 'default',
            existingPermissionMode: 'default',
            metadataPermissionMode: 'yolo',
            sandboxEnabled: false,
        })).toBe('default');
    });
});

describe('setExplicitSessionPermissionMode', () => {
    it('updates only the selected session and preserves explicit defaults', () => {
        const existing = { 'session-a': 'default' };

        expect(setExplicitSessionPermissionMode(existing, 'session-b', 'read-only')).toEqual({
            'session-a': 'default',
            'session-b': 'read-only',
        });
        expect(existing).toEqual({ 'session-a': 'default' });
    });

    it('does not persist unrelated derived defaults', () => {
        expect(setExplicitSessionPermissionMode({}, 'session-b', 'yolo')).toEqual({
            'session-b': 'yolo',
        });
    });
});
