import { open, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

type CodexSessionCandidate = {
    id: string;
    cwd: string;
    timestamp: Date;
    rolloutTimestamp: Date;
    originator: string | null;
    source: unknown;
    parentThreadId: unknown;
    path: string;
};

export type ActiveCodexThread = {
    threadId: string;
    rolloutPath: string;
    rolloutTimestamp: Date;
};

const FIRST_LINE_CHUNK_BYTES = 16 * 1024;
const MAX_SESSION_META_BYTES = 2 * 1024 * 1024;
const sessionMetaCache = new Map<string, CodexSessionCandidate>();

function isInteractiveThreadSource(source: unknown): boolean {
    return source === 'cli' || source === 'vscode';
}

async function listJsonlFiles(dir: string): Promise<string[]> {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }

    const nested = await Promise.all(entries.map(async (entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            return listJsonlFiles(path);
        }
        return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : [];
    }));

    return nested.flat();
}

function codexSessionDateDir(codexHomeDir: string, date: Date): string {
    const isoDate = date.toISOString().slice(0, 10);
    const [year, month, day] = isoDate.split('-');
    return join(codexHomeDir, 'sessions', year, month, day);
}

function launchWindowSessionDirs(codexHomeDir: string, startedAt: Date, finishedAt: Date): string[] {
    return Array.from(new Set([
        codexSessionDateDir(codexHomeDir, startedAt),
        codexSessionDateDir(codexHomeDir, finishedAt),
    ]));
}

async function readCodexSessionMeta(path: string): Promise<CodexSessionCandidate | null> {
    const cached = sessionMetaCache.get(path);
    if (cached) {
        return cached;
    }
    let firstLine: string | null = null;
    let fileHandle;
    try {
        fileHandle = await open(path, 'r');
        const chunks: Buffer[] = [];
        let position = 0;

        while (position < MAX_SESSION_META_BYTES) {
            const buffer = Buffer.alloc(Math.min(FIRST_LINE_CHUNK_BYTES, MAX_SESSION_META_BYTES - position));
            const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, position);
            if (bytesRead === 0) {
                firstLine = Buffer.concat(chunks).toString('utf8');
                break;
            }

            const chunk = buffer.subarray(0, bytesRead);
            const newlineIndex = chunk.indexOf(0x0a);
            chunks.push(newlineIndex >= 0 ? chunk.subarray(0, newlineIndex) : chunk);
            position += bytesRead;

            if (newlineIndex >= 0) {
                firstLine = Buffer.concat(chunks).toString('utf8').replace(/\r$/, '');
                break;
            }
        }
    } catch {
        return null;
    } finally {
        await fileHandle?.close();
    }

    if (!firstLine) {
        return null;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(firstLine);
    } catch {
        return null;
    }

    const record = parsed as {
        timestamp?: unknown;
        type?: unknown;
        payload?: {
            id?: unknown;
            cwd?: unknown;
            timestamp?: unknown;
            originator?: unknown;
            source?: unknown;
            parent_thread_id?: unknown;
        };
    };
    if (record.type !== 'session_meta') {
        return null;
    }
    if (
        typeof record.payload?.id !== 'string' ||
        typeof record.payload.cwd !== 'string' ||
        typeof record.payload.timestamp !== 'string'
    ) {
        return null;
    }

    const timestamp = new Date(record.payload.timestamp);
    if (Number.isNaN(timestamp.getTime())) {
        return null;
    }

    const parsedRolloutTimestamp = typeof record.timestamp === 'string'
        ? new Date(record.timestamp)
        : timestamp;
    const rolloutTimestamp = Number.isNaN(parsedRolloutTimestamp.getTime())
        ? timestamp
        : parsedRolloutTimestamp;

    const candidate = {
        id: record.payload.id,
        cwd: record.payload.cwd,
        timestamp,
        rolloutTimestamp,
        originator: typeof record.payload.originator === 'string' ? record.payload.originator : null,
        source: record.payload.source,
        parentThreadId: record.payload.parent_thread_id,
        path,
    };
    sessionMetaCache.set(path, candidate);
    return candidate;
}

async function canonicalizeCwd(path: string): Promise<string> {
    let canonicalPath: string;
    try {
        canonicalPath = await realpath(path);
    } catch {
        canonicalPath = resolve(path);
    }
    return process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
}

