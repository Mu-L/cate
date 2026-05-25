// =============================================================================
// GlobalSearch — Canvas-wide search overlay.
// Searches workspace files, terminal scrollback, and open panels.
// Triggered by the globalSearch shortcut (Cmd+Shift+F).
// =============================================================================

import React, { useState, useCallback, useEffect, useMemo } from 'react'
import { MagnifyingGlass, FileText, Terminal, Globe, Folder, Stack, GitBranch, Square } from '@phosphor-icons/react'
import type { PanelType } from '../../shared/types'
import { useUIStore } from '../stores/uiStore'
import { useAppStore } from '../stores/appStore'
import { useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { useDockStore } from '../stores/dockStore'
import { findTabStack } from '../stores/dockTreeUtils'
import { terminalRegistry } from '../lib/terminalRegistry'
import { openFileAsPanel } from '../lib/fileRouting'

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type ResultKind = 'file' | 'panel' | 'terminal'

interface BaseResult {
  key: string
  kind: ResultKind
  primary: string
  secondary: string
  score: number
}

interface FileResult extends BaseResult {
  kind: 'file'
  filePath: string
  line?: number
}

interface PanelResult extends BaseResult {
  kind: 'panel'
  panelId: string
  panelType: PanelType
  nodeId?: string
}

interface TerminalResult extends BaseResult {
  kind: 'terminal'
  panelId: string
  nodeId?: string
  line: number
}

type SearchResult = FileResult | PanelResult | TerminalResult

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function GlobalSearch() {
  const canvasApi = useCanvasStoreApi()
  const show = useUIStore((s) => s.showGlobalSearch)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [busy, setBusy] = useState(false)

  const close = useCallback(() => {
    useUIStore.getState().setShowGlobalSearch(false)
    setQuery('')
    setResults([])
  }, [])

  const doSearch = useCallback(async (searchText: string) => {
    if (!searchText || searchText.length < 2) {
      setResults([])
      return
    }
    const q = searchText.toLowerCase()

    const workspace = useAppStore.getState().workspaces.find(
      (w) => w.id === useAppStore.getState().selectedWorkspaceId,
    )
    if (!workspace) return

    const canvasNodes = canvasApi.getState().nodes
    const focusedNodeId = canvasApi.getState().focusedNodeId
    const nodeByPanelId = new Map<string, { id: string; creationIndex: number }>()
    for (const n of Object.values(canvasNodes)) {
      nodeByPanelId.set(n.panelId, { id: n.id, creationIndex: n.creationIndex })
    }

    const out: SearchResult[] = []

    // 1) Open panels (title + file path)
    for (const panel of Object.values(workspace.panels)) {
      const title = panel.title ?? ''
      const fp = panel.filePath ?? ''
      const url = panel.url ?? ''
      const hay = `${title}\n${fp}\n${url}`.toLowerCase()
      if (!hay.includes(q)) continue
      const n = nodeByPanelId.get(panel.id)
      // Recent-focus ranking: currently-focused panel first, then higher creationIndex.
      const recency = n ? (focusedNodeId === n.id ? 1_000_000 : n.creationIndex) : 0
      out.push({
        key: `panel:${panel.id}`,
        kind: 'panel',
        primary: title || panel.type,
        secondary: fp || url || panel.type,
        score: 2000 + recency,
        panelId: panel.id,
        panelType: panel.type,
        nodeId: n?.id,
      })
    }

    // 2) Terminal scrollback
    const terminalPanels = Object.values(workspace.panels).filter((p) => p.type === 'terminal')
    for (const panel of terminalPanels) {
      const entry = terminalRegistry.getEntry(panel.id)
      if (!entry) continue
      const buffer = entry.terminal.buffer.active
      const last = buffer.baseY + buffer.cursorY
      let matches = 0
      for (let i = 0; i < last && matches < 5; i++) {
        const line = buffer.getLine(i)
        if (!line) continue
        const text = line.translateToString(true)
        if (text.toLowerCase().includes(q)) {
          matches++
          const n = nodeByPanelId.get(panel.id)
          out.push({
            key: `term:${panel.id}:${i}`,
            kind: 'terminal',
            primary: `${panel.title}:${i + 1}`,
            secondary: text.trim().slice(0, 200),
            score: 1000 + (n ? n.creationIndex : 0),
            panelId: panel.id,
            nodeId: n?.id,
            line: i + 1,
          })
        }
      }
    }

    // 3) Workspace files (names + content) via fsSearch
    if (workspace.rootPath) {
      try {
        const hits = await window.electronAPI.fsSearch(workspace.rootPath, searchText, { maxResults: 50 })
        for (const h of hits) {
          if (h.isDirectory) continue
          out.push({
            key: `file:${h.path}${h.contentLine ?? ''}`,
            kind: 'file',
            primary: h.name + (h.contentLine ? `:${h.contentLine}` : ''),
            secondary: h.contentPreview?.trim().slice(0, 200) || h.relativePath,
            score: h.nameMatch ? 500 : 100,
            filePath: h.path,
            line: h.contentLine,
          })
        }
      } catch {
        /* filesystem search unavailable */
      }
    }

    out.sort((a, b) => b.score - a.score)
    setResults(out.slice(0, 80))
    setSelectedIndex(0)
  }, [canvasApi])

  // Debounced search
  useEffect(() => {
    if (!show) return
    setBusy(true)
    const timer = setTimeout(async () => {
      await doSearch(query)
      setBusy(false)
    }, 250)
    return () => { clearTimeout(timer); setBusy(false) }
  }, [query, show, doSearch])

  const selectResult = useCallback(
    async (result: SearchResult) => {
      const appStore = useAppStore.getState()
      const wsId = appStore.selectedWorkspaceId
      if (result.kind === 'file') {
        // Open in an editor panel. If an editor for this file already exists, focus it.
        const ws = appStore.workspaces.find((w) => w.id === wsId)
        let panelId: string | undefined
        if (ws) {
          const existing = Object.values(ws.panels).find(
            (p) => (p.type === 'editor' || p.type === 'document') && p.filePath === result.filePath,
          )
          panelId = existing?.id
        }
        if (!panelId) {
          panelId = openFileAsPanel(wsId, result.filePath)
        }
        const cs = canvasApi.getState()
        const node = panelId ? Object.values(cs.nodes).find((n) => n.panelId === panelId) : undefined
        if (node) cs.focusAndCenter(node.id)
      } else if (result.kind === 'panel' || result.kind === 'terminal') {
        if (result.nodeId) {
          canvasApi.getState().focusAndCenter(result.nodeId)
        } else {
          // Dock panel — reveal in dock zone.
          const dock = useDockStore.getState()
          const loc = dock.getPanelLocation(result.panelId)
          if (loc && loc.type === 'dock') {
            const zone = dock.zones[loc.zone]
            if (!zone.visible) dock.toggleZone(loc.zone)
            if (zone.layout) {
              const stack = findTabStack(zone.layout, loc.stackId)
              if (stack) {
                const idx = stack.panelIds.indexOf(result.panelId)
                if (idx >= 0) dock.setActiveTab(loc.stackId, idx)
              }
            }
          }
        }
      }
      close()
    },
    [canvasApi, close],
  )

  // Keyboard navigation
  useEffect(() => {
    if (!show) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); return }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1))
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.max(prev - 1, 0))
      }
      if (e.key === 'Enter' && results[selectedIndex]) {
        selectResult(results[selectedIndex])
      }
    }
    document.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => document.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [show, results, selectedIndex, close, selectResult])

  // Group results by kind for rendering while preserving global order.
  const grouped = useMemo(() => {
    const seen = new Set<ResultKind>()
    const sections: { kind: ResultKind; items: SearchResult[] }[] = []
    for (const r of results) {
      if (!seen.has(r.kind)) { seen.add(r.kind); sections.push({ kind: r.kind, items: [] }) }
      sections.find((s) => s.kind === r.kind)!.items.push(r)
    }
    return sections
  }, [results])

  if (!show) return null

  let flatIndex = 0
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-40 bg-black/40"
      onClick={close}
    >
      <div
        className="w-[640px] max-h-[560px] rounded-3xl overflow-hidden flex flex-col bg-surface-4/85 backdrop-blur-2xl border border-white/20 shadow-[0_24px_64px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 h-14">
          <MagnifyingGlass size={20} className="text-muted shrink-0" weight="bold" />
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 bg-transparent text-primary text-base font-medium outline-none placeholder:text-muted placeholder:font-normal"
            placeholder="Search files, terminals, panels…"
          />
        </div>

        {results.length > 0 && (
          <div className="flex-1 overflow-y-auto pb-2">
            {grouped.map((section, si) => (
              <div key={section.kind}>
                {si > 0 && <div className="mx-5 my-1 border-t border-white/10" />}
                {section.items.map((r) => {
                  const thisIndex = flatIndex++
                  const isSelected = thisIndex === selectedIndex
                  return (
                    <div
                      key={r.key}
                      className={`flex items-center gap-3 mx-2 px-3 py-2 cursor-pointer rounded-lg ${
                        isSelected ? 'bg-blue-600/30' : 'hover:bg-white/5'
                      }`}
                      onClick={() => selectResult(r)}
                    >
                      <ResultIcon result={r} />
                      <div className="flex-1 min-w-0">
                        <div className="text-primary text-sm font-medium truncate">{r.primary}</div>
                        <div className="text-muted text-xs truncate mt-0.5">{r.secondary}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        )}

        {query.length >= 2 && results.length === 0 && !busy && (
          <div className="px-5 py-5 text-sm text-muted text-center border-t border-white/10">
            No results
          </div>
        )}
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Result icon — type-aware glyph in a tinted square tile
// -----------------------------------------------------------------------------

function ResultIcon({ result }: { result: SearchResult }) {
  const tile = 'w-8 h-8 rounded-full flex items-center justify-center shrink-0'
  if (result.kind === 'file') {
    return <div className={`${tile} bg-amber-500/15 text-amber-400`}><FileText size={16} weight="bold" /></div>
  }
  if (result.kind === 'terminal') {
    return <div className={`${tile} bg-emerald-500/15 text-emerald-400`}><Terminal size={16} weight="bold" /></div>
  }
  // panel — type-specific
  const { panelType } = result
  if (panelType === 'terminal') return <div className={`${tile} bg-emerald-500/15 text-emerald-400`}><Terminal size={16} weight="bold" /></div>
  if (panelType === 'browser')  return <div className={`${tile} bg-sky-500/15 text-sky-400`}><Globe size={16} weight="bold" /></div>
  if (panelType === 'editor')   return <div className={`${tile} bg-orange-500/15 text-orange-400`}><FileText size={16} weight="bold" /></div>
  if (panelType === 'git')      return <div className={`${tile} bg-red-500/15 text-red-400`}><GitBranch size={16} weight="bold" /></div>
  if (panelType === 'fileExplorer') return <div className={`${tile} bg-cyan-500/15 text-cyan-400`}><Folder size={16} weight="bold" /></div>
  if (panelType === 'projectList')  return <div className={`${tile} bg-yellow-500/15 text-yellow-400`}><Stack size={16} weight="bold" /></div>
  return <div className={`${tile} bg-violet-500/15 text-violet-400`}><Square size={16} weight="bold" /></div>
}
