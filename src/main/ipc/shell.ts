// =============================================================================
// Shell / Process Monitor IPC handlers
// Walks process tree to detect agent CLIs (Claude, Aider, Codex, Gemini, etc.)
// =============================================================================

import { execFile } from 'child_process'
import { ipcMain } from 'electron'
import log from '../logger'
import {
  SHELL_REGISTER_TERMINAL,
  SHELL_UNREGISTER_TERMINAL,
  SHELL_ACTIVITY_UPDATE,
  SHELL_PORTS_UPDATE,
  SHELL_CWD_UPDATE,
  SHELL_AGENT_SCREEN_STATE,
} from '../../shared/ipc-channels'
import { getTotalPtyBytes, terminalPids } from './terminal'
import { hasPidFirstSeen, recordPidFirstSeen, pruneStalePidAges, STARTUP_GRACE_MS } from './agentPidAge'
import { sendToWindow, windowFromEvent, broadcastToAll } from '../windowRegistry'
import { getShellEnv } from '../shellEnv'
import type { TerminalActivity } from '../../shared/types'

interface TerminalRegistration {
  shellPid: number
  workspaceId: string
  nodeId: string
  ownerWindowId: number
}

interface PreviousState {
  previousAgentName: string | null
  previouslyHadAgent: boolean
}

interface ScanResult {
  terminalActivity: TerminalActivity
  agentName: string | null
  subprocessActive: boolean
  agentPresent: boolean
  previouslyHadAgent: boolean
  isStreaming: boolean
}

/** Bytes/s above which the agent counts as actively streaming. Tuned to
 *  pass model output and the thinking spinner while ignoring cursor blinks. */
const STREAMING_BYTES_PER_INTERVAL = 200

interface BytesSample {
  total: number
  sampledAt: number
}

/** Last sampled cumulative PTY byte count per terminal, used to compute a
 *  per-interval delta in `scanTerminal`. */
const bytesSamples: Map<string, BytesSample> = new Map()

// Concurrency limiter — caps simultaneous execFile calls across all terminals
function createLimit(max: number) {
  let active = 0
  const queue: Array<() => void> = []
  const next = () => { active--; const fn = queue.shift(); if (fn) { active++; fn() } }
  return <T>(fn: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const run = () => fn().then(v => { next(); resolve(v) }, e => { next(); reject(e) })
    if (active < max) { active++; run() } else queue.push(run)
  })
}
const limit = createLimit(4)

// Registered terminals for process monitoring
const registeredTerminals: Map<string, TerminalRegistration> = new Map()

// Track previous state for transition detection
const previousStates: Map<string, PreviousState> = new Map()

// Backoff: terminals that failed last cycle are skipped once
const skipNextScan: Set<string> = new Set()

// Polling interval handle
let pollInterval: ReturnType<typeof setInterval> | null = null

// Busy flag to prevent overlapping poll cycles
let pollBusy = false

/**
 * Get direct child PIDs of a given process.
 * Runs: ps -o pid= -ppid=<pid>
 */
function getChildPids(pid: number): Promise<number[]> {
  if (!pid || pid <= 0) return Promise.resolve([])
  return limit(() => new Promise((resolve) => {
    execFile('pgrep', ['-P', `${pid}`], {
      encoding: 'utf-8',
      timeout: 2000,
    }, (err, stdout) => {
      if (err || !stdout) {
        resolve([])
        return
      }
      resolve(
        stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => parseInt(line, 10))
          .filter((n) => !isNaN(n))
      )
    })
  }))
}

/**
 * Get the process name (command basename) for a given PID.
 * Runs: ps -o comm= -p <pid>
 */
/** Parse BSD `ps -o etime` output (`[[DD-]HH:]MM:SS`) to seconds. Returns
 *  null when the format isn't recognised. */
