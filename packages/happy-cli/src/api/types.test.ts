import { describe, expect, it } from 'vitest';

import { MessageMetaSchema } from './types';

describe('MessageMetaSchema effort', () => {
    it('preserves supported Claude and Codex effort values', () => {
        expect(MessageMetaSchema.parse({ effort: 'max' }).effort).toBe('max');
        expect(MessageMetaSchema.parse({ effort: 'xhigh' }).effort).toBe('xhigh');
        expect(MessageMetaSchema.parse({ effort: null }).effort).toBeNull();
    });

    it('rejects unsupported effort values', () => {
        expect(() => MessageMetaSchema.parse({ effort: 'extreme' })).toThrow();
    });
});
