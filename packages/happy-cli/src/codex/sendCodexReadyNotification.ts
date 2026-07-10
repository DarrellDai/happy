import { getSessionNotificationCopy } from '@/api/pushNotifications';
import type { Metadata } from '@/api/types';

export function sendCodexReadyNotification(params: {
    sessionId: string;
    metadata: Metadata | null | undefined;
    sendReadyEvent: () => void;
    sendToAllDevices: (
        title: string,
        body: string,
        data: Record<string, unknown>,
    ) => void;
}): void {
    params.sendReadyEvent();

    const { title, body } = getSessionNotificationCopy('done', params.metadata);
    params.sendToAllDevices(title, body, {
        sessionId: params.sessionId,
        kind: 'done',
        type: 'ready',
        provider: 'codex',
    });
}