function parseEtime(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null
  // optional days separated by `-`
  let days = 0
  let rest = s
  const dashIdx = s.indexOf('-')
  if (dashIdx >= 0) {
    const d = parseInt(s.slice(0, dashIdx), 10)
    if (!Number.isFinite(d)) return null
    days = d
    rest = s.slice(dashIdx + 1)
  }
  const parts = rest.split(':').map((p) => parseInt(p, 10))
  if (parts.some((n) => !Number.isFinite(n))) return null
  let h = 0, m = 0, sec = 0
  if (parts.length === 3) [h, m, sec] = parts
  else if (parts.length === 2) [m, sec] = parts
  else return null
  return days * 86_400 + h * 3_600 + m * 60 + sec
}

/** Wall-clock timestamp (ms) the process was started. Reads BSD `etime`
 *  (macOS) and falls through to it on Linux too (Linux ps supports it).
 *  Returns null on Windows or when the lookup fails — the caller should
 *  fall back to `Date.now()`. */
function getProcessStartedAt(pid: number): Promise<number | null> {
  if (!pid || pid <= 0) return Promise.resolve(null)
  if (process.platform === 'win32') return Promise.resolve(null)
  return limit(() => new Promise((resolve) => {
    execFile('ps', ['-o', 'etime=', '-p', `${pid}`], {
      encoding: 'utf-8',
      timeout: 2000,
    }, (err, stdout) => {
      if (err || !stdout) { resolve(null); return }
      const secs = parseEtime(stdout)
      if (secs == null) { resolve(null); return }
      resolve(Date.now() - secs * 1000)
    })
  }))
}

export { parseEtime as __parseEtimeForTests }

function getProcessName(pid: number): Promise<string | null> {
  if (!pid || pid <= 0) return Promise.resolve(null)
  return limit(() => new Promise((resolve) => {
    execFile('ps', ['-o', 'comm=', '-p', `${pid}`], {
      encoding: 'utf-8',
      timeout: 2000,
    }, (err, stdout) => {
      if (err || !stdout) {
        resolve(null)
        return
      }
      const name = stdout.trim()
      if (name.length === 0) {
        resolve(null)
        return
      }
      // ps -o comm= may return full path; extract basename
      const parts = name.split('/')
      resolve(parts[parts.length - 1])
    })
  }))
}

/** Full command line for a PID via `ps -o args=`. Used to identify agents
 *  that ship as `#!/usr/bin/env node` scripts (Gemini CLI, etc.) where
 *  `comm=` returns `node`. */
function getProcessArgs(pid: number): Promise<string | null> {
  if (!pid || pid <= 0) return Promise.resolve(null)
  return limit(() => new Promise((resolve) => {
    execFile('ps', ['-o', 'args=', '-p', `${pid}`], {
      encoding: 'utf-8',
      timeout: 2000,
    }, (err, stdout) => {
      if (err || !stdout) { resolve(null); return }
      const out = stdout.trim()
      resolve(out.length === 0 ? null : out)
    })
  }))
}

/** Interpreter names that frequently host an agent CLI as a script. When
 *  `getProcessName()` returns one of these we fall back to args-based
 *  matching on the script basename. */
const INTERPRETER_NAMES = new Set(['node', 'bun', 'deno', 'python', 'python3'])

/** Extract a likely script basename from a `ps -o args=` line. Skips flags
 *  (`-`/`--`-prefixed tokens) and the interpreter itself. Returns the
 *  basename of the first plausible script-path argument. */
function scriptBasenameFromArgs(args: string): string | null {
  // Split on whitespace; the first token is the interpreter path.
  const tokens = args.split(/\s+/).filter(Boolean)
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.startsWith('-')) continue
    const slash = tok.lastIndexOf('/')
    const base = slash === -1 ? tok : tok.slice(slash + 1)
    if (!base) continue
    return base.toLowerCase()
  }
  return null
}

/**
 * Agent CLI definitions. Each entry maps process name patterns to a display name.
 * The matcher checks if the process basename (lowercased) matches any pattern.
 */
