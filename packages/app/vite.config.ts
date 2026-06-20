import { defineConfig } from "vite"
import desktopPlugin from "./vite"

const API_TARGET = `http://localhost:${process.env.VITE_OPENCODE_SERVER_PORT ?? 5050}`

const apiRoutes = [
  "/global",
  "/session",
  "/project",
  "/config",
  "/provider",
  "/permission",
  "/question",
  "/pty",
  "/mcp",
  "/tui",
  "/experimental",
  "/launcher",
  "/file",
  "/find",
  "/agent",
  "/skill",
  "/command",
  "/path",
  "/vcs",
  "/log",
  "/doc",
  "/instance",
  "/event",
  "/auth",
  "/lsp",
  "/formatter",
]

const proxy = Object.fromEntries(
  apiRoutes.map((route) => [
    route,
    {
      target: API_TARGET,
      changeOrigin: true,
      ws: true,
    },
  ]),
)

export default defineConfig({
  plugins: [desktopPlugin] as any,
  appType: "spa",
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
    proxy,
    hmr: {
      // When proxied, HMR WebSocket needs to connect directly to Vite
      clientPort: 3000,
    },
  },
  build: {
    target: "esnext",
    // sourcemap: true,
  },
})
