import { execFileSync } from 'node:child_process';

export function readPosixProcessTable(): string {
    return execFileSync(
        'ps',
        ['-A', '-o', 'pid=', '-o', 'ppid='],
        { encoding: 'utf8', windowsHide: true },
    );
}

export function collectDescendantPids(rootPid: number, processTable: string): number[] {
    const childrenByParent = new Map<number, number[]>();
    for (const line of processTable.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (!match) continue;
        const pid = Number(match[1]);
        const parentPid = Number(match[2]);
        const children = childrenByParent.get(parentPid) ?? [];
        children.push(pid);
        childrenByParent.set(parentPid, children);
    }

    const descendants: number[] = [];
    const visited = new Set<number>();
    const visit = (parentPid: number): void => {
        for (const childPid of childrenByParent.get(parentPid) ?? []) {
            if (visited.has(childPid)) continue;
            visited.add(childPid);
            visit(childPid);
            descendants.push(childPid);
        }
    };
    visit(rootPid);
    return descendants;
}

/** Signal descendants deepest-first while their parent relationship exists. */
export function signalPosixProcessDescendants(
    rootPid: number,
    signal: NodeJS.Signals,
    deps?: {
        readProcessTable?: () => string;
        kill?: (pid: number, signal: NodeJS.Signals) => void;
    },
): number[] {
    let processTable: string;
    try {
        processTable = deps?.readProcessTable?.() ?? readPosixProcessTable();
    } catch {
        return [];
    }

    const descendants = collectDescendantPids(rootPid, processTable);
    const kill = deps?.kill ?? ((pid: number, requestedSignal: NodeJS.Signals) => {
        process.kill(pid, requestedSignal);
    });
    for (const pid of descendants) {
        try {
            kill(pid, signal);
        } catch {
            // The process may have exited between the snapshot and signal.
        }
    }
    return descendants;
}

export function signalProcessIds(
    pids: Iterable<number>,
    signal: NodeJS.Signals,
    kill: (pid: number, signal: NodeJS.Signals) => void = process.kill,
): void {
    for (const pid of pids) {
        try {
            kill(pid, signal);
        } catch {
            // Already exited.
        }
    }
}

export async function waitForProcessIdsToExit(
    pids: Iterable<number>,
    timeoutMs: number,
    deps?: {
        isAlive?: (pid: number) => boolean;
        pollMs?: number;
    },
): Promise<number[]> {
    const isAlive = deps?.isAlive ?? ((pid: number): boolean => {
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            return (error as NodeJS.ErrnoException).code !== 'ESRCH';
        }
    });
    let remaining = Array.from(new Set(pids));
    const deadline = Date.now() + Math.max(0, timeoutMs);

    while (remaining.length > 0) {
        remaining = remaining.filter((pid) => isAlive(pid));
        if (remaining.length === 0 || Date.now() >= deadline) {
            return remaining;
        }
        await new Promise((resolve) => setTimeout(resolve, deps?.pollMs ?? 25));
    }
    return remaining;
}