const AGENT_DEFINITIONS: { displayName: string; match: (name: string) => boolean }[] = [
  {
    displayName: 'Claude Code',
    match: (n) => n === 'claude' || n === 'claude-code' || n.startsWith('claude'),
  },
  {
    displayName: 'Codex',
    match: (n) => n === 'codex',
  },
  {
    // Successor to Gemini CLI.
    displayName: 'Antigravity',
    match: (n) => n === 'antigravity',
  },
  {
    // Deprecated in favor of Antigravity CLI:
    // https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
    // Kept for legacy installs.
    displayName: 'Gemini CLI',
    match: (n) => n === 'gemini',
  },
  {
    displayName: 'Cursor',
    match: (n) => n === 'cursor' || n === 'cursor-agent',
  },
  {
    displayName: 'OpenCode',
    match: (n) => n === 'opencode',
  },
  {
    // forgecode.dev — installs as the `forge` binary.
    displayName: 'Forge Code',
    match: (n) => n === 'forge' || n === 'forgecode',
  },
  {
    // @mariozechner/pi-coding-agent — installs as the `pi` binary.
    displayName: 'PI Agent',
    match: (n) => n === 'pi',
  },
]

/**
 * Check if a process name matches a known agent CLI.
 * Returns the display name if matched, or null if not an agent.
 */
function matchAgentProcess(name: string): string | null {
  const lower = name.toLowerCase()
  for (const agent of AGENT_DEFINITIONS) {
    if (agent.match(lower)) return agent.displayName
  }
  return null
}

/**
 * Check if a process name is a common shell.
 */
function isShellProcess(name: string): boolean {
  const shells = ['zsh', 'bash', 'fish', 'sh', 'tcsh', 'ksh', 'dash']
  return shells.includes(name.toLowerCase())
}

/**
 * Agent helpers that linger between turns and must not be treated as work.
 * Claude Code keeps `caffeinate` and a persistent tool shell alive after the
 * first turn; counting them as "active" would pin the indicator to "running"
 * forever.
 */
const IDLE_AGENT_HELPERS = new Set(['caffeinate', 'pmset'])

/** MCP servers (`<name>-mcp`) and other long-lived helpers don't count as
 *  active tool execution. */
function isAgentHelper(name: string): boolean {
  if (IDLE_AGENT_HELPERS.has(name)) return true
  if (name.endsWith('-mcp') || name.startsWith('mcp-')) return true
  return false
}

/** Carries each terminal's last observed PIDs across a skipped/errored
 *  scan so `pruneStalePidAges` doesn't reset the first-seen entries for
 *  those processes on the next successful scan. */
const lastSeenPidsByTerminal: Map<string, number[]> = new Map()

/** When the current agent instance was first observed in each terminal —
 *  the reference point for the startup-grace helper window. */
const agentFirstSeenAt: Map<string, number> = new Map()

/** Returns the actual process start time on first sight (so reattach
 *  doesn't shift the anchor), or `now` if the lookup fails. */
async function childFirstSeenAt(pid: number, now: number): Promise<number> {
  if (hasPidFirstSeen(pid)) return recordPidFirstSeen(pid, now)
  const started = await getProcessStartedAt(pid)
  return recordPidFirstSeen(pid, started ?? now)
}

/** True iff this PID was started after the agent's startup-grace window
 *  ended — i.e. it's a tool, not a startup helper. */
async function isPostStartupChild(pid: number, now: number, agentStartedAt: number): Promise<boolean> {
  const firstSeen = await childFirstSeenAt(pid, now)
  return firstSeen - agentStartedAt > STARTUP_GRACE_MS
}

/** True if the agent has a child it spawned for real work, not a startup
 *  helper. Startup helpers (MCP servers + their `bun`/`node` runtimes) all
 *  appear within `STARTUP_GRACE_MS` of the agent itself appearing; later
 *  children are tools regardless of how long they run silently. */
async function agentIsActive(
  agentPid: number,
  terminalId: string,
  seenThisCycle: Set<number>,
): Promise<boolean> {
  const children = await getChildPids(agentPid)
  const now = Date.now()
  const agentStartedAt = agentFirstSeenAt.get(terminalId) ?? now
  let active = false
  for (const childPid of children) {
    seenThisCycle.add(childPid)
    const name = await getProcessName(childPid)
    if (!name) continue
    const lower = name.toLowerCase()
    if (isAgentHelper(lower)) continue
    if (isShellProcess(lower)) {
      // Shells only count as active when they have a post-startup subcommand
      // running under them. A bare idle shell — even one spawned post-grace
      // — isn't doing work.
      const subchildren = await getChildPids(childPid)
      for (const sub of subchildren) seenThisCycle.add(sub)
      for (const sub of subchildren) {
        if (await isPostStartupChild(sub, now, agentStartedAt)) { active = true; break }
      }
      continue
    }
    if (await isPostStartupChild(childPid, now, agentStartedAt)) active = true
  }
  return active
}


