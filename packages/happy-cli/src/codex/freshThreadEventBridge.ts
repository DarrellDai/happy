import type { CodexAppServerClient } from './codexAppServerClient';
import type {
    CodexTuiSelectionMethod,
    CodexTuiThreadNotification,
    CodexTuiTurnAccepted,
} from './codexTuiWebSocketProxy';

export type SharedLocalObserverSubscription = {
    subscribedThreadId: string | null;
    pendingThreadId: string | null;
    pendingMethod: CodexTuiSelectionMethod | null;
};

type FreshThreadEventClient = Pick<
    CodexAppServerClient,
    'threadId' | 'adoptThreadTurn' | 'ingestThreadNotification'
>;

function observerOwnsThread(
    threadId: string,
    subscription: SharedLocalObserverSubscription,
): boolean {
    return subscription.subscribedThreadId === threadId
        || (
            subscription.pendingThreadId === threadId
            && subscription.pendingMethod !== 'thread/start'
        );
}

function canRouteFreshThreadEvent(
    client: FreshThreadEventClient,
    threadId: string,
    subscription: SharedLocalObserverSubscription,
): boolean {
    return client.threadId === threadId && !observerOwnsThread(threadId, subscription);
}

export function routeFreshThreadTurnAccepted(params: {
    client: FreshThreadEventClient;
    turn: CodexTuiTurnAccepted;
    subscription: SharedLocalObserverSubscription;
}): boolean {
    if (!canRouteFreshThreadEvent(params.client, params.turn.threadId, params.subscription)) {
        return false;
    }
    return params.client.adoptThreadTurn(params.turn.threadId, params.turn.turnId);
}

export function routeFreshThreadNotification(params: {
    client: FreshThreadEventClient;
    notification: CodexTuiThreadNotification;
    subscription: SharedLocalObserverSubscription;
}): boolean {
    if (!canRouteFreshThreadEvent(
        params.client,
        params.notification.threadId,
        params.subscription,
    )) {
        return false;
    }
    return params.client.ingestThreadNotification(params.notification);
}
