# monitor

Single-file prod monitor managed by pm2. Six responsibilities in one process:

1. **Discord alarm** — webhook on crash, health failure, or recovery
2. **Healthcheck polling** — Docker socket `/containers/{name}/json` every 60s
3. **Docker event capture** — `die`/`kill`/`oom` events via Docker event stream
4. **Log server** — read-only HTTP API backed by `journalctl` (systemd-journald)
5. **Docker stats polling** — memory + CPU + network I/O + block I/O + PIDs sampled from Docker socket every 1s, with tiered retention in a segmented on-disk store; `MEMORY_PRESSURE` early-warning alarm before OOM
6. **Frontend** — static dashboard (`frontend.html`) served at `/`, with cookie login (see below)

## Setup

```bash
cp .env.example .env
# edit .env — set DISCORD_ALARM_WEBHOOK, LOG_SERVER_TOKEN, MONITOR_PROJECT

pm2 start ecosystem.config.js
pm2 save
```

`ecosystem.config.js` loads `.env` itself (no `source .env` step, no extra dependency) — pm2 never reads `.env` on its own. A variable set in the shell wins over `.env`. After editing `.env`, restart by naming the config file so it is re-read: `pm2 restart ecosystem.config.js`, then `pm2 save`. A restart by process name (`pm2 restart monitor`) does not re-read `.env`, and neither does a reboot resurrect until the next config-file restart. Two variables the app reads directly — `STATS_DATA_DIR` and `JOURNALCTL_TIMEOUT_MS` — apply on a fresh start; to refresh them after an edit, restart the pm2 daemon (`pm2 kill`, then `pm2 start ecosystem.config.js`) or export them in the shell and restart with `--update-env`.

No install step needed — `monitor.js` is plain Node.js with no dependencies.

## Log source: systemd-journald

Container logs are read from the host's systemd journal. Monitored containers must ship stdout to journald via the `journald` docker log driver:

```yaml
services:
  hoie-inbox:
    logging:
      driver: journald
      options:
        tag: "hoie-inbox"
```

The log server queries `journalctl CONTAINER_NAME=<name> -n <tail> --output=cat --no-pager`. Retention is host-side, configured in `/etc/systemd/journald.conf`:

```
Storage=persistent
SystemMaxUse=2G
MaxRetentionSec=30day
```

`systemctl restart systemd-journald` to apply. If `/var/log/journal/` doesn't exist the journal is in-memory only — `mkdir -p /var/log/journal && systemctl restart systemd-journald`.

The user running monitor (via pm2) needs read access to the journal — either run as `root` or add the user to the `systemd-journal` group: `sudo usermod -aG systemd-journal <user>` then relogin.

## HTTP API

| Endpoint | Auth | Description |
|---|---|---|
| `GET /health` | none | Server health + monitored container states |
| `GET /` | none | Static frontend dashboard (`frontend.html`); the page itself carries no data |
| `GET /frontend.html` | none | Same dashboard file, direct path |
| `POST /login` | token in body | Exchange `LOG_SERVER_TOKEN` for a session cookie (see Frontend) |
| `POST /logout` | session cookie | Drop the session and clear the cookie |
| `GET /containers` | Bearer token or session cookie | List running containers |
| `GET /logs/:container` | Bearer token or session cookie | Last 100 log lines |
| `GET /logs/:container?tail=500` | Bearer token or session cookie | Configurable tail |
| `GET /stats` | Bearer token or session cookie | Latest stats sample per monitored container (no history) + `host_cpus`, for the dashboard overview. Containers with no sample yet report `latest: null`. |
| `GET /stats/:container` | Bearer token or session cookie | Tiered history of Docker stats for a window: `?span=<seconds>&end=<ISO>` (defaults: last hour ending now). The span picks the resolution — see the window table below — and each point carries average, min, and max over its window. The response also carries `latest` (the newest sample), `host_cpus`, `poll_interval_ms`, and `pressure_threshold_ratio`. |

Auth: `Authorization: Bearer $LOG_SERVER_TOKEN`, or the session cookie set by `POST /login`.

### Stats fields

History points (`history[]` in `GET /stats/:container`) carry average, min, and max per metric over the point's window (field names `<metric>_avg` / `<metric>_min` / `<metric>_max`), plus `ts`, `resolution_ms`, and `count` (raw samples represented). Metrics:

| Metric prefix | Meaning |
|---|---|
| `usage`, `working_set`, `anon`, `file`, `inactive_file`, `limit` | Memory bytes (working set = usage minus inactive file cache, as `docker stats` reports MEM USAGE) |
| `usage_ratio` | Working set / limit, `null` when the container has no explicit memory cap |
| `cpu` | CPU % (nominal single-core %, Docker's `docker stats` calculation) |
| `net_rx_bytes_per_sec`, `net_tx_bytes_per_sec` | Network receive / transmit rate, bytes/s, summed across interfaces |
| `net_rx_packets_per_sec`, `net_tx_packets_per_sec` | Network receive / transmit rate, packets/s, summed across interfaces |
| `blk_read_bytes_per_sec`, `blk_write_bytes_per_sec` | Block I/O read / write rate, bytes/s (`io_service_bytes_recursive` Read/Write ops only) |
| `pids_current` | Process/thread count (`pids_stats.current`) |

Network and block I/O arrive from Docker as cumulative counters. History stores the per-second rates derived from the delta between consecutive 1s polls, so the rollup average/min/max are rates; the cumulative totals are latest-only, in `latest` as `net_rx_bytes_total`, `net_tx_bytes_total`, `blk_read_bytes_total`, `blk_write_bytes_total`. Rates are `null` on the first poll, when Docker omits the counter, or when a counter resets (container recreate) — never negative. A metric Docker doesn't report reads as gaps in the charts, never as zero.

Segments written before the network/block/PID fields existed have no values for them; those windows read back with the new metrics as gaps until new samples accumulate.

### Window options and tiers

The dashboard window picker offers 1m, 10m, 30m, 1h, 3h, 6h, 12h, 1d, 3d, 1w, 2w, 1-month (30d), 3-month (90d), 6-month (180d), 1y (365d), and 3y (1095d). The server picks the tier by span so every window yields at least ~60 points: 1s points up to a 30-minute span, 1min up to 1 day, 1h up to 30 days, 1d up to 1 year, 1wk beyond that. The 10s and 30s tiers still exist as rollup steps feeding the 1min tier; no query reads them directly. The `span` parameter itself accepts any positive seconds (clamped to 3 years); `end` accepts an ISO timestamp (defaults to now, clamped to now).

## Frontend

Open `/` in a browser. Log in with the existing `LOG_SERVER_TOKEN` — the same token the API accepts as a Bearer token. On success the server sets an `HttpOnly` session cookie (`monitor_session`) valid for 1 day, refreshed to a fresh 1 day on every authenticated request (sliding expiry: the session only lapses after a full day with no requests). The dashboard then shows running containers with health states, per-container memory/CPU stats with CPU and memory history graphs, and log tails (configurable tail + optional `since` window, same parameters as the API), auto-refreshing every 30s. Log out with the button in the header.

With no container selected, the dashboard shows an overview: two donut graphs — CPU and memory (working set) — refreshed every second from `GET /stats`. Each ring breaks the total down by container (slices sized by each container's share of the total); the ring's *thickness* encodes total usage against the cap — 32px at or above the cap, thinner below it (25% of cap is ~8px, floored at ~3px so small usage stays visible) — over a grey track ring at the full 32px underneath. CPU capacity is host capacity (from `host_cpus`); memory capacity is the summed explicit caps, when every container has one — with any uncapped container the cap is unknown and the ring stays at full thickness. The centre shows the total CPU % (plus the share of host capacity, from `host_cpus`) or total working-set bytes (plus the ratio against the summed explicit memory caps, when any container has one). Click a container card to open its detail view (click it again, or **Show all**, to return to the overview).

The detail view's history graphs cover CPU, memory, network I/O (RX/TX rates), block I/O (read/write rates), and PIDs, each with the per-point min/max shaded band around the line. The **Line** selector chooses which per-window statistic the line shows (Average, Min, or Max); the band always spans min–max. The **Window** picker offers the spans listed in the API section above, with an optional **End** time (empty = live). Hovering a chart highlights the point at that time and shows a label with the point's canonical (ISO) timestamp and the average, min, and max values for each series on that chart.

The token itself is never stored in the browser: the page sends it once in the login POST body, and afterwards the browser only presents the opaque session id. API clients are unaffected — Bearer auth keeps working exactly as before.

## Building

Write code in `src/monitor.ts`, then compile it to `monitor.js` and commit both. `monitor.js` is the only thing pm2 runs — there is no build step on the server; deploy is `git pull`, then with the config file (so `.env` is re-read) `pm2 restart ecosystem.config.js`, then `pm2 save`. `frontend.html` ships in the repo next to `monitor.js` and is read from disk per request, so a pull updates the dashboard with no restart.

```bash
# TypeScript and the Node type declarations are build-time tools only
# (never committed, never installed on the server). Install once:
npm install -g typescript @types/node

# Then, from the repo root:
tsc src/monitor.ts --outDir /tmp/monitor-out --module commonjs --target es2022 --esModuleInterop --skipLibCheck --typeRoots "$(npm root -g)/@types"
cp /tmp/monitor-out/monitor.js ./monitor.js
```

Never edit `monitor.js` by hand — it is generated output.

Stats are polled from the Docker socket (`/containers/{name}/stats?stream=false`), so they reflect cgroup-derived memory + CPU exactly the way `docker stats` does. The same poll also captures network I/O (`networks`, summed across interfaces), block I/O (`blkio_stats.io_service_bytes_recursive`, Read/Write ops), and the process count (`pids_stats.current`); network and block I/O are stored as per-second rates derived from consecutive polls (see Stats fields above). Memory pressure is measured on the working set — `memory_stats.usage` minus inactive file cache (`inactive_file` on cgroup v2, `total_inactive_file` on v1), the figure `docker stats` shows as MEM USAGE — because the kernel reclaims that cache before it OOM-kills. A `MEMORY_PRESSURE` alarm fires to Discord when a container's working set / `memory_stats.limit` stays above `MEMORY_PRESSURE_RATIO` for `MEMORY_PRESSURE_SUSTAINED_MS` — early warning before the kernel OOM-kills the container. Only fires when the container has an explicit `--memory` / `mem_limit` set (no explicit limit → the "limit" Docker reports is host RAM, making the ratio uninformative).

Retention is tiered and cascading: every 1s sample feeds the 10s buckets, each finalized bucket feeds the next tier up, and every tier keeps the average, min, and max per metric over its window (a 1min point aggregates six 10s points via two 30s points — count-weighted, so the average is exact, and min-of-mins / max-of-maxes are exact too). Raw 1s samples are kept for `STATS_RAW_RETENTION_DAYS` (default 30); rollups are kept longer — 10s for 90 days, 30s and 1min for 1 year, 1h, 1d, and 1wk for 3 years. Storage is a segmented append-only store under `STATS_DATA_DIR` (default `stats-data/` next to `monitor.js`, gitignored): one JSON-lines file per container per hour (per day for the 1h/1d/1wk tiers), gzipped once the period closes, pruned by a daily sweep. A query reads only the segments overlapping its window, so a 1-minute query reads a single hour-file instead of scanning the retained millions. Measured: ~0.75 GiB gzipped for 7 containers at the default retentions. On restart, open buckets are rebuilt from the tier below and windows that fully elapsed while down are finalized from the persisted samples and points below them, so only a window with no surviving children stays a gap; a missing or corrupt segment line is skipped, never fatal.

## Environment Variables

Values come from `.env` (loaded by `ecosystem.config.js`) or from the shell; a variable set in the shell wins over `.env`. See Setup for how `.env` edits take effect.

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_ALARM_WEBHOOK` | yes | — | Discord webhook URL |
| `LOG_SERVER_TOKEN` | yes | — | Bearer token for log API |
| `MONITOR_PROJECT` | one of these two | — | Compose project name; every service container of the project is monitored, rediscovered before each poll (one-off `compose run` containers excluded) |
| `MONITOR_TARGETS` | one of these two | — | Comma-separated container names; ignored when `MONITOR_PROJECT` is set |
| `LOG_PORT` | no | `9000` | Log server port |
| `HEALTH_POLL_INTERVAL_MS` | no | `60000` | Health poll interval |
| `HEALTH_FAIL_THRESHOLD` | no | `1` | Failures before alarm |
| `ALARM_COOLDOWN_MS` | no | `60000` | Cooldown between same alarms |
| `DOCKER_SOCKET` | no | `/var/run/docker.sock` | Docker socket path (healthcheck + event stream + stats poll) |
| `JOURNALCTL_BIN` | no | `journalctl` | Path to `journalctl`; override if not on `$PATH` |
| `STATS_POLL_INTERVAL_MS` | no | `1000` | Docker stats poll interval per container (1s base for tiered retention) |
| `JOURNALCTL_TIMEOUT_MS` | no | `15000` | Hard-kill `journalctl` if it hangs |
| `STATS_DATA_DIR` | no | `stats-data` (next to `monitor.js`) | Segmented stats store root (raw + rollup segments) |
| `STATS_RAW_RETENTION_DAYS` | no | `30` | Days of raw 1-second samples kept (rollup tiers keep 90d–3y) |
| `MEMORY_PRESSURE_RATIO` | no | `0.85` | Alarm when `working set / limit` ≥ this ratio |
| `MEMORY_PRESSURE_SUSTAINED_MS` | no | `180000` | Sustained wall-clock ms above the ratio before alarming |

## Design Doc

https://doc.hoie.kim/s/moltboie/p/prod-monitoring-HRzq5Krhlg
