import { describe, expect, it } from 'vitest';
import { resolveMessageModeMeta } from './messageMeta';

describe('resolveMessageModeMeta', () => {
    it('sends explicit permission and model keys', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'read-only',
            modelMode: 'gpt-5-high',
            metadata: null,
        } as any);

        expect(meta).toEqual({
            permissionMode: 'read-only',
            model: 'gpt-5-high',
            effort: null,
        });
    });

    it('keeps an explicit default mode in a sandboxed session', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'default',
            modelMode: null,
            metadata: {
                sandbox: { enabled: true },
            },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'default',
            model: null,
            effort: null,
        });
    });

    it('falls back to bypass permissions in a sandboxed session with no mode', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: null,
            modelMode: null,
            metadata: {
                sandbox: { enabled: true },
            },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'bypassPermissions',
            model: null,
            effort: null,
        });
    });

    it('keeps default permissions when sandbox is disabled', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: null,
            modelMode: 'default',
            metadata: {
                sandbox: null,
            },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'default',
            model: null,
            effort: null,
        });
    });

    it('uses the CLI-published permission mode for the first phone message', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: null,
            modelMode: 'default',
            metadata: {
                permissionMode: 'yolo',
                sandbox: null,
            },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'yolo',
            model: null,
            effort: null,
        });
    });

    it('lets an explicit phone default override the CLI-published mode', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'default',
            modelMode: 'default',
            metadata: {
                permissionMode: 'yolo',
                sandbox: null,
            },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'default',
            model: null,
            effort: null,
        });
    });
});
