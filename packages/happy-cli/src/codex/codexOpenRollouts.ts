import { execFile } from 'node:child_process';
import { readdir, readlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join, resolve, sep } from 'node:path';

import { collectDescendantPids, readPosixProcessTable } from '@/utils/processTree';

const execFileAsync = promisify(execFile);

function keepRolloutPaths(paths: string[], codexHomeDir: string): string[] {
    const sessionsRoot = `${resolve(codexHomeDir, 'sessions')}${sep}`;
    return Array.from(new Set(paths
        .map((path) => path.replace(/ \(deleted\)$/, ''))
        .filter((path) => path.endsWith('.jsonl') && resolve(path).startsWith(sessionsRoot))));
}

/** Find rollout files currently held open by the Codex wrapper/native tree. */
export async function findOpenCodexRolloutPaths(opts: {
    rootPid: number;
    codexHomeDir: string;
    platform?: NodeJS.Platform;
    readProcessTable?: () => string;
    readDirectory?: (path: string) => Promise<string[]>;
    readLink?: (path: string) => Promise<string>;
    runLsof?: (pids: number[]) => Promise<string>;
}): Promise<string[]> {
    const platform = opts.platform ?? process.platform;
    if (platform === 'win32') {
        return [];
    }

    let processTable: string;
    try {
        processTable = opts.readProcessTable?.() ?? readPosixProcessTable();
    } catch {
        return [];
    }
    const pids = [opts.rootPid, ...collectDescendantPids(opts.rootPid, processTable)];

    if (platform === 'linux') {
        const readDirectory = opts.readDirectory ?? (async (path: string) => readdir(path));
        const readLink = opts.readLink ?? readlink;
        const paths: string[] = [];
        await Promise.all(pids.map(async (pid) => {
            const fdDir = `/proc/${pid}/fd`;
            let entries: string[];
            try {
                entries = await readDirectory(fdDir);
            } catch {
                return;
            }
            await Promise.all(entries.map(async (entry) => {
                try {
                    paths.push(await readLink(join(fdDir, entry)));
                } catch {
                    // File descriptors can close while they are inspected.
                }
            }));
        }));
        return keepRolloutPaths(paths, opts.codexHomeDir);
    }

    if (platform === 'darwin') {
        try {
            const output = opts.runLsof
                ? await opts.runLsof(pids)
                : (await execFileAsync(
                    'lsof',
                    ['-a', '-p', pids.join(','), '-Fn'],
                    { encoding: 'utf8', windowsHide: true },
                )).stdout;
            return keepRolloutPaths(
                output.split('\n').filter((line) => line.startsWith('n')).map((line) => line.slice(1)),
                opts.codexHomeDir,
            );
        } catch {
            return [];
        }
    }

    return [];
}
