import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useRoute } from '@/hooks/use-route'
import { useProjectConfig } from '@/hooks/use-project-config'
import { ScrollArea } from '@/components/ui/scroll-area'
import { navigateTo } from '@/lib/route'

import {
  LeftSidebarProps,
  PlaybookSummary,
  SessionSummary,
} from './types'
import { SessionList } from './session-list'
import { PlaybookList } from './playbook-list'
import { SidebarHeader, SectionHeader } from './sidebar-header'
import { isAbortError } from './utils'

export function LeftSidebar({
  onSessionSelect,
  onNewSession,
  userButton,
}: LeftSidebarProps) {
  const { sessionId: routeSessionId } = useRoute()
  const { projectId } = useProjectConfig()

  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [playbooks, setPlaybooks] = useState<PlaybookSummary[]>([])
  const [isLoadingSessions, setIsLoadingSessions] = useState(false)
  const [isLoadingPlaybooks, setIsLoadingPlaybooks] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Track if this is the initial page load - only auto-select session on first load
  // This prevents navigating back to a session when user clicks "New Session"
  const hasInitializedRef = useRef(false)

  // Track if we've done the initial load
  const hasLoadedRef = useRef(false)
  const hasLoadedPlaybooksRef = useRef(false)

  // Load sessions for the authenticated user
  const loadSessions = useCallback(async (signal?: AbortSignal, isInitial = false) => {
    // Only show loading spinner on initial load, not during background refresh
    if (isInitial || !hasLoadedRef.current) {
      setIsLoadingSessions(true)
    }
    setErrorMessage(null)

    try {
      const loadedSessions = await fetchUserSessions(signal)
      setSessions(loadedSessions)
      hasLoadedRef.current = true
    } catch (error) {
      if (isAbortError(error)) {
        return
      }
      // Don't show error if user is not authenticated (401)
      if (error instanceof Error && error.message.includes('401')) {
        setSessions([])
      } else {
        setErrorMessage(error instanceof Error ? error.message : 'Failed to load sessions.')
      }
    } finally {
      setIsLoadingSessions(false)
    }
  }, [])

  // Load playbooks
  const loadPlaybooks = useCallback(async (signal?: AbortSignal, isInitial = false) => {
    // Only show loading on initial load
    if (isInitial || !hasLoadedPlaybooksRef.current) {
      setIsLoadingPlaybooks(true)
    }

    try {
      const loadedPlaybooks = await fetchPlaybooks(signal)
      setPlaybooks(loadedPlaybooks)
      hasLoadedPlaybooksRef.current = true
    } catch (error) {
      if (isAbortError(error)) {
        return
      }
      console.error('Failed to load playbooks:', error)
    } finally {
      setIsLoadingPlaybooks(false)
    }
  }, [])

  // Initial load only - no periodic refresh
  useEffect(() => {
    const controller = new AbortController()
    loadSessions(controller.signal, true)
    loadPlaybooks(controller.signal, true)
    return () => controller.abort()
  }, [loadSessions, loadPlaybooks])

  // Listen for refresh events (triggered when playbooks are created/updated via tool)
  useEffect(() => {
    const handleRefreshPlaybooks = () => {
      loadPlaybooks()
    }
    const handleRefreshSessions = () => {
      loadSessions()
    }

    window.addEventListener('refresh-playbooks', handleRefreshPlaybooks)
    window.addEventListener('refresh-sessions', handleRefreshSessions)
    return () => {
      window.removeEventListener('refresh-playbooks', handleRefreshPlaybooks)
      window.removeEventListener('refresh-sessions', handleRefreshSessions)
    }
  }, [loadPlaybooks, loadSessions])

  // Derive current session from route or first in list
  const derivedSessionId = useMemo(() => {
    if (routeSessionId) {
      return routeSessionId
    }
    return sessions[0]?.id ?? null
  }, [sessions, routeSessionId])

  // Auto-select first session ONLY on initial page load
  // Skip if user has already interacted (e.g., clicked "New Session")
  useEffect(() => {
    // If there's already a session in the URL, mark as initialized and skip
    if (routeSessionId) {
      hasInitializedRef.current = true
      return
    }

    // Only auto-select on the very first load, not on subsequent navigations
    if (hasInitializedRef.current) {
      return
    }

    // First time loading with no session in URL - auto-select first session
    if (sessions.length > 0) {
      const firstSession = sessions[0]
      if (firstSession) {
        hasInitializedRef.current = true
        navigateTo(`/sessions/${encodeURIComponent(firstSession.id)}`, { replace: true })
        onSessionSelect?.({ sessionId: firstSession.id, projectId })
      }
    }
  }, [sessions, routeSessionId, onSessionSelect, projectId])

  const handleSessionClick = useCallback(
    (sessionId: string) => {
      navigateTo(`/sessions/${encodeURIComponent(sessionId)}`)
      onSessionSelect?.({ sessionId, projectId })
    },
    [onSessionSelect, projectId],
  )

  const handleRename = useCallback(
    async (sessionId: string, newTitle: string) => {
      try {
        const response = await fetch(`/api/sessions/${sessionId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: newTitle }),
        })

        if (!response.ok) {
          throw new Error('Failed to rename session')
        }

        // Refresh the session list
        loadSessions()
      } catch (error) {
        console.error('Failed to rename session:', error)
      }
    },
    [loadSessions],
  )

  const handleDelete = useCallback(
    async (sessionId: string) => {
      try {
        const response = await fetch(`/api/sessions/${sessionId}`, {
          method: 'DELETE',
        })

        if (!response.ok) {
          throw new Error('Failed to delete session')
        }

        // Refresh the session list
        loadSessions()

        // If we deleted the currently selected session, navigate to another one
        if (sessionId === derivedSessionId) {
          // Find the next available session (excluding the deleted one)
          const remainingSessions = sessions.filter(s => s.id !== sessionId)
          if (remainingSessions.length > 0) {
            const nextSession = remainingSessions[0]
            if (nextSession) {
              navigateTo(`/sessions/${encodeURIComponent(nextSession.id)}`)
              onSessionSelect?.({ sessionId: nextSession.id, projectId })
            }
          } else {
            // No sessions left, navigate to home
            navigateTo('/')
          }
        }
      } catch (error) {
        console.error('Failed to delete session:', error)
      }
    },
    [loadSessions, derivedSessionId, sessions, onSessionSelect],
  )

  // Playbook handlers
  const handlePlaybookRun = useCallback(
    (playbook: PlaybookSummary) => {
      // Run playbook by triggering a new session with the playbook's prompt
      // We dispatch a custom event that App.tsx will listen to
      window.dispatchEvent(new CustomEvent('run-playbook', { detail: { prompt: playbook.prompt } }))
    },
    [],
  )

  const handlePlaybookRename = useCallback(
    async (id: string, newName: string) => {
      try {
        const response = await fetch(`/api/playbooks/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName }),
        })

        if (!response.ok) {
          throw new Error('Failed to rename playbook')
        }

        loadPlaybooks()
      } catch (error) {
        console.error('Failed to rename playbook:', error)
      }
    },
    [loadPlaybooks],
  )

  const handlePlaybookDelete = useCallback(
    async (id: string) => {
      try {
        const response = await fetch(`/api/playbooks/${id}`, {
          method: 'DELETE',
        })

        if (!response.ok) {
          throw new Error('Failed to delete playbook')
        }

        loadPlaybooks()
      } catch (error) {
        console.error('Failed to delete playbook:', error)
      }
    },
    [loadPlaybooks],
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <SidebarHeader
        onNewSession={onNewSession}
        disabled={false}
        projectName="Sidekick"
        latestActivity={sessions[0]?.lastMessageAt ?? null}
      />
      <div className="flex-1 overflow-hidden">
        <ScrollArea className="flex h-full flex-col px-2 py-3">
          {/* Sessions section */}
          <SectionHeader title="Sessions" />
          <div className="py-1">
            <SessionList
              sessions={sessions}
              selectedSessionId={derivedSessionId}
              onSelect={handleSessionClick}
              isLoading={isLoadingSessions}
              errorMessage={errorMessage}
              onRename={handleRename}
              onDelete={handleDelete}
            />
          </div>

          {/* Playbooks section */}
          <div className="mt-4">
            <SectionHeader title="Playbooks" />
            <div className="py-1">
              <PlaybookList
                playbooks={playbooks}
                isLoading={isLoadingPlaybooks}
                onRun={handlePlaybookRun}
                onRename={handlePlaybookRename}
                onDelete={handlePlaybookDelete}
              />
            </div>
          </div>
        </ScrollArea>
      </div>
      {userButton && (
        <div className="border-t px-3 py-3">
          {userButton}
        </div>
      )}
    </div>
  )
}

