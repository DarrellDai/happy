import axios from 'axios'
import { logger } from '@/ui/logger'
import { Expo, ExpoPushMessage } from 'expo-server-sdk'
import type { Metadata } from './types'
import { configuration } from '@/configuration'

export interface PushToken {
    id: string
    token: string
    createdAt: number
    updatedAt: number
}

export type SessionNotificationKind = 'done' | 'permission' | 'question'

function getSessionTitle(metadata: Metadata | null | undefined): string {
    const summaryText = metadata?.summary?.text?.trim()
    if (summaryText) {
        return summaryText
    }

    const path = metadata?.path?.trim()
    if (!path) {
        return 'Session'
    }

    const segments = path.split(/[\\/]/).filter(Boolean)
    return segments[segments.length - 1] || 'Session'
}

function getSessionNotificationUrl(data: Record<string, any> | undefined): `/session/${string}` | null {
    const sessionId = data?.sessionId
    if (typeof sessionId !== 'string') {
        return null
    }

    const trimmedSessionId = sessionId.trim()
    if (!trimmedSessionId) {
        return null
    }

    return `/session/${encodeURIComponent(trimmedSessionId)}`
}

export function getSessionNotificationTitle(
    kind: SessionNotificationKind
): string {
    switch (kind) {
        case 'done':
            return "It's ready!"
        case 'permission':
            return 'Permission request'
        case 'question':
            return 'Clarification needed'
    }
}

export function getSessionNotificationBody(
    metadata: Metadata | null | undefined
): string {
    return getSessionTitle(metadata)
}

export function getSessionNotificationCopy(
    kind: SessionNotificationKind,
    metadata: Metadata | null | undefined
): { title: string; body: string } {
    return {
        title: getSessionNotificationTitle(kind),
        body: getSessionNotificationBody(metadata),
    }
}

// Per-kind minimum gap between successive pushes for the same session.
// Completion pushes intentionally have no cooldown so every finished turn can
// notify. Permission and question prompts retain flood protection.
const PUSH_DEBOUNCE_MS: Readonly<Record<string, number>> = {
    permission: 2 * 60 * 1000, // 2 minutes
    question: 2 * 60 * 1000,   // 2 minutes
}

export class PushNotificationClient {
    private readonly token: string
    private readonly baseUrl: string
    private readonly expo: Expo
    /** `${kind}:${sessionId}` → timestamp of the last push we actually sent */
    private readonly lastPushTime = new Map<string, number>()

    constructor(token: string, baseUrl: string = 'https://api.cluster-fluster.com') {
        this.token = token
        this.baseUrl = baseUrl
        this.expo = new Expo()
    }

    /**
     * Returns true if a push of this kind for this session should be suppressed
     * because one was already sent within the debounce window.
     * Records the send time when it returns false.
     * Kinds not listed in PUSH_DEBOUNCE_MS are never suppressed.
     */
    private shouldSuppressPush(sessionId: string, kind: string): boolean {
        const debounce = PUSH_DEBOUNCE_MS[kind]
        if (debounce === undefined) return false
        const key = `${kind}:${sessionId}`
        const last = this.lastPushTime.get(key)
        const now = Date.now()
        if (last !== undefined && now - last < debounce) {
            logger.debug(`[PUSH] Suppressing "${kind}" push for session ${sessionId} (last sent ${Math.round((now - last) / 1000)}s ago)`)
            return true
        }
        this.lastPushTime.set(key, now)
        return false
    }