async function getAllDescendantPids(pid: number): Promise<number[]> {
  const children = await getChildPids(pid)
  const allDescendants = [...children]
  for (const child of children) {
    allDescendants.push(...(await getAllDescendantPids(child)))
  }
  return allDescendants
}

async function scanListeningPorts(): Promise<Map<string, number[]>> {
  if (registeredTerminals.size === 0) {
    return new Map()
  }

  const pidToTerminal = new Map<number, string>()
  const pidPromises: Promise<void>[] = []
  for (const [terminalId, info] of registeredTerminals) {
    pidPromises.push(
      getAllDescendantPids(info.shellPid).then((descendants) => {
        const allPids = [info.shellPid, ...descendants]
        for (const pid of allPids) {
          pidToTerminal.set(pid, terminalId)
        }
      })
    )
  }
  await Promise.all(pidPromises)

  return limit(() => new Promise((resolve) => {
    execFile('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n', '-F', 'pn'], {
      timeout: 5000,
    }, (err, stdout) => {
      const result = new Map<string, number[]>()
      if (err || !stdout) {
        resolve(result)
        return
      }

      let currentPid: number | null = null
      for (const line of stdout.split('\n')) {
        if (line.startsWith('p')) {
          currentPid = parseInt(line.slice(1), 10)
        } else if (line.startsWith('n') && currentPid != null) {
          const terminalId = pidToTerminal.get(currentPid)
          if (terminalId) {
            const match = line.match(/:(\d+)$/)
            if (match) {
              const port = parseInt(match[1], 10)
              if (!result.has(terminalId)) {
                result.set(terminalId, [])
              }
              const ports = result.get(terminalId)!
              if (!ports.includes(port)) {
                ports.push(port)
              }
            }
          }
        }
      }

      resolve(result)
    })
  }))
}

function getProcessCwd(pid: number): Promise<string | null> {
  if (!pid || pid <= 0) return Promise.resolve(null)
  return limit(() => new Promise((resolve) => {
    execFile('lsof', ['-p', `${pid}`, '-d', 'cwd', '-Fn'], {
      encoding: 'utf-8',
      timeout: 2000,
    }, (err, stdout) => {
      if (err || !stdout) {
        resolve(null)
        return
      }
      for (const line of stdout.split('\n')) {
        if (line.startsWith('n') && line.length > 1) {
          resolve(line.slice(1))
          return
        }
      }
      resolve(null)
    })
  }))
}

/**
 * Scan a single terminal's process tree to detect activity and Claude state.
 * Ported from ProcessMonitor.scanProcesses(for:) in Swift.
 */
