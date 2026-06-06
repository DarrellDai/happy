import 'react-native-quick-base64';
import '../theme.css';
import * as React from 'react';
import * as SplashScreen from 'expo-splash-screen';
import * as Fonts from 'expo-font';
import * as Notifications from 'expo-notifications';
import { FontAwesome } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { AuthCredentials, TokenStorage } from '@/auth/tokenStorage';
import { AuthProvider } from '@/auth/AuthContext';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { initialWindowMetrics, SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SidebarNavigator } from '@/components/SidebarNavigator';
import sodium from '@/encryption/libsodium.lib';
import { View, Platform, AppState } from 'react-native';
import { ModalProvider } from '@/modal';
import { PostHogProvider } from 'posthog-react-native';
import { tracking } from '@/track/tracking';
import { syncRestore } from '@/sync/sync';
import { useTrackScreens } from '@/track/useTrackScreens';
import { RealtimeProvider } from '@/realtime/RealtimeProvider';
import { FaviconPermissionIndicator } from '@/components/web/FaviconPermissionIndicator';
import { CommandPaletteProvider } from '@/components/CommandPalette/CommandPaletteProvider';
import { StatusBarProvider } from '@/components/StatusBarProvider';
// import * as SystemUI from 'expo-system-ui';
import { initConsoleLogging, setConsoleOutputEnabled } from '@/utils/consoleLogging';
import { useLocalSetting } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';
import { AsyncLock } from '@/utils/lock';
import { getSessionRouteFromNotificationResponse } from '@/utils/notificationRouting';
import { navigateToSession } from '@/hooks/useNavigateToSession';
import { applyVoiceUpsellOverride } from '@/realtime/voiceExperiment';
import { useTauriZoom } from '@/hooks/useTauriZoom';
import { useTauriDrag } from '@/hooks/useTauriDrag';

// Configure notification handler — always surface incoming pushes as
// banners/alerts (with sound), even when the app is foregrounded. The CLI-driven
// workflow needs the banner regardless, and the user explicitly wants sound to
// play even when inside the app so they don't miss it.
//
// Before surfacing a new notification, dismiss any existing notification from
// the same session so each session holds at most 1 slot in the tray. Without
// this, every Claude turn-done push from every active session accumulates and
// the Android 50-notification-per-app hard cap is hit within hours.
// Note: this only runs while the app is in the foreground; background/killed
// notifications are posted directly by the OS and can't be intercepted here.
Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
        try {
            const incoming = notification.request.content.data;
            const sessionId = typeof incoming?.sessionId === 'string' ? incoming.sessionId : null;
            if (sessionId) {
                const presented = await Notifications.getPresentedNotificationsAsync();
                for (const n of presented) {
                    if (n.request.content.data?.sessionId === sessionId) {
                        void Notifications.dismissNotificationAsync(n.request.identifier).catch(() => {});
                    }
                }
            }
        } catch {
            // never block a notification due to a dismissal error
        }
        return {
            shouldShowAlert: true,
            shouldPlaySound: true,
            shouldSetBadge: true,
            shouldShowBanner: true,
            shouldShowList: true,
        };
    },
});

// Setup Android notification channels (required for Android 8.0+)
if (Platform.OS === 'android') {
    Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF231F7C',
        sound: 'default',
    });
    // Session-event channel — server sends pushes with channelId='messages'.
    // Display name is "AI" so it appears as its own category in OS notification
    // settings; the user can pick a distinctive ringtone there.
    Notifications.setNotificationChannelAsync('messages', {
        name: 'AI',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF231F7C',
        sound: 'default',
    });
}

export {
    // Catch any errors thrown by the Layout component.
    ErrorBoundary,
} from 'expo-router';

// Configure splash screen
SplashScreen.setOptions({
    fade: true,
    duration: 300,
})
SplashScreen.preventAutoHideAsync();

// Set window background color - now handled by Unistyles
// SystemUI.setBackgroundColorAsync('white');

// Remote logging to local log server (configured via Dev > Log Server setting)
initConsoleLogging()

// Component to apply horizontal safe area padding
function HorizontalSafeAreaWrapper({ children }: { children: React.ReactNode }) {
    const insets = useSafeAreaInsets();
    return (
        <View style={{
            flex: 1,
            paddingLeft: insets.left,
            paddingRight: insets.right
        }}>
            {children}
        </View>
    );
}

let lock = new AsyncLock();
let loaded = false;

function stringifyNotificationPayload(value: unknown): string {
    try {
        const serialized = JSON.stringify(value, null, 2);
        return serialized ?? String(value);
    } catch (error) {
        return `[unserializable notification payload: ${error instanceof Error ? error.message : 'Unknown error'}]`;
    }
}

