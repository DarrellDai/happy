import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { runCodex } from '@/codex/runCodex'
import { extractCodexPermissionFlags, extractCodexResumeFlag } from '@/codex/cliArgs'
import { extractNoSandboxFlag } from '@/utils/sandboxFlags'
import { ensureDaemonRunning } from '@/daemon/ensureDaemonRunning'

export async function handleCodexCommand(args: string[]): Promise<void> {
  let startedBy: 'daemon' | 'terminal' | undefined = undefined
  const sandboxArgs = extractNoSandboxFlag(args)
  const codexArgs = extractCodexResumeFlag(sandboxArgs.args)
  const permissionArgs = extractCodexPermissionFlags(codexArgs.args)

  for (let i = 0; i < permissionArgs.args.length; i++) {
    if (permissionArgs.args[i] === '--started-by') {
      startedBy = permissionArgs.args[++i] as 'daemon' | 'terminal'
    }
  }

  const { credentials } = await authAndSetupMachineIfNeeded()
  await ensureDaemonRunning()

  await runCodex({
    credentials,
    startedBy,
    noSandbox: sandboxArgs.noSandbox,
    resumeThreadId: codexArgs.resumeThreadId ?? undefined,
    startingMode: codexArgs.startingMode,
    permissionMode: permissionArgs.permissionMode,
  })
}
