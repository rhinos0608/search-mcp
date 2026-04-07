# Self-Hosted Search Engines — Quick Start Guide

Two local, ad-free, privacy-respecting search engines running via Docker.

---

## SearXNG

A mature, privacy-focused meta-search aggregator.

- **URL:** http://localhost:8888
- **Files:** `~/searxng/`
  - `docker-compose.yml` — container config
  - `config/` — settings (auto-generated on first run)
  - `data/` — cache

### Start / Stop

```bash
cd ~/searxng && docker compose up -d      # start
cd ~/searxng && docker compose down       # stop
cd ~/searxng && docker compose logs -f    # view logs
```

### Notes

- Aggregates Startpage, Wikipedia, and many more search engines
- Configure engines, UI, and privacy settings at http://localhost:8888/preferences
- Config file lives at `~/searxng/config/settings.yml` after first run

---

## degoog

A modular search aggregator with a plugin/extension system. Currently in beta.

- **URL:** http://localhost:4444
- **Files:** `~/degoog/`
  - `docker-compose.yml` — container config
  - `data/` — persistent data

### Start / Stop

```bash
cd ~/degoog && docker compose up -d       # start
cd ~/degoog && docker compose down        # stop
cd ~/degoog && docker compose logs -f     # view logs
```

### Plugin System

Access via the gear icon (top right) → Extensions.

**Bang commands** (type in search bar):
| Command | Action |
|---|---|
| `!weather London` | Weather via Open-Meteo |
| `!define word` | Dictionary lookup |
| `!time` | Current time / timezone |
| `!history` | Your local search history |
| `!qr text` | Generate a QR code |
| `!pw` | Generate a password |

**Slot plugins** (auto-render with results):

- TMDb — movie/TV cards
- Math — inline expression evaluator
- GitHub — repo/user info cards
- RSS Feeds — configurable home feed

**Add community extensions:**
Go to Settings → Store → Add a repo URL from [github.com/fccview/fccview-degoog-extensions](https://github.com/fccview/fccview-degoog-extensions)

---

## Managing Both

### Check status

```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

### Stop everything

```bash
cd ~/searxng && docker compose down
cd ~/degoog && docker compose down
```

### Start everything

```bash
cd ~/searxng && docker compose up -d
cd ~/degoog && docker compose up -d
```

### Auto-start

Both containers are configured with `restart: unless-stopped` — they will start automatically whenever Docker Desktop is running.

---

## Update to latest images

```bash
cd ~/searxng && docker compose pull && docker compose up -d
cd ~/degoog && docker compose pull && docker compose up -d
```
