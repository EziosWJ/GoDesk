import { spawn } from 'node:child_process'

const frontendDir = process.argv[2]
const services = [
  { name: 'Vite', command: 'pnpm', args: ['--dir', frontendDir, 'run', 'dev'] },
  {
    name: 'goDesk',
    command: 'go',
    args: ['-C', 'backend', 'run', './cmd/godesk', '-data-dir', '../data'],
  },
]

const children = []
let stopping = false

function stop(exitCode) {
  if (stopping) return
  stopping = true
  process.exitCode = exitCode

  // Each service runs in a process group so its launcher and server stop together.
  for (const child of children) {
    if (!child.pid) continue
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch (error) {
      if (error.code !== 'ESRCH') console.error(error.message)
    }
  }
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

for (const { name, command, args } of services) {
  const child = spawn(command, args, { detached: true, stdio: 'inherit' })
  children.push(child)
  child.once('error', error => {
    console.error(`${name} failed to start: ${error.message}`)
    stop(1)
  })
  child.once('exit', (code, signal) => {
    if (stopping) return
    console.error(`${name} exited (${signal ?? code})`)
    stop(code || 1)
  })
}
