import { open, stat } from 'node:fs/promises';

const READ_CHUNK_BYTES = 64 * 1024;

async function waitForPoll(signal: AbortSignal, pollMs: number): Promise<void> {
    if (signal.aborted) {
        return;
    }

    await new Promise<void>((resolve) => {
        const timer = setTimeout(done, pollMs);
        const onAbort = (): void => done();
        signal.addEventListener('abort', onAbort, { once: true });

        function done(): void {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            resolve();
        }
    });
}

export async function getCodexRolloutSize(path: string): Promise<number> {
    try {
        return (await stat(path)).size;
    } catch {
        return 0;
    }
}

/**
 * Tails event_msg records from a Codex rollout. The final available bytes are
 * drained once after abort so a handoff does not lose the native TUI's last
 * completion/abort event.
 */
export async function tailCodexRollout(opts: {
    path: string;
    startOffset?: number;
    signal: AbortSignal;
    pollMs?: number;
    onEvent: (event: Record<string, unknown>) => void;
}): Promise<void> {
    let offset = Math.max(0, opts.startOffset ?? 0);
    let pendingParts: Buffer[] = [];

    const processLine = (lineBuffer: Buffer): void => {
        const line = lineBuffer.toString('utf8').replace(/\r$/, '');
        if (!line) {
            return;
        }

        let record: { type?: unknown; payload?: unknown };
        try {
            record = JSON.parse(line) as { type?: unknown; payload?: unknown };
        } catch {
            // Complete records are newline-delimited, so one malformed line
            // cannot poison subsequent rollout events.
            return;
        }
        if (
            record.type === 'event_msg' &&
            record.payload &&
            typeof record.payload === 'object' &&
            !Array.isArray(record.payload)
        ) {
            opts.onEvent(record.payload as Record<string, unknown>);
        }
    };

    const readAvailable = async (): Promise<void> => {
        let fileSize: number;
        try {
            fileSize = (await stat(opts.path)).size;
        } catch {
            return;
        }

        if (fileSize < offset) {
            offset = 0;
            pendingParts = [];
        }
        if (fileSize === offset) {
            return;
        }

        const file = await open(opts.path, 'r');
        try {
            while (offset < fileSize) {
                const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, fileSize - offset));
                const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
                if (bytesRead === 0) {
                    break;
                }
                offset += bytesRead;
                const chunk = buffer.subarray(0, bytesRead);
                let chunkOffset = 0;
                let newlineIndex = chunk.indexOf(0x0a, chunkOffset);
                while (newlineIndex >= 0) {
                    pendingParts.push(chunk.subarray(chunkOffset, newlineIndex));
                    processLine(Buffer.concat(pendingParts));
                    pendingParts = [];
                    chunkOffset = newlineIndex + 1;
                    newlineIndex = chunk.indexOf(0x0a, chunkOffset);
                }
                if (chunkOffset < chunk.length) {
                    pendingParts.push(chunk.subarray(chunkOffset));
                }
            }
        } finally {
            await file.close();
        }
    };

    while (!opts.signal.aborted) {
        await readAvailable();
        await waitForPoll(opts.signal, opts.pollMs ?? 100);
    }
    await readAvailable();
    if (pendingParts.length > 0) {
        processLine(Buffer.concat(pendingParts));
        pendingParts = [];
    }
}
