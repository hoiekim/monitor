# monitor

Single-file prod monitor managed by pm2. Four responsibilities in one process:

1. **Discord alarm** — webhook on crash, health failure, or recovery
2. **Healthcheck polling** — Docker socket `/containers/{name}/json` every 60s
3. **Docker event capture** — `die`/`kill`/`oom` events via Docker event stream
4. **Log server** — read-only HTTP API backed by Docker socket

## Setup

```bash
cp .env.example .env
# edit .env — set DISCORD_ALARM_WEBHOOK, LOG_SERVER_TOKEN, MONITOR_TARGETS

pm2 start ecosystem.config.js
pm2 save
```

No install step needed — `monitor.js` is plain Node.js with no dependencies.

## Log Server API

| Endpoint | Auth | Description |
|---|---|---|
| `GET /health` | none | Server health + monitored container states |
| `GET /containers` | Bearer token | List running containers |
| `GET /logs/:container` | Bearer token | Last 100 log lines |
| `GET /logs/:container?tail=500` | Bearer token | Configurable tail |

Auth: `Authorization: Bearer $LOG_SERVER_TOKEN`

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_ALARM_WEBHOOK` | yes | — | Discord webhook URL |
| `LOG_SERVER_TOKEN` | yes | — | Bearer token for log API |
| `MONITOR_TARGETS` | yes | — | Comma-separated container names |
| `LOG_PORT` | no | `9000` | Log server port |
| `HEALTH_POLL_INTERVAL_MS` | no | `60000` | Health poll interval |
| `HEALTH_FAIL_THRESHOLD` | no | `1` | Failures before alarm |
| `ALARM_COOLDOWN_MS` | no | `60000` | Cooldown between same alarms |
| `DOCKER_SOCKET` | no | `/var/run/docker.sock` | Docker socket path |

## Design Doc

https://doc.hoie.kim/s/moltboie/p/prod-monitoring-HRzq5Krhlg