async function scanTerminal(
  terminalId: string,
  info: TerminalRegistration,
  seenThisCycle: Set<number>,
): Promise<ScanResult> {
  const prev = previousStates.get(terminalId) || {
    previousAgentName: null,
    previouslyHadAgent: false,
  }

  const childrenToScan = await getChildPids(info.shellPid)

  let foundAgentName: string | null = null
  let foundAgentPid: number | null = null
  let firstChildName: string | null = null

  for (const childPid of childrenToScan) {
    seenThisCycle.add(childPid)
    const name = await getProcessName(childPid)
    if (name) {
      if (firstChildName === null && !isShellProcess(name)) {
        firstChildName = name
      }
      if (!foundAgentName) {
        let agentMatch = matchAgentProcess(name)
        // Node/bun/deno scripts: comm= returns the interpreter, so probe the
        // arg vector for the script basename (gemini ships as `#!/usr/bin/env node`).
        if (!agentMatch && INTERPRETER_NAMES.has(name.toLowerCase())) {
          const args = await getProcessArgs(childPid)
          if (args) {
            const script = scriptBasenameFromArgs(args)
            if (script) agentMatch = matchAgentProcess(script)
          }
        }
        if (agentMatch) {
          foundAgentName = agentMatch
          foundAgentPid = childPid
        }
      }
    }
  }

  const agentPresent = foundAgentName != null
  // Anchor the startup-grace window to the agent process's actual start
  // time so re-attaching to a long-running agent (cross-window reconnect,
  // session restore) doesn't shift the window into the future and
  // misclassify its already-running tools as helpers.
  if (agentPresent && !prev.previouslyHadAgent) {
    const startedAt = foundAgentPid != null ? await getProcessStartedAt(foundAgentPid) : null
    agentFirstSeenAt.set(terminalId, startedAt ?? Date.now())
  } else if (!agentPresent) {
    agentFirstSeenAt.delete(terminalId)
  }
  const subprocessActive = foundAgentPid != null
    ? await agentIsActive(foundAgentPid, terminalId, seenThisCycle)
    : false

  // Diff PTY bytes since last scan, normalised to 1s, against the streaming
  // threshold. Filters out low-rate TUI redraws (cursor blink, status line).
  const now = Date.now()
  const totalBytes = getTotalPtyBytes(terminalId)
  let isStreaming = false
  if (agentPresent && totalBytes != null) {
    const prev = bytesSamples.get(terminalId)
    if (prev) {
      const elapsed = Math.max(now - prev.sampledAt, 1)
      const bytesPerInterval = (totalBytes - prev.total) * (1000 / elapsed)
      isStreaming = bytesPerInterval >= STREAMING_BYTES_PER_INTERVAL
    }
    bytesSamples.set(terminalId, { total: totalBytes, sampledAt: now })
  } else {
    // Drop the baseline once the agent is gone so a restart doesn't diff
    // against bytes accumulated while no agent was around.
    bytesSamples.delete(terminalId)
  }

  const terminalActivity: TerminalActivity =
    firstChildName != null
      ? { type: 'running', processName: firstChildName }
      : { type: 'idle' }

  const agentName = foundAgentName ?? prev.previousAgentName
  let previouslyHadAgent = prev.previouslyHadAgent
  if (agentPresent) {
    previouslyHadAgent = true
  } else if (previouslyHadAgent) {
    previouslyHadAgent = false
  }

  return {
    terminalActivity,
    agentName,
    subprocessActive,
    agentPresent,
    previouslyHadAgent,
    isStreaming,
  }
}

/**
 * Start polling all registered terminals every 1 second.
 * Emits SHELL_ACTIVITY_UPDATE IPC events to the owning window.
 */
