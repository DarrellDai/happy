/**
 * Sends push notifications via Expo's HTTP Push API.
 * Direct HTTP POST — no expo-server-sdk dependency needed.
 * Sends each token in its own request so tokens from different Expo projects
 * cannot make the provider reject the whole delivery batch.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export interface PushMessage {
    to: string;
    title?: string;
    body?: string;
    data?: Record<string, unknown>;
    sound?: 'default' | null;
    badge?: number;
    channelId?: string;
}

export interface PushTicket {
    status: 'ok' | 'error';
    id?: string;
    message?: string;
    details?: { error?: string };
}

function normalizeSingleTicket(data: unknown): PushTicket | null {
    const providerTickets = Array.isArray(data) ? data : data ? [data] : [];
    if (providerTickets.length !== 1) {
        return null;
    }

    const ticket = providerTickets[0];
    if (!ticket || typeof ticket !== 'object') {
        return null;
    }

    const status = (ticket as { status?: unknown }).status;
    return status === 'ok' || status === 'error'
        ? ticket as PushTicket
        : null;
}

export async function sendPushNotifications(messages: PushMessage[]): Promise<PushTicket[]> {
    if (messages.length === 0) {
        return [];
    }

    const tickets: PushTicket[] = [];

    for (const message of messages) {
        const payload = [message];
        try {
            const response = await fetch(EXPO_PUSH_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                tickets.push({
                    status: 'error' as const,
                    message: `HTTP ${response.status}`
                });
                continue;
            }

            const result = await response.json() as { data?: unknown };
            tickets.push(normalizeSingleTicket(result.data) ?? {
                status: 'error',
                message: 'Invalid response from Expo push service'
            });
        } catch {
            tickets.push({
                status: 'error' as const,
                message: 'Network error'
            });
        }
    }

    return tickets;
}
