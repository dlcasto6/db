"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Star, StarOff, Trash2, Search, Globe } from "lucide-react"
import { SessionManager, type BookmarkItem } from "@/lib/session-manager"

interface BookmarksPanelProps {
  isOpen: boolean
  onClose: () => void
  onNavigate: (url: string) => void
  currentUrl?: string
  currentTitle?: string
  currentFavicon?: string
}

export function BookmarksPanel({
  isOpen,
  onClose,
  onNavigate,
  currentUrl,
  currentTitle,
  currentFavicon,
}: BookmarksPanelProps) {
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>([])
  const [searchQuery, setSearchQuery] = useState("")

  // Re-read on open so the list reflects changes made elsewhere (e.g. "Clear Browsing Data")
  useEffect(() => {
    if (isOpen) setBookmarks(SessionManager.loadSession().bookmarks)
  }, [isOpen])

  const filteredBookmarks = bookmarks.filter(
    (bookmark) =>
      bookmark.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      bookmark.url.toLowerCase().includes(searchQuery.toLowerCase()),
  )

  const addBookmark = () => {
    if (!currentUrl || !currentTitle) return

    try {
      const newBookmark = SessionManager.addBookmark({
        title: currentTitle,
        url: currentUrl,
        favicon: currentFavicon,
      })
      setBookmarks((prev) => [newBookmark, ...prev])
    } catch (error) {
      console.error("Failed to add bookmark:", error)
    }
  }

  const removeBookmark = (id: string) => {
    SessionManager.removeBookmark(id)
    setBookmarks((prev) => prev.filter((b) => b.id !== id))
  }

  const isCurrentPageBookmarked = currentUrl ? bookmarks.some((b) => b.url === currentUrl) : false

  if (!isOpen) return null

  return (
    <Card className="absolute top-full left-0 right-0 z-50 mt-1 bg-card border border-border shadow-lg">
      <div className="p-4 border-b border-border">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-card-foreground">Bookmarks</h3>
          <div className="flex items-center gap-2">
            {currentUrl && (
              <Button
                variant={isCurrentPageBookmarked ? "default" : "outline"}
                size="sm"
                onClick={isCurrentPageBookmarked ? undefined : addBookmark}
                disabled={isCurrentPageBookmarked}
              >
                {isCurrentPageBookmarked ? <Star className="w-4 h-4 mr-1" /> : <StarOff className="w-4 h-4 mr-1" />}
                {isCurrentPageBookmarked ? "Bookmarked" : "Add Bookmark"}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onClose}>
              ×
            </Button>
          </div>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search bookmarks..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
      </div>

      <ScrollArea className="max-h-80">
        <div className="p-2">
          {filteredBookmarks.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Globe className="w-12 h-12 mx-auto mb-2 opacity-50" />
              <p className="text-sm">{searchQuery ? "No bookmarks found" : "No bookmarks yet"}</p>
              {!searchQuery && <p className="text-xs mt-1">Click the star icon to bookmark pages</p>}
            </div>
          ) : (
            filteredBookmarks.map((bookmark) => (
              <div
                key={bookmark.id}
                className="flex items-center gap-3 p-2 rounded hover:bg-accent cursor-pointer group"
                onClick={() => {
                  onNavigate(bookmark.url)
                  onClose()
                }}
              >
                {bookmark.favicon ? (
                  <img src={bookmark.favicon} alt="" className="w-4 h-4 flex-shrink-0" />
                ) : (
                  <Globe className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{bookmark.title}</p>
                  <p className="text-xs text-muted-foreground truncate">{bookmark.url}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="opacity-0 group-hover:opacity-100 hover:bg-destructive hover:text-destructive-foreground"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeBookmark(bookmark.id)
                  }}
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </Card>
  )
}
