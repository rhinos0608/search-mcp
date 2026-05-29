# Browser Modes

The `browser` tool family supports three modes selected via `BROWSER_MODE` (default: `user`).

| Mode | `BROWSER_MODE` | Launch | Use case |
|------|---------------|--------|----------|
| **User** | `user` | Connects to an existing browser via CDP | Persistent profiles, logged-in sessions, manual setup |
| **Stealth** | `stealth` | Launches ephemeral Playwright with anti-detection patches | Automated scraping, bot-deterrent bypass |
| **Profile** | `profile` | Launches Playwright with a persistent profile directory | Reusable sessions across restarts |

## Security & Behaviour

- **User mode**: No browser launched — connects to a running browser at `BROWSER_CDP_ENDPOINT` or `ws://127.0.0.1:9222`. You manage the browser lifecycle.
- **Stealth mode**: Launches a fresh ephemeral browser each session. Applies CDP stealth patches (`BROWSER_STEALTH_ENABLED`) and optional CloakBrowser fingerprinting. No cookies or state persist.
- **Profile mode**: Like stealth but uses a profile directory (`BROWSER_PROFILE_DIR`). Sessions survive restarts.

## Migration from Stealth

The default mode changed from `stealth` to `user` in v5.x. If your workflow relies on automated scraping:

1. Set `BROWSER_MODE=stealth` explicitly:
   ```bash
   export BROWSER_MODE=stealth
   ```
2. Or in `config.json`:
   ```json
   {
     "browser": {
       "mode": "stealth",
       "stealthEnabled": true
     }
   }
   ```

For headless operation, keep `BROWSER_HEADLESS=true` (default). Stealth mode works headless by default.

**Important**: Switching from stealth to user mode means the MCP server no longer launches a browser. You must start Chrome/Chromium manually with `--remote-debugging-port=9222` for user mode to function.

## Example: User Mode

```bash
# 1. Start Chrome manually
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222

# 2. Run search-mcp (auto-connects to ws://127.0.0.1:9222)
BROWSER_MODE=user BROWSER_AUTO_CONNECT=true npm start
```

## Example: Stealth Mode

```bash
BROWSER_MODE=stealth npm start
```