async function loadFonts() {
    await lock.inLock(async () => {
        if (loaded) {
            return;
        }
        loaded = true;
        // Check if running in Tauri
        const isTauri = Platform.OS === 'web' &&
            typeof window !== 'undefined' &&
            (window as any).__TAURI_INTERNALS__ !== undefined;

        if (!isTauri) {
            // Normal font loading for non-Tauri environments (native and regular web)
            await Fonts.loadAsync({
                // Keep existing font
                SpaceMono: require('@/assets/fonts/SpaceMono-Regular.ttf'),

                // IBM Plex Sans family
                'IBMPlexSans-Regular': require('@/assets/fonts/IBMPlexSans-Regular.ttf'),
                'IBMPlexSans-Italic': require('@/assets/fonts/IBMPlexSans-Italic.ttf'),
                'IBMPlexSans-SemiBold': require('@/assets/fonts/IBMPlexSans-SemiBold.ttf'),

                // IBM Plex Mono family  
                'IBMPlexMono-Regular': require('@/assets/fonts/IBMPlexMono-Regular.ttf'),
                'IBMPlexMono-Italic': require('@/assets/fonts/IBMPlexMono-Italic.ttf'),
                'IBMPlexMono-SemiBold': require('@/assets/fonts/IBMPlexMono-SemiBold.ttf'),

                // Bricolage Grotesque  
                'BricolageGrotesque-Bold': require('@/assets/fonts/BricolageGrotesque-Bold.ttf'),

                ...FontAwesome.font,
            });
        } else {
            // For Tauri, skip Font Face Observer as fonts are loaded via CSS
            console.log('Do not wait for fonts to load');
            (async () => {
                try {
                    await Fonts.loadAsync({
                        // Keep existing font
                        SpaceMono: require('@/assets/fonts/SpaceMono-Regular.ttf'),

                        // IBM Plex Sans family
                        'IBMPlexSans-Regular': require('@/assets/fonts/IBMPlexSans-Regular.ttf'),
                        'IBMPlexSans-Italic': require('@/assets/fonts/IBMPlexSans-Italic.ttf'),
                        'IBMPlexSans-SemiBold': require('@/assets/fonts/IBMPlexSans-SemiBold.ttf'),

                        // IBM Plex Mono family  
                        'IBMPlexMono-Regular': require('@/assets/fonts/IBMPlexMono-Regular.ttf'),
                        'IBMPlexMono-Italic': require('@/assets/fonts/IBMPlexMono-Italic.ttf'),
                        'IBMPlexMono-SemiBold': require('@/assets/fonts/IBMPlexMono-SemiBold.ttf'),

                        // Bricolage Grotesque  
                        'BricolageGrotesque-Bold': require('@/assets/fonts/BricolageGrotesque-Bold.ttf'),

                        ...FontAwesome.font,
                    });
                } catch (e) {
                    // Ignore
                }
            })();
        }
    });
}

function getDevEnvironmentCredentials(): AuthCredentials | null {
    if (!__DEV__) {
        return null;
    }

    const token = process.env.EXPO_PUBLIC_DEV_TOKEN;
    const secret = process.env.EXPO_PUBLIC_DEV_SECRET;
    if (!token || !secret) {
        return null;
    }

    return { token, secret };
}

function getDevWebQueryCredentials(): AuthCredentials | null {
    if (!__DEV__ || Platform.OS !== 'web' || typeof window === 'undefined') {
        return null;
    }

    const params = new URLSearchParams(window.location.search);
    const token = params.get('dev_token');
    const secret = params.get('dev_secret');
    if (!token || !secret) {
        return null;
    }

    return { token, secret };
}

