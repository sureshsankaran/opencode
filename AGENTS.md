- To test opencode in `packages/opencode`, run `bun dev`.
- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `dev`.

## Development Server (macOS)

**IMPORTANT: Always use launchctl to start/stop the development servers. Do NOT run vite preview or the API server manually.**

Two launchctl services power the development environment:

### 1. Vite Preview Server (Web UI) — port 3000

Serves the pre-built web app at `http://localhost:3000`.

```bash
# Start
launchctl load ~/Library/LaunchAgents/com.opencode.headless.plist

# Stop
launchctl unload ~/Library/LaunchAgents/com.opencode.headless.plist

# View logs
tail -f /tmp/opencode-headless.log
tail -f /tmp/opencode-headless.err
```

After changing frontend code, rebuild before the server picks up changes:

```bash
bun run build --filter=@opencode-ai/app
```

### 2. OpenCode API Server (Backend) — port 5050

Serves the headless API that the web UI connects to.

```bash
# Start
launchctl load ~/Library/LaunchAgents/com.opencode.server.simple.plist

# Stop
launchctl unload ~/Library/LaunchAgents/com.opencode.server.simple.plist

# View logs
tail -f /tmp/simple-opencode-server.log
tail -f /tmp/simple-opencode-server.err
```

### Common commands

```bash
# Check status of all opencode services
launchctl list | grep opencode

# Restart a service (stop then start)
launchctl unload ~/Library/LaunchAgents/com.opencode.headless.plist
launchctl load ~/Library/LaunchAgents/com.opencode.headless.plist
```

Both services auto-restart on crash via `KeepAlive`.
