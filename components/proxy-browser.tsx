"use client"

import type React from "react"

import { useState, useEffect, useRef, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card } from "@/components/ui/card"
import {
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Home,
  Plus,
  X,
  Globe,
  Loader2,
  AlertCircle,
  Shield,
  ShieldAlert,
  StopCircle,
  Star,
  Menu,
  History,
  Settings,
  Download,
} from "lucide-react"
import { fetchThroughProxy, formatUrl } from "@/lib/proxy-utils"
import { SessionManager } from "@/lib/session-manager"
import { BookmarksPanel } from "@/components/bookmarks-panel"

interface Tab {
  id: string
  title: string
  url: string
  isActive: boolean
  isLoading?: boolean
  favicon?: string
  /** Rewritten HTML, written into a same-origin frame (see ProxiedFrame) */
  content?: string
  /** Changes on every successful load, so each page gets a fresh frame */
  loadId?: string
  /** Object URL for non-HTML responses (images, PDFs, text) */
  frameSrc?: string
  frameType?: string
  error?: string
  errorDetails?: string
  history: string[]
  historyIndex: number
  isSecure?: boolean
  /** The frame navigated somewhere the proxy couldn't intercept */
  leftProxy?: boolean
}

/**
 * "push" = new entry, "replace" = new URL in the current entry (location.replace),
 * "reload" = same page again, { index } = back/forward
 */
type HistoryMode = "push" | "replace" | "reload" | { index: number }

interface NavRequest {
  method?: "GET" | "POST"
  body?: string
}

const STOPPED_MESSAGE = "Page loading was stopped."

const makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const blankTab = (isActive = true): Tab => ({
  id: makeId(),
  title: "New Tab",
  url: "",
  isActive,
  history: [],
  historyIndex: -1,
})

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return "Unknown"
  }
}

/** Only what's worth persisting — page content can blow past the localStorage quota */
function persistableTabs(tabs: Tab[]) {
  return tabs.map(({ id, title, url, isActive, favicon, history, historyIndex, isSecure }) => ({
    id,
    title,
    url,
    isActive,
    favicon,
    history,
    historyIndex,
    isSecure,
  }))
}

/** Reload the current history entry, or push if the URL never made it into history (failed load) */
function reloadMode(tab: Tab): HistoryMode {
  return tab.history[tab.historyIndex] === tab.url ? "reload" : "push"
}

/** Frames whose page has been written (later loads mean the frame navigated away) */
const writtenFrames = new WeakSet<HTMLIFrameElement>()

/**
 * Renders proxied HTML by loading a blank same-origin page and then writing the
 * HTML into it with document.open/write, instead of using srcdoc. The written
 * document takes an http(s) URL on the app's origin (a srcdoc document is stuck
 * at "about:srcdoc"), which lets the injected script rewrite it with
 * history.replaceState so location.pathname, search and hash match the real page.
 *
 * The blank page must be a real navigation, not the frame's initial about:blank:
 * Chrome treats history entries pushed on a written initial about:blank as
 * cross-document, so the page's own back/forward would reload the frame.
 *
 * Each page needs a fresh frame (use a changing key): document.open() keeps
 * the previous page's window and globals.
 */
function ProxiedFrame({
  html,
  title,
  frameRef,
  onLoad,
}: {
  html: string
  title: string
  frameRef: React.MutableRefObject<HTMLIFrameElement | null>
  onLoad: (event: React.SyntheticEvent<HTMLIFrameElement>) => void
}) {
  const handleLoad = (event: React.SyntheticEvent<HTMLIFrameElement>) => {
    const frame = event.currentTarget
    if (writtenFrames.has(frame)) {
      onLoad(event)
      return
    }
    let doc: Document | null = null
    try {
      doc = frame.contentDocument
    } catch {
      doc = null
    }
    // Only write into our own blank page (not the initial about:blank)
    if (!doc || !doc.location.pathname.endsWith("/devon-frame.html")) return
    writtenFrames.add(frame)
    frameRef.current = frame
    // Leave the load event before replacing the document
    setTimeout(() => {
      doc.open()
      doc.write(html)
      doc.close()
    }, 0)
  }

  return (
    <iframe
      ref={(el) => {
        if (el) frameRef.current = el
      }}
      src="/devon-frame.html"
      data-devon-page=""
      onLoad={handleLoad}
      className="w-full flex-1 min-h-0 border-0 bg-white"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
      title={title}
    />
  )
}

