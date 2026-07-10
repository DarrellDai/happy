import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendPushNotifications, type PushMessage } from './pushSend';

const messages: PushMessage[] = [
    { to: 'ExponentPushToken[current-project]', title: 'Ready' },
    { to: 'ExponentPushToken[stale-project]', title: 'Ready' },
];

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('sendPushNotifications', () => {
    it('sends every token in a separate provider request and preserves ticket order', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ data: { status: 'ok', id: 'current-ticket' } }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ data: [{ status: 'ok', id: 'stale-ticket' }] }),
            });
        vi.stubGlobal('fetch', fetchMock);

        const tickets = await sendPushNotifications(messages);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual([messages[0]]);
        expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual([messages[1]]);
        expect(tickets).toEqual([
            { status: 'ok', id: 'current-ticket' },
            { status: 'ok', id: 'stale-ticket' },
        ]);
    });

    it('continues with valid tokens when another token request fails', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce({ ok: false, status: 400 })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ data: [{ status: 'ok', id: 'valid-ticket' }] }),
            });
        vi.stubGlobal('fetch', fetchMock);

        const tickets = await sendPushNotifications(messages);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(tickets).toEqual([
            { status: 'error', message: 'HTTP 400' },
            { status: 'ok', id: 'valid-ticket' },
        ]);
    });

    it('returns one error ticket when Expo returns an invalid response', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ data: [] }),
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(sendPushNotifications([messages[0]])).resolves.toEqual([
            { status: 'error', message: 'Invalid response from Expo push service' },
        ]);
    });
});