function startPolling(): void {
  if (pollInterval) return

  pollInterval = setInterval(async () => {
    if (pollBusy) return
    pollBusy = true

    try {
      // Scan all terminals concurrently
      const entries = Array.from(registeredTerminals.entries())
      if (entries.length === 0) return
      const seenThisCycle = new Set<number>()
      const scanResults = await Promise.all(
        entries.map(async ([terminalId, info]) => {
          if (skipNextScan.has(terminalId)) {
            skipNextScan.delete(terminalId)
            // Carry the last successful scan's PIDs forward so the prune
            // below doesn't wipe their age entries.
            for (const pid of lastSeenPidsByTerminal.get(terminalId) ?? []) {
              seenThisCycle.add(pid)
            }
            return null
          }
          const localSeen = new Set<number>()
          try {
            const result = await scanTerminal(terminalId, info, localSeen)
            for (const pid of localSeen) seenThisCycle.add(pid)
            lastSeenPidsByTerminal.set(terminalId, Array.from(localSeen))
            return { terminalId, info, result }
          } catch (e) {
            skipNextScan.add(terminalId)
            for (const pid of lastSeenPidsByTerminal.get(terminalId) ?? []) {
              seenThisCycle.add(pid)
            }
            return null
          }
        })
      )
      pruneStalePidAges(seenThisCycle)

      for (const entry of scanResults) {
        if (!entry) continue
        const { terminalId, info, result } = entry
        previousStates.set(terminalId, {
          previousAgentName: result.agentName,
          previouslyHadAgent: result.previouslyHadAgent,
        })

        sendToWindow(
          info.ownerWindowId,
          SHELL_ACTIVITY_UPDATE,
          terminalId,
          result.terminalActivity,
          result.agentName,
          result.subprocessActive,
          result.agentPresent,
          result.isStreaming,
        )
      }

      // --- CWD updates (concurrent) ---
      const cwdResults = await Promise.all(
        entries.map(async ([terminalId, info]) => {
          if (skipNextScan.has(terminalId)) return null
          try {
            const cwd = await getProcessCwd(info.shellPid)
            return { terminalId, info, cwd }
          } catch {
            skipNextScan.add(terminalId)
            return null
          }
        })
      )

      for (const cwdEntry of cwdResults) {
        if (!cwdEntry) continue
        const { terminalId, info, cwd } = cwdEntry
        if (cwd) {
          sendToWindow(info.ownerWindowId, SHELL_CWD_UPDATE, terminalId, cwd)
        }
      }

      // --- Port scan (async, non-blocking) ---
      const portMap = await scanListeningPorts()
      for (const [terminalId, ports] of portMap) {
        const info = registeredTerminals.get(terminalId)
        if (info) {
          sendToWindow(info.ownerWindowId, SHELL_PORTS_UPDATE, terminalId, ports.sort((a, b) => a - b))
        }
      }
      for (const [terminalId, info] of registeredTerminals) {
        if (!portMap.has(terminalId)) {
          sendToWindow(info.ownerWindowId, SHELL_PORTS_UPDATE, terminalId, [])
        }
      }
    } finally {
      pollBusy = false
    }
  }, 1000)
}

function stopPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
}

/**
 * Unregister all terminals owned by a specific window (called on window close).
 */
export function unregisterTerminalsForWindow(windowId: number): void {
  for (const [terminalId, info] of registeredTerminals) {
    if (info.ownerWindowId === windowId) {
      registeredTerminals.delete(terminalId)
      previousStates.delete(terminalId)
      skipNextScan.delete(terminalId)
      bytesSamples.delete(terminalId)
      lastSeenPidsByTerminal.delete(terminalId)
      agentFirstSeenAt.delete(terminalId)
    }
  }
  if (registeredTerminals.size === 0) {
    stopPolling()
  }
}

export function registerHandlers(): void {
  ipcMain.handle(
    SHELL_REGISTER_TERMINAL,
    async (event, terminalId: string, pid?: number) => {
      // Look up the shell PID from the terminal module if not provided
      const shellPid = pid ?? terminalPids.get(terminalId)
      if (shellPid == null) {
        log.warn(`[shell] No PID found for terminal ${terminalId}`)
        return
      }

      const win = windowFromEvent(event)
      const ownerWindowId = win?.id ?? -1

      registeredTerminals.set(terminalId, {
        shellPid,
        workspaceId: '',
        nodeId: '',
        ownerWindowId,
      })

      previousStates.set(terminalId, {
        previousAgentName: null,
        previouslyHadAgent: false,
      })

      // Start polling on first registration
      startPolling()
    },
  )

  // Renderer reports screen-derived agent state; rebroadcast so every
  // window's sidebar gets it (the sidebar in the main window won't otherwise
  // see state for terminals that live in a detached panel window). Also
  // record it in previousStates so the next process-tree scan doesn't clobber
  // the renderer's reading by re-emitting 'running'.
  ipcMain.on(SHELL_AGENT_SCREEN_STATE, (_event, terminalId: string, state: string) => {
    broadcastToAll(SHELL_AGENT_SCREEN_STATE, terminalId, state)
  })

  ipcMain.handle(SHELL_UNREGISTER_TERMINAL, async (_event, terminalId: string) => {
    registeredTerminals.delete(terminalId)
    previousStates.delete(terminalId)
    skipNextScan.delete(terminalId)
    bytesSamples.delete(terminalId)
    lastSeenPidsByTerminal.delete(terminalId)
    agentFirstSeenAt.delete(terminalId)
    if (registeredTerminals.size === 0) {
      stopPolling()
    }
  })

}