export function ProxyBrowser() {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [currentUrl, setCurrentUrl] = useState("")
  const [showBookmarks, setShowBookmarks] = useState(false)
  const [showMenu, setShowMenu] = useState(false)

  const controllersRef = useRef(new Map<string, AbortController>())
  const blobUrlsRef = useRef(new Map<string, string>())
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const addressBarRef = useRef<HTMLInputElement>(null)
  const activeTabIdRef = useRef<string | undefined>(undefined)
  const tabsRef = useRef<Tab[]>([])

  const activeTab = tabs.find((tab) => tab.isActive)

  useEffect(() => {
    activeTabIdRef.current = activeTab?.id
    tabsRef.current = tabs
  }, [activeTab?.id, tabs])

  // Load session on mount
  useEffect(() => {
    setTabs(SessionManager.loadSession().tabs)
  }, [])

  // Save session whenever tabs change
  useEffect(() => {
    if (tabs.length > 0) {
      SessionManager.saveSession({ tabs: persistableTabs(tabs) })
    }
  }, [tabs])

  // Keep the address bar in sync with the active tab (switching tabs, redirects, link clicks)
  useEffect(() => {
    setCurrentUrl(activeTab?.url ?? "")
  }, [activeTab?.id, activeTab?.url])

  // Revoke object URLs on unmount
  useEffect(() => {
    const blobUrls = blobUrlsRef.current
    const controllers = controllersRef.current
    return () => {
      controllers.forEach((c) => c.abort())
      blobUrls.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [])

  const releaseBlob = useCallback((tabId: string) => {
    const url = blobUrlsRef.current.get(tabId)
    if (url) {
      URL.revokeObjectURL(url)
      blobUrlsRef.current.delete(tabId)
    }
  }, [])

  const cancelLoad = useCallback((tabId: string) => {
    controllersRef.current.get(tabId)?.abort()
    controllersRef.current.delete(tabId)
  }, [])

  const navigate = useCallback(
    async (tabId: string, input: string, historyMode: HistoryMode = "push", request: NavRequest = {}) => {
      const trimmed = input.trim()
      if (!trimmed) return
      const formattedUrl = formatUrl(trimmed)

      // Cancel any load already running in this tab
      controllersRef.current.get(tabId)?.abort()
      const controller = new AbortController()
      controllersRef.current.set(tabId, controller)

      releaseBlob(tabId)
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                url: formattedUrl,
                isLoading: true,
                error: undefined,
                errorDetails: undefined,
                content: undefined,
                frameSrc: undefined,
                frameType: undefined,
                leftProxy: undefined,
              }
            : tab,
        ),
      )

      try {
        const result = await fetchThroughProxy(formattedUrl, { ...request, signal: controller.signal })

        // A newer navigation (or a closed tab) superseded this one
        if (controllersRef.current.get(tabId) !== controller) {
          if (result.frameSrc) URL.revokeObjectURL(result.frameSrc)
          return
        }
        controllersRef.current.delete(tabId)
        if (result.frameSrc) blobUrlsRef.current.set(tabId, result.frameSrc)

        const finalUrl = result.finalUrl

        // Updated by tab id, so a slow page can't land in whichever tab is active now
        setTabs((prev) =>
          prev.map((tab) => {
            if (tab.id !== tabId) return tab

            let history = tab.history
            let historyIndex = tab.historyIndex
            if (historyMode === "push") {
              history = [...tab.history.slice(0, tab.historyIndex + 1), finalUrl]
              historyIndex = history.length - 1
            } else if (typeof historyMode === "object") {
              historyIndex = historyMode.index
              history = [...tab.history]
              history[historyIndex] = finalUrl
            } else if (historyIndex >= 0) {
              history = [...tab.history]
              history[historyIndex] = finalUrl
            }

            return {
              ...tab,
              url: finalUrl,
              title: result.title,
              favicon: result.favicon,
              content: result.content,
              loadId: makeId(),
              frameSrc: result.frameSrc,
              frameType: result.contentType,
              isLoading: false,
              error: undefined,
              errorDetails: undefined,
              history,
              historyIndex,
              isSecure: finalUrl.startsWith("https://"),
            }
          }),
        )

        if (historyMode === "push" || historyMode === "replace") {
          SessionManager.addToHistory({ title: result.title, url: finalUrl, favicon: result.favicon })
        }
      } catch (error) {
        if (controllersRef.current.get(tabId) !== controller) return
        controllersRef.current.delete(tabId)

        const aborted = error instanceof Error && error.name === "AbortError"
        const errorMessage = aborted ? STOPPED_MESSAGE : error instanceof Error ? error.message : "Failed to load page"
        const errorDetails = !aborted && error instanceof Error && error.stack ? error.stack : ""

        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === tabId
              ? {
                  ...tab,
                  isLoading: false,
                  error: errorMessage,
                  errorDetails,
                  title: aborted ? hostnameOf(formattedUrl) : "Error - " + hostnameOf(formattedUrl),
                  isSecure: false,
                }
              : tab,
          ),
        )
      }
    },
    [releaseBlob],
  )

  /** Inserts a new tab after the active one, makes it active, returns its id */
  const createTab = useCallback(() => {
    const newTab = blankTab()
    setTabs((prev) => {
      const activeIndex = prev.findIndex((tab) => tab.isActive)
      const next = prev.map((tab) => ({ ...tab, isActive: false }))
      next.splice(activeIndex + 1, 0, newTab)
      return next
    })
    return newTab.id
  }, [])

  const addTab = () => {
    createTab()
    setTimeout(() => addressBarRef.current?.focus(), 0)
  }

  const openInNewTab = useCallback(
    (url: string, request: NavRequest = {}) => {
      const id = createTab()
      navigate(id, url, "push", request)
    },
    [createTab, navigate],
  )

  const closeTab = (tabId: string) => {
    if (tabs.length <= 1) return
    cancelLoad(tabId)
    releaseBlob(tabId)

    setTabs((prev) => {
      if (prev.length <= 1) return prev
      const index = prev.findIndex((tab) => tab.id === tabId)
      if (index === -1) return prev
      const wasActive = prev[index].isActive
      const next = prev.filter((tab) => tab.id !== tabId)
      if (!wasActive) return next
      const nextActive = Math.min(index, next.length - 1)
      return next.map((tab, i) => ({ ...tab, isActive: i === nextActive }))
    })
  }

  const switchTab = (tabId: string) => {
    setTabs((prev) => prev.map((tab) => ({ ...tab, isActive: tab.id === tabId })))
  }

  // Restored (or never-loaded) tabs have a URL but no content: load them when shown
  useEffect(() => {
    const tab = tabs.find((t) => t.isActive)
    if (tab && tab.url && tab.content === undefined && !tab.frameSrc && !tab.isLoading && !tab.error) {
      navigate(tab.id, tab.url, reloadMode(tab))
    }
  }, [tabs, navigate])

  // Links, forms and script-driven navigation inside the proxied page ask the app to navigate
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== "object") return
      if (data.type !== "proxy-navigate" && data.type !== "proxy-url-change") return
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return
      const tabId = activeTabIdRef.current
      if (!tabId) return

      // location.reload() inside the page
      if (data.type === "proxy-navigate" && data.reload) {
        const tab = tabsRef.current.find((t) => t.id === tabId)
        if (tab?.url) navigate(tab.id, tab.url, reloadMode(tab))
        return
      }

      if (typeof data.url !== "string" || !/^https?:\/\//i.test(data.url)) return
      const url: string = data.url

      // history.pushState/replaceState: the page changed its own URL without reloading
      if (data.type === "proxy-url-change") {
        setTabs((prev) =>
          prev.map((tab) => {
            if (tab.id !== tabId || tab.url === url) return tab
            let history = tab.history
            let historyIndex = tab.historyIndex
            if (data.replace && historyIndex >= 0) {
              history = [...tab.history]
              history[historyIndex] = url
            } else {
              history = [...tab.history.slice(0, historyIndex + 1), url]
              historyIndex = history.length - 1
            }
            return { ...tab, url, history, historyIndex, isSecure: url.startsWith("https://") }
          }),
        )
        return
      }

      const request: NavRequest =
        data.method === "POST" ? { method: "POST", body: typeof data.body === "string" ? data.body : "" } : {}

      if (data.newTab) {
        openInNewTab(url, request)
      } else {
        navigate(tabId, url, data.replace ? "replace" : "push", request)
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [navigate, openInNewTab])

  // Fallback for navigations the in-page script couldn't cancel (older browsers
  // without the Navigation API): if the frame no longer holds a page written by
  // us, it has left the proxy and is loading straight from the site.
  const handleFrameLoad = (tabId: string) => (event: React.SyntheticEvent<HTMLIFrameElement>) => {
    const frame = event.currentTarget
    let ours = false
    try {
      ours = Boolean((frame.contentWindow as (Window & { __devonProxied?: boolean }) | null)?.__devonProxied)
    } catch {
      ours = false // cross-origin: definitely not ours
    }
    const leftProxy = !ours
    setTabs((prev) =>
      prev.map((tab) => (tab.id === tabId && Boolean(tab.leftProxy) !== leftProxy ? { ...tab, leftProxy } : tab)),
    )
  }

  const navigateActive = (url: string) => {
    if (activeTab) navigate(activeTab.id, url, "push")
  }

  const goBack = () => {
    if (!activeTab || activeTab.historyIndex <= 0) return
    const index = activeTab.historyIndex - 1
    navigate(activeTab.id, activeTab.history[index], { index })
  }

  const goForward = () => {
    if (!activeTab || activeTab.historyIndex >= activeTab.history.length - 1) return
    const index = activeTab.historyIndex + 1
    navigate(activeTab.id, activeTab.history[index], { index })
  }

  const refresh = () => {
    if (!activeTab?.url) return
    navigate(activeTab.id, activeTab.url, reloadMode(activeTab))
  }

  const retry = () => {
    if (!activeTab) return
    const url = activeTab.url || currentUrl
    navigate(activeTab.id, url, url === activeTab.url ? reloadMode(activeTab) : "push")
  }

  const stopLoading = () => {
    if (activeTab) controllersRef.current.get(activeTab.id)?.abort()
  }

  const goHome = () => {
    if (!activeTab) return
    cancelLoad(activeTab.id)
    releaseBlob(activeTab.id)
    setTabs((prev) =>
      prev.map((tab) =>
        tab.isActive
          ? {
              ...tab,
              url: "",
              title: "New Tab",
              isLoading: false,
              favicon: undefined,
              content: undefined,
              frameSrc: undefined,
              frameType: undefined,
              error: undefined,
              errorDetails: undefined,
              isSecure: undefined,
            }
          : tab,
      ),
    )
  }

  const clearBrowsingData = () => {
    if (confirm("Are you sure you want to clear all browsing data? This cannot be undone.")) {
      controllersRef.current.forEach((c) => c.abort())
      controllersRef.current.clear()
      blobUrlsRef.current.forEach((u) => URL.revokeObjectURL(u))
      blobUrlsRef.current.clear()
      SessionManager.clearAllData()
      setTabs([blankTab()])
      setShowMenu(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && activeTab) {
      navigate(activeTab.id, currentUrl, "push")
    }
  }

  // Keyboard shortcuts. The handler lives in a ref so the listener always sees current state.
  const shortcutHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {})
  shortcutHandlerRef.current = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase()
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      switch (key) {
        case "t":
          e.preventDefault()
          addTab()
          break
        case "w":
          e.preventDefault()
          if (activeTab) closeTab(activeTab.id)
          break
        case "r":
          e.preventDefault()
          refresh()
          break
        case "l":
          e.preventDefault()
          addressBarRef.current?.focus()
          addressBarRef.current?.select()
          break
        case "d":
          e.preventDefault()
          setShowBookmarks((prev) => !prev)
          break
      }
    }

    // Alt + Arrow keys for navigation
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      if (e.key === "ArrowLeft") {
        e.preventDefault()
        goBack()
      } else if (e.key === "ArrowRight") {
        e.preventDefault()
        goForward()
      }
    }
  }

  useEffect(() => {
    const listener = (e: KeyboardEvent) => shortcutHandlerRef.current(e)
    window.addEventListener("keydown", listener)
    return () => window.removeEventListener("keydown", listener)
  }, [])

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Tab Bar */}
      <div className="flex items-center bg-card border-b border-border px-2 py-1">
        <div className="flex flex-1 overflow-x-auto scrollbar-hide">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`
                flex items-center gap-2 px-4 py-2 min-w-[200px] max-w-[250px] 
                border-r border-border cursor-pointer group relative
                ${
                  tab.isActive
                    ? "bg-background text-foreground shadow-sm"
                    : "bg-muted text-muted-foreground hover:bg-background/50"
                }
              `}
              onClick={() => switchTab(tab.id)}
            >
              {tab.isLoading ? (
                <Loader2 className="w-4 h-4 flex-shrink-0 animate-spin" />
              ) : tab.favicon ? (
                <img src={tab.favicon} alt="" className="w-4 h-4 flex-shrink-0" />
              ) : (
                <Globe className="w-4 h-4 flex-shrink-0" />
              )}
              <span className="truncate text-sm font-medium">{tab.title || "New Tab"}</span>
              {tabs.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-5 h-5 p-0 opacity-0 group-hover:opacity-100 hover:bg-destructive hover:text-destructive-foreground transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(tab.id)
                  }}
                >
                  <X className="w-3 h-3" />
                </Button>
              )}
            </div>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={addTab}
          className="ml-2 hover:bg-accent hover:text-accent-foreground"
          title="New Tab (Ctrl+T)"
        >
          <Plus className="w-4 h-4" />
        </Button>
      </div>

      {/* Navigation Bar */}
      <div className="flex items-center gap-2 p-3 bg-card border-b border-border relative">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
            onClick={goBack}
            disabled={!activeTab || activeTab.historyIndex <= 0}
            title="Back (Alt+←)"
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
            onClick={goForward}
            disabled={!activeTab || activeTab.historyIndex >= activeTab.history.length - 1}
            title="Forward (Alt+→)"
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
          {activeTab?.isLoading ? (
            <Button
              variant="ghost"
              size="sm"
              className="hover:bg-accent hover:text-accent-foreground"
              onClick={stopLoading}
              title="Stop Loading"
            >
              <StopCircle className="w-4 h-4" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
              onClick={refresh}
              disabled={!activeTab?.url}
              title="Refresh (Ctrl+R)"
            >
              <RotateCcw className="w-4 h-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="hover:bg-accent hover:text-accent-foreground"
            onClick={goHome}
            title="Home"
          >
            <Home className="w-4 h-4" />
          </Button>
        </div>

        <div className="flex-1 max-w-2xl flex items-center gap-2">
          {activeTab?.url && (
            <div className="flex items-center">
              {activeTab.isSecure ? (
                <span title="Secure Connection">
                  <Shield className="w-4 h-4 text-green-600" />
                </span>
              ) : (
                <span title="Not Secure">
                  <ShieldAlert className="w-4 h-4 text-amber-600" />
                </span>
              )}
            </div>
          )}
          <Input
            ref={addressBarRef}
            value={currentUrl}
            onChange={(e) => setCurrentUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={(e) => e.target.select()}
            placeholder="Enter URL or search... (Ctrl+L to focus)"
            className="w-full bg-input border-border focus:ring-ring focus:border-primary"
          />
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="hover:bg-accent hover:text-accent-foreground"
            onClick={() => setShowBookmarks(!showBookmarks)}
            title="Bookmarks (Ctrl+D)"
          >
            <Star className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="hover:bg-accent hover:text-accent-foreground"
            onClick={() => setShowMenu(!showMenu)}
            title="Menu"
          >
            <Menu className="w-4 h-4" />
          </Button>
        </div>

        {/* Bookmarks Panel */}
        <BookmarksPanel
          isOpen={showBookmarks}
          onClose={() => setShowBookmarks(false)}
          onNavigate={navigateActive}
          currentUrl={activeTab?.url}
          currentTitle={activeTab?.title}
          currentFavicon={activeTab?.favicon}
        />

        {/* Menu Panel */}
        {showMenu && (
          <Card className="absolute top-full right-0 z-50 mt-1 bg-card border border-border shadow-lg min-w-48">
            <div className="p-2">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  // TODO: Implement history panel
                  setShowMenu(false)
                }}
              >
                <History className="w-4 h-4 mr-2" />
                History
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  // TODO: Implement downloads panel
                  setShowMenu(false)
                }}
              >
                <Download className="w-4 h-4 mr-2" />
                Downloads
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  // TODO: Implement settings panel
                  setShowMenu(false)
                }}
              >
                <Settings className="w-4 h-4 mr-2" />
                Settings
              </Button>
              <hr className="my-2 border-border" />
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-destructive hover:text-destructive"
                onClick={clearBrowsingData}
              >
                Clear Browsing Data
              </Button>
            </div>
          </Card>
        )}
      </div>

      {/* Browser Content Area */}
      <div className="flex-1 flex flex-col min-h-0 bg-background overflow-hidden">
        {activeTab?.leftProxy && activeTab.content !== undefined && (
          <div className="flex items-center gap-3 px-3 py-2 text-sm border-b border-border bg-amber-500/10 text-amber-700 dark:text-amber-400">
            <ShieldAlert className="w-4 h-4 flex-shrink-0" />
            <span className="flex-1">
              This page navigated in a way Devon couldn&apos;t intercept, so it&apos;s now loading directly from the
              site instead of through the proxy.
            </span>
            <Button size="sm" variant="outline" onClick={refresh}>
              Reload through proxy
            </Button>
          </div>
        )}
        {activeTab?.content !== undefined ? (
          <ProxiedFrame
            key={`${activeTab.id}:${activeTab.loadId}`}
            html={activeTab.content}
            title={activeTab.title}
            frameRef={iframeRef}
            onLoad={handleFrameLoad(activeTab.id)}
          />
        ) : activeTab?.frameSrc ? (
          // Non-HTML responses: PDFs need an unsandboxed frame for the built-in viewer;
          // everything else (images, SVG, text) is shown with scripts disabled
          <iframe
            key={`${activeTab.id}-file`}
            src={activeTab.frameSrc}
            className="w-full flex-1 min-h-0 border-0 bg-white"
            title={activeTab.title}
            {...(activeTab.frameType?.includes("pdf") ? {} : { sandbox: "allow-downloads" })}
          />
        ) : activeTab?.error ? (
          <Card className="flex-1 m-4 p-6 bg-card overflow-auto">
            <div className="text-center text-destructive max-w-2xl mx-auto">
              <AlertCircle className="w-16 h-16 mx-auto mb-4" />
              <h3 className="text-lg font-semibold mb-2">
                {activeTab.error === STOPPED_MESSAGE ? "Loading Stopped" : "Failed to Load Page"}
              </h3>
              <p className="text-sm mb-4 text-foreground/80">{activeTab.error}</p>
              {activeTab.errorDetails && (
                <details className="text-left mb-4">
                  <summary className="cursor-pointer text-sm font-mono text-muted-foreground hover:text-foreground">
                    View technical details
                  </summary>
                  <pre className="mt-2 p-4 bg-muted rounded text-xs overflow-auto max-h-48 text-muted-foreground">
                    {activeTab.errorDetails}
                  </pre>
                </details>
              )}
              {activeTab.error !== STOPPED_MESSAGE && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">Common issues:</p>
                <ul className="text-xs text-left list-disc list-inside space-y-1 text-muted-foreground">
                  <li>The website may be blocking proxy access (Cloudflare, bot protection)</li>
                  <li>The website may be temporarily unavailable</li>
                  <li>There may be a network connectivity issue</li>
                  <li>The URL may be incorrect or the page may not exist</li>
                </ul>
              </div>
              )}
              <div className="flex gap-2 justify-center mt-6">
                <Button onClick={retry} variant="default">
                  Try Again
                </Button>
                <Button onClick={goHome} variant="outline">
                  Go Home
                </Button>
              </div>
            </div>
          </Card>
        ) : activeTab?.url ? (
          <Card className="flex-1 m-4 p-6 bg-card">
            <div className="text-center text-muted-foreground">
              <Loader2 className="w-16 h-16 mx-auto mb-4 animate-spin" />
              <h3 className="text-lg font-semibold mb-2">Loading...</h3>
              <p className="text-sm">
                Fetching: <span className="font-mono text-primary">{activeTab.url}</span>
              </p>
            </div>
          </Card>
        ) : (
          <Card className="flex-1 m-4 p-6 bg-card">
            <div className="text-center text-muted-foreground">
              <Globe className="w-16 h-16 mx-auto mb-4 opacity-50" />
              <h3 className="text-lg font-semibold mb-2">Welcome to Devon Browser</h3>
              <p className="text-sm mb-4">Enter a URL in the address bar to get started</p>
              <div className="text-xs opacity-75 space-y-1">
                <p>
                  <kbd className="px-2 py-1 bg-muted rounded text-xs">Ctrl+T</kbd> New Tab
                </p>
                <p>
                  <kbd className="px-2 py-1 bg-muted rounded text-xs">Ctrl+W</kbd> Close Tab
                </p>
                <p>
                  <kbd className="px-2 py-1 bg-muted rounded text-xs">Ctrl+R</kbd> Refresh
                </p>
                <p>
                  <kbd className="px-2 py-1 bg-muted rounded text-xs">Ctrl+L</kbd> Focus Address Bar
                </p>
                <p>
                  <kbd className="px-2 py-1 bg-muted rounded text-xs">Ctrl+D</kbd> Bookmarks
                </p>
                <p>
                  <kbd className="px-2 py-1 bg-muted rounded text-xs">Alt+←/→</kbd> Back/Forward
                </p>
              </div>
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}