async function fetchUserSessions(signal?: AbortSignal): Promise<SessionSummary[]> {
  const MAX_RETRIES = 3
  const BASE_DELAY_MS = 500

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const response = await fetch('/api/sessions', {
      method: 'GET',
      signal,
    })

    if (response.status === 401) {
      // User not authenticated - return empty list
      return []
    }

    if (response.status === 500 && attempt < MAX_RETRIES - 1) {
      // Server error, likely DB not ready - retry with exponential backoff
      const delay = BASE_DELAY_MS * Math.pow(2, attempt)
      await new Promise(resolve => setTimeout(resolve, delay))
      continue
    }

    if (!response.ok) {
      throw new Error(`Failed to load sessions (status ${response.status})`)
    }

    const body = (await response.json()) as { sessions?: SessionSummary[] }
    return Array.isArray(body?.sessions) ? body.sessions : []
  }

  // Should not reach here, but return empty array as fallback
  return []
}

async function fetchPlaybooks(signal?: AbortSignal): Promise<PlaybookSummary[]> {
  const MAX_RETRIES = 3
  const BASE_DELAY_MS = 500

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch('/api/playbooks', {
        method: 'GET',
        signal,
      })

      if (response.status === 500 && attempt < MAX_RETRIES - 1) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt)
        await new Promise(resolve => setTimeout(resolve, delay))
        continue
      }

      if (!response.ok) {
        return []
      }

      const body = (await response.json()) as { playbooks?: PlaybookSummary[] }
      return Array.isArray(body?.playbooks) ? body.playbooks : []
    } catch (error) {
      if (signal?.aborted) return []
      if (attempt < MAX_RETRIES - 1) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt)
        await new Promise(resolve => setTimeout(resolve, delay))
        continue
      }
      console.error('Failed to fetch playbooks after retries:', error)
      return []
    }
  }
  return []
}
