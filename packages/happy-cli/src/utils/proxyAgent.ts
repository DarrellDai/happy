/**
 * Returns a tunneling agent for the given target URL when HAPPY_WS_PROXY is
 * set, honoring NO_PROXY. Supports `http://`, `https://`, `socks5://`,
 * `socks5h://`, and `socks4://` proxy URLs. Returns undefined when no proxy
 * applies.
 *
 * Why HAPPY_WS_PROXY and not HTTPS_PROXY: we only want to tunnel the
 * long-lived WebSocket. Setting HTTPS_PROXY globally would also push axios
 * through the proxy, which can fail under strict Node HTTP parsers when the
 * proxy emits non-conforming headers.
 */

import type { Agent } from 'node:http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

export function getProxyAgentForUrl(targetUrl: string): Agent | undefined {
    const proxyUrl = process.env.HAPPY_WS_PROXY || process.env.happy_ws_proxy;
    if (!proxyUrl) return undefined;

    const noProxy = process.env.NO_PROXY || process.env.no_proxy;
    if (noProxy) {
        let host: string | null = null;
        try {
            host = new URL(targetUrl).hostname;
        } catch {
            host = null;
        }
        if (host) {
            const patterns = noProxy.split(',').map(p => p.trim()).filter(Boolean);
            const bypass = patterns.some(p => {
                if (p === '*') return true;
                if (p === host) return true;
                if (p.startsWith('.') && host!.endsWith(p)) return true;
                if (host!.endsWith('.' + p)) return true;
                return false;
            });
            if (bypass) return undefined;
        }
    }

    if (/^socks/i.test(proxyUrl)) {
        return new SocksProxyAgent(proxyUrl);
    }
    return new HttpsProxyAgent(proxyUrl);
}