    /**
     * Fetch all push tokens for the authenticated user.
     * Retries up to 3 times with exponential backoff on transient errors.
     */
    async fetchPushTokens(): Promise<PushToken[]> {
        const maxAttempts = 3
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const response = await axios.get<{ tokens: PushToken[] }>(
                    `${this.baseUrl}/v1/push-tokens`,
                    {
                        headers: {
                            'Authorization': `Bearer ${this.token}`,
                            'Content-Type': 'application/json',
                            'X-Happy-Client': `cli-daemon/${configuration.currentCliVersion}`
                        }
                    }
                )

                logger.debug(`Fetched ${response.data.tokens.length} push tokens`)

                // Log token information
                response.data.tokens.forEach((token, index) => {
                    logger.debug(`[PUSH] Token ${index + 1}: id=${token.id}, created=${new Date(token.createdAt).toISOString()}, updated=${new Date(token.updatedAt).toISOString()}`)
                })

                return response.data.tokens
            } catch (error) {
                logger.debug(`[PUSH] [ERROR] Failed to fetch push tokens (attempt ${attempt}/${maxAttempts}):`, error)
                if (attempt < maxAttempts) {
                    const delay = 1000 * Math.pow(2, attempt - 1) // 1s, 2s
                    await new Promise(resolve => setTimeout(resolve, delay))
                }
            }
        }
        logger.debug('[PUSH] [ERROR] All push token fetch attempts failed')
        return []
    }

    /**
     * Send push notification via Expo Push API with retry
     * @param messages - Array of push messages to send
     */
    async sendPushNotifications(messages: ExpoPushMessage[]): Promise<void> {
        logger.debug(`Sending ${messages.length} push notifications`)

        // Filter out invalid push tokens
        const validMessages = messages.filter(message => {
            if (Array.isArray(message.to)) {
                return message.to.every(token => Expo.isExpoPushToken(token))
            }
            return Expo.isExpoPushToken(message.to)
        })

        if (validMessages.length === 0) {
            logger.debug('No valid Expo push tokens found')
            return
        }

        // Send each token in its own request. Expo rejects entire batches when
        // tokens from different Expo projects are mixed — e.g. a fork-build token
        // (darrelldai project) + a Play Store token (bulkacorp project) in the same
        // request silently kills ALL delivery. One request per token is slightly less
        // efficient (2 HTTP calls instead of 1 for 2 tokens) but completely immune.
        const chunks = validMessages.map(m => [m])

        for (const chunk of chunks) {
            // Retry with exponential backoff for 5 minutes
            const startTime = Date.now()
            const timeout = 300000 // 5 minutes
            let attempt = 0
            
            while (true) {
                try {
                    const ticketChunk = await this.expo.sendPushNotificationsAsync(chunk)
                    
                    // Log any errors but don't throw
                    const errors = ticketChunk.filter(ticket => ticket.status === 'error')
                    if (errors.length > 0) {
                        const errorDetails = errors.map(e => ({ message: e.message, details: e.details }))
                        logger.debug('[PUSH] Some notifications failed:', errorDetails)
                    }
                    
                    // If all notifications failed, throw to trigger retry
                    if (errors.length === ticketChunk.length) {
                        throw new Error('All push notifications in chunk failed')
                    }
                    
                    // Success - break out of retry loop
                    break
                } catch (error) {
                    const elapsed = Date.now() - startTime
                    if (elapsed >= timeout) {
                        logger.debug('[PUSH] Timeout reached after 5 minutes, giving up on chunk')
                        break
                    }
                    
                    // Calculate exponential backoff delay
                    attempt++
                    const delay = Math.min(1000 * Math.pow(2, attempt), 30000) // Max 30 seconds between retries
                    const remainingTime = timeout - elapsed
                    const waitTime = Math.min(delay, remainingTime)
                    
                    if (waitTime > 0) {
                        logger.debug(`[PUSH] Retrying in ${waitTime}ms (attempt ${attempt})`)
                        await new Promise(resolve => setTimeout(resolve, waitTime))
                    }
                }
            }
        }

        logger.debug(`Push notifications sent successfully`)
    }

    /**
     * Send a push notification to all registered devices for the user
     * @param title - Notification title
     * @param body - Notification body
     * @param data - Additional data to send with the notification
     */
    sendToAllDevices(title: string, body?: string, data?: Record<string, any>): void {
        logger.debug(`[PUSH] sendToAllDevices called with title: "${title}", body: "${body ?? ''}"`);

        const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : null
        if (sessionId && typeof data?.kind === 'string' && this.shouldSuppressPush(sessionId, data.kind)) {
            return
        }

        // Execute async operations without awaiting
        (async () => {
            try {
                // Fetch all push tokens
                logger.debug('[PUSH] Fetching push tokens...')
                const tokens = await this.fetchPushTokens()
                logger.debug(`[PUSH] Fetched ${tokens.length} push tokens`)
                
                // Log token details for debugging
                tokens.forEach((token, index) => {
                    logger.debug(`[PUSH] Using token ${index + 1}: id=${token.id}`)
                })

                if (tokens.length === 0) {
                    logger.debug('No push tokens found for user')
                    return
                }

                // Create messages for all tokens
                const messages: ExpoPushMessage[] = tokens.map((token, index) => {
                    logger.debug(`[PUSH] Creating message ${index + 1} for token`)
                    return {
                        to: token.token,
                        title,
                        body: body && body.length > 0 ? body : undefined,
                        data,
                        // TODO: For brutalist session artwork, attach rich media via a public HTTPS image URL.
                        // Bundled app asset paths / require(...) / local file paths will not work in push payloads.
                        // iOS also needs a Notification Service Extension to render richContent.image reliably.
                        sound: 'default',
                        priority: 'high',
                        channelId: 'messages',
                    }
                })

                // Send notifications
                logger.debug(`[PUSH] Sending ${messages.length} push notifications...`)
                await this.sendPushNotifications(messages)
                logger.debug('[PUSH] Push notifications sent successfully')
            } catch (error) {
                logger.debug('[PUSH] Error sending to all devices:', error)
            }
        })()
    }

    /**
     * Routes session-event pushes through the server so it can apply
     * presence-based suppression (active desktop/web, mobile foreground).
     * Falls back to direct Expo send only when sessionId is missing — that
     * shouldn't happen for session notifications but guards against regressions.
     */
    sendSessionNotification(params: {
        kind: SessionNotificationKind
        metadata: Metadata | null | undefined
        data?: Record<string, any>
    }): void {
        const { title, body } = getSessionNotificationCopy(params.kind, params.metadata)
        const sessionTitle = getSessionNotificationBody(params.metadata)
        const url = getSessionNotificationUrl(params.data)
        const payloadData = {
            ...params.data,
            kind: params.kind,
            sessionTitle,
            ...(url ? { url } : {}),
        }

        const sessionId = typeof params.data?.sessionId === 'string' ? params.data.sessionId : null
        if (!sessionId) {
            logger.debug('[PUSH] sendSessionNotification: missing sessionId, falling back to direct send')
            this.sendToAllDevices(title, body, payloadData)
            return
        }

        if (this.shouldSuppressPush(sessionId, params.kind)) {
            return
        }

        void (async () => {
            try {
                await axios.post(
                    `${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/push-event`,
                    {
                        kind: params.kind,
                        title,
                        body,
                        data: payloadData,
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${this.token}`,
                            'Content-Type': 'application/json',
                            'X-Happy-Client': `cli-daemon/${configuration.currentCliVersion}`,
                        },
                        timeout: 15000,
                    }
                )
                logger.debug(`[PUSH] sendSessionNotification dispatched via server (kind=${params.kind})`)
            } catch (error) {
                logger.debug('[PUSH] sendSessionNotification failed:', error)
            }
        })()
    }
}
