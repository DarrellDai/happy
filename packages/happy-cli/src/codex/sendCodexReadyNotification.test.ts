import { describe, expect, it, vi } from 'vitest';
import { sendCodexReadyNotification } from './sendCodexReadyNotification';

describe('sendCodexReadyNotification', () => {
    it('emits ready and sends the completion through the direct device path', () => {
        const sendReadyEvent = vi.fn();
        const sendToAllDevices = vi.fn();

        sendCodexReadyNotification({
            sessionId: 'session-1',
            metadata: {
                path: '/Users/test/projects/happy',
                host: 'test-host',
                homeDir: '/Users/test',
                happyHomeDir: '/Users/test/.happy',
                happyLibDir: '/Users/test/.happy/lib',
                happyToolsDir: '/Users/test/.happy/tools',
            },
            sendReadyEvent,
            sendToAllDevices,
        });

        expect(sendReadyEvent).toHaveBeenCalledTimes(1);
        expect(sendToAllDevices).toHaveBeenCalledWith(
            "It's ready!",
            'happy',
            {
                sessionId: 'session-1',
                kind: 'done',
                type: 'ready',
                provider: 'codex',
            },
        );
    });
});