export async function discoverCodexThreadId(opts: {
    codexHomeDir: string;
    cwd: string;
    startedAt: Date;
    finishedAt: Date;
    originator: string;
}): Promise<string> {
    const files = (await Promise.all(
        launchWindowSessionDirs(opts.codexHomeDir, opts.startedAt, opts.finishedAt)
            .map((dir) => listJsonlFiles(dir)),
    )).flat();
    const candidates: CodexSessionCandidate[] = [];
    const expectedCwd = await canonicalizeCwd(opts.cwd);

    for (const file of files) {
        const candidate = await readCodexSessionMeta(file);
        if (
            candidate &&
            await canonicalizeCwd(candidate.cwd) === expectedCwd &&
            candidate.rolloutTimestamp >= opts.startedAt &&
            candidate.rolloutTimestamp <= opts.finishedAt &&
            candidate.originator === opts.originator &&
            candidate.source === 'cli'
        ) {
            candidates.push(candidate);
        }
    }

    if (candidates.length === 0) {
        throw new Error(`Could not discover Codex thread id for cwd ${opts.cwd} in launch window.`);
    }
    candidates.sort((left, right) => {
        const timestampDifference = left.rolloutTimestamp.getTime() - right.rolloutTimestamp.getTime();
        return timestampDifference !== 0 ? timestampDifference : left.path.localeCompare(right.path);
    });
    return candidates.at(-1)!.id;
}

export async function findCodexRolloutPathByThreadId(
    codexHomeDir: string,
    threadId: string,
): Promise<string | null> {
    const files = await listJsonlFiles(join(codexHomeDir, 'sessions'));
    const likelyMatches = files
        .filter((path) => path.includes(threadId))
        .sort()
        .reverse();

    for (const path of likelyMatches) {
        const candidate = await readCodexSessionMeta(path);
        if (candidate?.id === threadId) {
            return candidate.path;
        }
    }

    // Fall back to metadata inspection for installations whose rollout file
    // naming scheme does not include the thread id.
    for (const path of files.sort().reverse()) {
        if (likelyMatches.includes(path)) {
            continue;
        }
        const candidate = await readCodexSessionMeta(path);
        if (candidate?.id === threadId) {
            return candidate.path;
        }
    }

    return null;
}

/**
 * Find the newest user-facing Codex rollout created by this native TUI
 * process. A TUI can change threads in-place with /new, /resume, or /fork;
 * the per-launch originator distinguishes those rollouts from other Codex
 * processes while source=cli excludes subagents.
 */
export async function findActiveCodexThread(opts: {
    codexHomeDir: string;
    startedAt: Date;
    finishedAt: Date;
    originator: string;
    activeRolloutPaths?: string[];
}): Promise<ActiveCodexThread | null> {
    if (opts.activeRolloutPaths?.length) {
        const openCandidates = (await Promise.all(
            opts.activeRolloutPaths.map((path) => readCodexSessionMeta(path)),
        )).filter((candidate): candidate is CodexSessionCandidate => (
            candidate !== null && isInteractiveThreadSource(candidate.source)
        ));
        const activeOpenRollout = openCandidates.at(-1);
        if (activeOpenRollout) {
            return {
                threadId: activeOpenRollout.id,
                rolloutPath: activeOpenRollout.path,
                rolloutTimestamp: activeOpenRollout.rolloutTimestamp,
            };
        }
    }

    const files = (await Promise.all(
        launchWindowSessionDirs(opts.codexHomeDir, opts.startedAt, opts.finishedAt)
            .map((dir) => listJsonlFiles(dir)),
    )).flat();
    const candidates: CodexSessionCandidate[] = [];

    for (const file of files) {
        const candidate = await readCodexSessionMeta(file);
        if (
            candidate &&
            candidate.rolloutTimestamp >= opts.startedAt &&
            candidate.rolloutTimestamp <= opts.finishedAt &&
            candidate.originator === opts.originator &&
            candidate.source === 'cli'
        ) {
            candidates.push(candidate);
        }
    }

    candidates.sort((left, right) => {
        const timestampDifference = left.rolloutTimestamp.getTime() - right.rolloutTimestamp.getTime();
        return timestampDifference !== 0 ? timestampDifference : left.path.localeCompare(right.path);
    });
    const active = candidates.at(-1);
    return active
        ? {
            threadId: active.id,
            rolloutPath: active.path,
            rolloutTimestamp: active.rolloutTimestamp,
        }
        : null;
}
