import { Log } from "../util/log"
import { Storage } from "../storage/storage"
import { Session } from "./index"
import { Instance } from "../project/instance"

export namespace SessionCache {
  const log = Log.create({ service: "session-cache" })

  // In-memory cache for session listings
  const cache = new Map<
    string,
    {
      sessions: Session.Info[]
      lastUpdated: number
      lastScanTime: number
    }
  >()

  // Cache TTL in milliseconds (5 minutes)
  const CACHE_TTL = 5 * 60 * 1000

  // Cache warming interval (30 seconds)
  const WARM_INTERVAL = 30 * 1000

  /**
   * Get cached sessions or load them efficiently
   */
  export async function getSessionList(projectID?: string): Promise<Session.Info[]> {
    const id = projectID ?? Instance.project.id
    const now = Date.now()

    // Check if we have a valid cached entry
    const cached = cache.get(id)
    if (cached && now - cached.lastUpdated < CACHE_TTL) {
      log.debug("cache hit", { projectID: id, count: cached.sessions.length })
      return cached.sessions
    }

    log.debug("cache miss, loading sessions", { projectID: id })

    // Load sessions efficiently
    const sessions = await loadSessionsBatch(id)

    // Update cache
    cache.set(id, {
      sessions,
      lastUpdated: now,
      lastScanTime: now,
    })

    log.info("sessions loaded", { projectID: id, count: sessions.length })
    return sessions
  }

  /**
   * Load sessions in batches for better performance
   */
  async function loadSessionsBatch(projectID: string): Promise<Session.Info[]> {
    const startTime = Date.now()

    try {
      // Get all session file paths first (faster than iterating)
      const sessionPaths = await Storage.list(["session", projectID])

      if (sessionPaths.length === 0) {
        return []
      }

      // Batch read sessions to reduce lock contention
      const batchSize = 50 // Process 50 sessions at a time
      const allSessions: Session.Info[] = []

      for (let i = 0; i < sessionPaths.length; i += batchSize) {
        const batch = sessionPaths.slice(i, i + batchSize)

        // Load batch in parallel (but limited concurrency)
        const batchPromises = batch.map(async (path) => {
          try {
            return await Storage.read<Session.Info>(path)
          } catch (e) {
            log.warn("failed to load session", { path, error: e })
            return null
          }
        })

        const batchResults = await Promise.all(batchPromises)

        // Filter out failed loads and add to results
        for (const session of batchResults) {
          if (session) {
            allSessions.push(session)
          }
        }
      }

      // Sort by last updated (most recent first)
      allSessions.sort((a, b) => b.time.updated - a.time.updated)

      const loadTime = Date.now() - startTime
      log.info("batch load completed", {
        projectID,
        count: allSessions.length,
        loadTimeMs: loadTime,
        sessionsPerSecond: Math.round((allSessions.length / loadTime) * 1000),
      })

      return allSessions
    } catch (e) {
      log.error("failed to load sessions", { projectID, error: e })
      return []
    }
  }

  /**
   * Invalidate cache for a specific project
   */
  export function invalidateProject(projectID?: string) {
    const id = projectID ?? Instance.project.id
    cache.delete(id)
    log.debug("cache invalidated", { projectID: id })
  }

  /**
   * Clear entire cache
   */
  export function clearCache() {
    cache.clear()
    log.info("cache cleared")
  }

  /**
   * Get cache statistics
   */
  export function getCacheStats() {
    const stats = {
      entries: cache.size,
      projects: Array.from(cache.keys()),
      totalSessions: Array.from(cache.values()).reduce((sum, entry) => sum + entry.sessions.length, 0),
    }
    return stats
  }

  /**
   * Warm cache by pre-loading sessions for current project
   */
  export async function warmCache(projectID?: string) {
    const id = projectID ?? Instance.project.id
    try {
      await getSessionList(id)
      log.debug("cache warmed", { projectID: id })
    } catch (e) {
      log.warn("cache warming failed", { projectID: id, error: e })
    }
  }

  // Start cache warming interval
  let warmInterval: Timer | null = null

  export function startCacheWarming() {
    if (warmInterval) return

    warmInterval = setInterval(async () => {
      try {
        await warmCache()
      } catch (e) {
        log.warn("cache warming interval failed", { error: e })
      }
    }, WARM_INTERVAL)

    log.info("cache warming started", { intervalMs: WARM_INTERVAL })
  }

  export function stopCacheWarming() {
    if (warmInterval) {
      clearInterval(warmInterval)
      warmInterval = null
      log.info("cache warming stopped")
    }
  }
}