export default function RootLayout() {
    useTauriZoom();
    useTauriDrag();
    const router = useRouter();
    const { theme } = useUnistyles();
    const navigationTheme = React.useMemo(() => {
        if (theme.dark) {
            return {
                ...DarkTheme,
                colors: {
                    ...DarkTheme.colors,
                    background: theme.colors.groupped.background,
                }
            }
        }
        return {
            ...DefaultTheme,
            colors: {
                ...DefaultTheme.colors,
                background: theme.colors.groupped.background,
            }
        };
    }, [theme.dark]);

    //
    // Init sequence
    //
    const [initState, setInitState] = React.useState<{ credentials: AuthCredentials | null } | null>(null);
    React.useEffect(() => {
        (async () => {
            try {
                await loadFonts();
                await sodium.ready;

                let credentials = await TokenStorage.getCredentials();
                const devCredentials = getDevWebQueryCredentials() ?? getDevEnvironmentCredentials();

                if (devCredentials) {
                    const credentialsChanged = credentials?.token !== devCredentials.token
                        || credentials?.secret !== devCredentials.secret;

                    if (credentialsChanged) {
                        const saved = await TokenStorage.setCredentials(devCredentials);
                        if (saved) {
                            credentials = devCredentials;
                        }
                    }

                    if (Platform.OS === 'web' && typeof window !== 'undefined') {
                        window.history.replaceState({}, '', window.location.pathname);
                    }
                }

                if (credentials) {
                    await syncRestore(credentials);
                }

                setInitState({ credentials });
            } catch (error) {
                console.error('Error initializing:', error);
            }
        })();
    }, []);

    React.useEffect(() => {
        if (initState) {
            setTimeout(() => {
                SplashScreen.hideAsync();
            }, 100);
        }
    }, [initState]);

    const handledNotificationIds = React.useRef<Set<string>>(new Set());
    const [pendingSessionId, setPendingSessionId] = React.useState<string | null>(null);

    // Deferred navigation: fires after the render that set pendingSessionId, so
    // the Drawer/Stack navigator has had a chance to fully mount (important on
    // cold start where router.push synchronously after setInitState is dropped
    // by react-navigation before its native layers are committed).
    React.useEffect(() => {
        if (!pendingSessionId || !initState) {
            return;
        }
        console.log(`[PUSH ROUTING] Deferred navigation to session: ${pendingSessionId}`);
        navigateToSession(router, pendingSessionId);
        setPendingSessionId(null);
    }, [pendingSessionId, initState, router]);

    const handleNotificationResponse = React.useCallback(async (response: Notifications.NotificationResponse | null) => {
        if (!response) {
            console.log('[PUSH ROUTING] Notification response is null');
            return;
        }

        console.log('[PUSH ROUTING] Full notification response:\n' + stringifyNotificationPayload(response));

        const responseId = response.notification.request.identifier;
        if (handledNotificationIds.current.has(responseId)) {
            console.log(`[PUSH ROUTING] Duplicate notification response ignored: ${responseId}`);
            return;
        }

        handledNotificationIds.current.add(responseId);

        try {
            if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
                console.log(`[PUSH ROUTING] Ignoring non-default action: ${response.actionIdentifier}`);
                return;
            }

            console.log(
                '[PUSH ROUTING] notification.request.content.data:\n' +
                stringifyNotificationPayload(response.notification.request.content.data)
            );
            const route = getSessionRouteFromNotificationResponse(response);
            console.log(`[PUSH ROUTING] Computed route: ${route ?? 'null'}`);
            if (!route) {
                console.log('[PUSH ROUTING] No session route found in notification.request.content.data');
                return;
            }

            const encodedSessionId = route.replace(/^\/session\//, '');
            const sessionId = (() => {
                try {
                    return decodeURIComponent(encodedSessionId);
                } catch {
                    return encodedSessionId;
                }
            })();
            console.log(`[PUSH ROUTING] Queuing navigation to session: ${sessionId}`);
            setPendingSessionId(sessionId);
        } finally {
            try {
                await Notifications.clearLastNotificationResponseAsync();
            } catch (error) {
                console.log('Failed to clear last notification response:', error);
            }
        }
    }, []);

    React.useEffect(() => {
        if (!initState) {
            return;
        }

        let active = true;
        const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
            void handleNotificationResponse(response);
        });

        void (async () => {
            try {
                const response = await Notifications.getLastNotificationResponseAsync();
                if (active) {
                    await handleNotificationResponse(response);
                }
            } catch (error) {
                console.log('Failed to read last notification response:', error);
            }
        })();

        return () => {
            active = false;
            subscription.remove();
        };
    }, [handleNotificationResponse, initState]);


    // Track the screens
    useTrackScreens()

    // Sync console output toggle from Dev screen
    const consoleLoggingEnabled = useLocalSetting('consoleLoggingEnabled');
    const devModeEnabled = __DEV__ || useLocalSetting('devModeEnabled');
    const voiceUpsellOverride = useLocalSetting('voiceUpsellOverride');
    React.useEffect(() => {
        setConsoleOutputEnabled(consoleLoggingEnabled);
    }, [consoleLoggingEnabled]);

    React.useEffect(() => {
        if (!devModeEnabled || !voiceUpsellOverride) {
            return;
        }
        applyVoiceUpsellOverride(voiceUpsellOverride);
    }, [devModeEnabled, voiceUpsellOverride]);

    //
    // Not inited
    //

    if (!initState) {
        return null;
    }

    //
    // Boot
    //

    let providers = (
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
            <KeyboardProvider preload={false}>
                <GestureHandlerRootView style={{ flex: 1 }}>
                    <AuthProvider initialCredentials={initState.credentials}>
                        <ThemeProvider value={navigationTheme}>
                            <StatusBarProvider />
                            <ModalProvider>
                                <CommandPaletteProvider>
                                    <RealtimeProvider>
                                        <HorizontalSafeAreaWrapper>
                                            <SidebarNavigator />
                                        </HorizontalSafeAreaWrapper>
                                    </RealtimeProvider>
                                </CommandPaletteProvider>
                            </ModalProvider>
                        </ThemeProvider>
                    </AuthProvider>
                </GestureHandlerRootView>
            </KeyboardProvider>
        </SafeAreaProvider>
    );
    if (tracking) {
        providers = (
            <PostHogProvider client={tracking}>
                {providers}
            </PostHogProvider>
        );
    }

    return (
        <>
            <FaviconPermissionIndicator />
            {providers}
        </>
    );
}
