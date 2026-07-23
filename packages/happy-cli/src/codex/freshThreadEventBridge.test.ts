import { describe, expect, it, vi } from 'vitest';

import {
    routeFreshThreadNotification,
    routeFreshThreadTurnAccepted,
    type SharedLocalObserverSubscription,
} from './freshThreadEventBridge';

function subscription(
    overrides: Partial<SharedLocalObserverSubscription> = {},
): SharedLocalObserverSubscription {
    return {
        subscribedThreadId: null,
        pendingThreadId: null,
        pendingMethod: null,
        ...overrides,
    };
}

describe('freshThreadEventBridge', () => {
    it('routes accepted turns and notifications only for an adopted unsubscribed root', () => {
        const client = {
            threadId: 'fresh-root',
            adoptThreadTurn: vi.fn(() => true),
            ingestThreadNotification: vi.fn(() => true),
        };

        expect(routeFreshThreadTurnAccepted({
            client,
            turn: { threadId: 'fresh-root', turnId: 'fresh-turn' },
            subscription: subscription({
                pendingThreadId: 'fresh-root',
                pendingMethod: 'thread/start',
            }),
        })).toBe(true);
        expect(routeFreshThreadNotification({
            client,
            notification: {
                threadId: 'fresh-root',
                method: 'turn/completed',
                params: {
                    threadId: 'fresh-root',
                    turn: { id: 'fresh-turn', status: 'completed' },
                },
            },
            subscription: subscription(),
        })).toBe(true);

        expect(client.adoptThreadTurn).toHaveBeenCalledWith('fresh-root', 'fresh-turn');
        expect(client.ingestThreadNotification).toHaveBeenCalledTimes(1);
    });

    it.each([
        {
            name: 'unowned root',
            clientThreadId: 'other-root',
            state: subscription(),
        },
        {
            name: 'committed observer subscription',
            clientThreadId: 'fresh-root',
            state: subscription({ subscribedThreadId: 'fresh-root' }),
        },
        {
            name: 'pending observer resume',
            clientThreadId: 'fresh-root',
            state: subscription({
                pendingThreadId: 'fresh-root',
                pendingMethod: 'thread/resume',
            }),
        },
    ])('rejects events for $name', ({ clientThreadId, state }) => {
        const client = {
            threadId: clientThreadId,
            adoptThreadTurn: vi.fn(() => true),
            ingestThreadNotification: vi.fn(() => true),
        };

        expect(routeFreshThreadTurnAccepted({
            client,
            turn: { threadId: 'fresh-root', turnId: 'fresh-turn' },
            subscription: state,
        })).toBe(false);
        expect(routeFreshThreadNotification({
            client,
            notification: {
                threadId: 'fresh-root',
                method: 'turn/completed',
                params: { threadId: 'fresh-root' },
            },
            subscription: state,
        })).toBe(false);
        expect(client.adoptThreadTurn).not.toHaveBeenCalled();
        expect(client.ingestThreadNotification).not.toHaveBeenCalled();
    });
});
