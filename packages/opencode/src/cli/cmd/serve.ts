import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { SessionCache } from "../../session/cache"
import { Log } from "../../util/log"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = await resolveNetworkOptions(args)

    // Start session cache warming
    SessionCache.startCacheWarming()
    Log.create({ service: "serve" }).info("session cache warming enabled")

    const server = Server.listen(opts)
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    // Warm cache after server starts
    setTimeout(async () => {
      try {
        await SessionCache.warmCache()
        Log.create({ service: "serve" }).info("initial cache warming completed")
      } catch (e) {
        Log.create({ service: "serve" }).warn("initial cache warming failed", { error: e })
      }
    }, 1000) // Wait 1 second for server to be ready

    await new Promise(() => {})

    // Stop cache warming on server shutdown
    SessionCache.stopCacheWarming()
    await server.stop()
  },
})
