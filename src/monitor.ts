/**
 * monitor.ts — Single-file prod monitor + log server
 *
 * Responsibilities:
 *   1. Discord alarm trigger — webhook on any error/crash/health failure
 *   2. Healthcheck polling — Docker socket, GET /containers/{name}/json every 60s
 *   3. Docker event capture — die/oom events via Docker socket event stream (kill events ignored)
 *   4. Log server — read-only HTTP API backed by systemd-journald
 *   5. Frontend — static dashboard (`frontend.html`) served at `/`, with
 *      cookie login: POST /login exchanges LOG_SERVER_TOKEN for a session
 *      cookie (1-day sliding expiry, refreshed on every transaction).
 *
 * All four run in one process, managed by pm2 on the host.
 *
 * Log-source note: monitored containers are expected to log via the
 * `journald` docker log driver so their history persists across
 * container recreate. journalctl reads by `CONTAINER_NAME=<name>`.
 * See hoiekim/inbox PR #641 for the compose-side setup.
 */

import http from "http";
import https from "https";
import { spawn } from "child_process";
import { appendFileSync, existsSync, mkdirSync, readFile, readFileSync, readdirSync, renameSync, unlink, unlinkSync, writeFile, writeFileSync } from "fs";
import { randomBytes, timingSafeEqual } from "crypto";
import { dirname, isAbsolute, join } from "path";
import { gzip, gzipSync, gunzipSync } from "zlib";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DISCORD_WEBHOOK = process.env.DISCORD_ALARM_WEBHOOK ?? "";
const LOG_SERVER_TOKEN = process.env.LOG_SERVER_TOKEN ?? "";
const MONITOR_PROJECT = (process.env.MONITOR_PROJECT ?? "").trim();
const MONITOR_TARGETS = (process.env.MONITOR_TARGETS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const HEALTH_FAIL_THRESHOLD = parseInt(
  process.env.HEALTH_FAIL_THRESHOLD ?? "1",
  10
);
const HEALTH_POLL_INTERVAL_MS = parseInt(
  process.env.HEALTH_POLL_INTERVAL_MS ?? "60000",
  10
);
const ALARM_COOLDOWN_MS = parseInt(process.env.ALARM_COOLDOWN_MS ?? "60000", 10);
const LOG_PORT = parseInt(process.env.LOG_PORT ?? "9000", 10);
const DOCKER_SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const JOURNALCTL_BIN = process.env.JOURNALCTL_BIN ?? "journalctl";
// 1s base cadence feeding tiered retention (see the stats section): the
// finest tier is 1-second samples, so the poll must run at 1s. The 20s
// default it replaces often missed the pre-death signal the pressure
// alarm exists to catch (typical OOM lead time from 85%→kill is 10-60s).
const STATS_POLL_INTERVAL_MS = parseIntEnv("STATS_POLL_INTERVAL_MS", 1_000);
const MEMORY_PRESSURE_RATIO = parseFloatEnv("MEMORY_PRESSURE_RATIO", 0.85);
// Wall-clock sustained time before the pressure alarm fires (was a poll
// count — 3 polls meant 3 minutes at the old 60s cadence, but 3 seconds
// at 1s polling). 180s preserves the old effective behavior.
const MEMORY_PRESSURE_SUSTAINED_MS = parseIntEnv("MEMORY_PRESSURE_SUSTAINED_MS", 180_000);
// Stats store root: raw 1s segments + per-tier rollup segments, all
// append-only files under one directory (resolved next to the running
// script, like the frontend file). Pruned per tier (see STATS_TIERS).
const STATS_DATA_DIR = (() => {
  const raw = process.env.STATS_DATA_DIR?.trim();
  if (!raw) return join(__dirname, "stats-data");
  return isAbsolute(raw) ? raw : join(__dirname, raw);
})();
// Raw 1-second retention in days (rollup tiers keep their own, longer
// retentions in STATS_TIERS). 30 days ≈ 370 MiB gzipped for 7 containers.
const STATS_RAW_RETENTION_DAYS = parseIntEnv("STATS_RAW_RETENTION_DAYS", 30);
const JOURNALCTL_TIMEOUT_MS = parseIntEnv("JOURNALCTL_TIMEOUT_MS", 15_000);

// Host RAM ceiling. Docker reports `memory_stats.limit` as host total
// when a container has no `--memory` cap; treating that as a real
// limit yields misleading `usage_ratio` values (a 4 GB app on 128 GB
// host reads as 0.03 "healthy"). Read /proc/meminfo once at startup.
const HOST_MEM_TOTAL_BYTES = readHostMemTotalBytes();

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[config] ${name}=${JSON.stringify(raw)} is not a positive int — using default ${fallback}`);
    return fallback;
  }
  return parsed;
}

function parseFloatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(`[config] ${name}=${JSON.stringify(raw)} is not a valid float — using default ${fallback}`);
    return fallback;
  }
  return parsed;
}

function readHostMemTotalBytes(): number {
  try {
    const meminfo = readFileSync("/proc/meminfo", "utf-8");
    const match = /MemTotal:\s+(\d+)\s+kB/.exec(meminfo);
    if (match) return parseInt(match[1], 10) * 1024;
  } catch {
    /* not Linux, or /proc unreadable — fall back to a very large value
       so the "cap unset" guard below never accidentally treats a real
       limit as unlimited. */
  }
  return Number.MAX_SAFE_INTEGER;
}

// A `memory_stats.limit` at or above 90% of host RAM is almost
// certainly Docker reporting "no cap" — a legitimate container-level
// cap is orders of magnitude lower on our hosts. Used by both
// `pollStats` and `/stats` to skip the misleading ratio.
const IS_UNLIMITED = (limit: number | null | undefined): boolean =>
  limit == null || limit <= 0 || limit >= HOST_MEM_TOTAL_BYTES * 0.9;

// ---------------------------------------------------------------------------
// Docker socket helpers
// ---------------------------------------------------------------------------

interface DockerResponse<T = unknown> {
  status: number;
  body: T;
}

function dockerRequest<T = unknown>(
  method: string,
  path: string,
  timeoutMs?: number
): Promise<DockerResponse<T>> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: DOCKER_SOCKET, method, path },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("error", reject);
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as T });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: raw as unknown as T });
          }
        });
      }
    );
    req.on("error", reject);
    if (timeoutMs) {
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    }
    req.end();
  });
}

/** Stream raw bytes from Docker socket into an IncomingMessage-like stream. */
function dockerStream(path: string): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: DOCKER_SOCKET, method: "GET", path },
      resolve
    );
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

const PROJECT_LABEL = "com.docker.compose.project";
const ONEOFF_LABEL = "com.docker.compose.oneoff";
// Every poll waits on the shared lookup, so it must not be able to hang.
const DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Containers being monitored. With `MONITOR_PROJECT` set, every service
 * container of that compose project, rediscovered before each poll so added
 * and removed services are picked up without a restart; otherwise the fixed
 * `MONITOR_TARGETS` list.
 */
let targets: string[] = MONITOR_PROJECT ? [] : MONITOR_TARGETS;

function isProjectService(labels: Record<string, string> | undefined): boolean {
  return labels?.[PROJECT_LABEL] === MONITOR_PROJECT && labels?.[ONEOFF_LABEL] !== "True";
}

let discovered = false;
let refreshing: Promise<void> | null = null;

/** Health and stats polls share one in-flight lookup so an older answer can't overwrite a newer one. */
function refreshTargets(): Promise<void> {
  if (!MONITOR_PROJECT) return Promise.resolve();
  if (!refreshing) {
    refreshing = discoverTargets().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

async function discoverTargets(): Promise<void> {
  // `all` keeps stopped and crashed containers in the set until they are removed.
  const filters = encodeURIComponent(JSON.stringify({ label: [`${PROJECT_LABEL}=${MONITOR_PROJECT}`] }));
  try {
    const { status, body } = await dockerRequest<{ Names?: string[]; Labels?: Record<string, string> }[]>(
      "GET",
      `/containers/json?all=true&filters=${filters}`,
      DISCOVERY_TIMEOUT_MS
    );
    if (status !== 200 || !Array.isArray(body)) {
      console.warn(`[targets] container list failed (${status}); keeping ${targets.length} known targets`);
      return;
    }
    const next = body
      .filter((c) => isProjectService(c.Labels))
      .map((c) => (c.Names?.[0] ?? "").replace(/^\//, ""))
      .filter(Boolean)
      .sort();
    if (discovered && next.join(",") === targets.join(",")) return;
    discovered = true;
    if (next.length) console.log(`[targets] ${next.join(", ")}`);
    else console.warn(`[targets] no containers in compose project "${MONITOR_PROJECT}"`);
    for (const name of targets) {
      if (next.includes(name)) continue;
      for (const state of [healthState, healthFailCount, crashedAt, openBuckets, pressureSince, latestSample, prevCounters]) delete state[name];
    }
    targets = next;
  } catch (e: unknown) {
    console.warn("[targets] container list failed:", e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// Docker log framing (shared utility)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Discord alarm
// ---------------------------------------------------------------------------

const lastAlarmAt: Record<string, number> = {};

async function sendAlarm(
  type: string,
  service: string,
  detail: string
): Promise<void> {
  if (!DISCORD_WEBHOOK) return;

  const key = `${type}:${service}`;
  const now = Date.now();
  if (lastAlarmAt[key] !== undefined && now - lastAlarmAt[key] < ALARM_COOLDOWN_MS) {
    return; // cooldown active
  }
  lastAlarmAt[key] = now;

  const emoji =
    type === "RECOVERY" ? "✅" : type === "HEALTHCHECK" ? "⚠️" : "🚨";
  const content = [
    `${emoji} **[${type}]** \`${service}\``,
    `⏰ ${new Date().toISOString()}`,
    detail,
    `📄 Logs: <http://localhost:${LOG_PORT}/logs/${service}>`,
  ].join("\n");

  const payload = Buffer.from(JSON.stringify({ content }));
  const url = new URL(DISCORD_WEBHOOK);

  await new Promise<void>((resolve) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
        },
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      }
    );
    req.on("error", (e) => {
      console.error("[alarm] Discord webhook failed:", e.message);
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Healthcheck polling (#2)
// ---------------------------------------------------------------------------

interface ContainerJson {
  State?: {
    Health?: { Status?: string };
    Running?: boolean;
    Restarting?: boolean;
    StartedAt?: string;
  };
}

const healthFailCount: Record<string, number> = {};
const healthState: Record<string, string> = {};
// Crash time (ms) of each container that sent CRASH and has not been reported
// back up. The healthcheck path can't report these: the restart passes through
// `starting`, which resets healthFailCount.
const crashedAt: Record<string, number> = {};

function markCrashed(name: string, eventTimeNano: number | undefined): void {
  crashedAt[name] = eventTimeNano ? eventTimeNano / 1e6 : Date.now();
  delete lastAlarmAt[`RECOVERY:${name}`];
}

// A container is back once an instance started after the crash is out of
// Docker's restart backoff (which reports Running) and has proven itself:
// healthy, or with no healthcheck, still up one poll interval later.
function isBackAfterCrash(name: string, state: ContainerJson["State"], health: string): boolean {
  const crashTime = crashedAt[name];
  const startedAt = Date.parse(state?.StartedAt ?? "");
  if (crashTime === undefined || state?.Running !== true || state.Restarting === true) return false;
  if (!(startedAt > crashTime)) return false;
  if (health === "healthy") return true;
  return health === "none" && Date.now() - startedAt >= HEALTH_POLL_INTERVAL_MS;
}

async function pollHealth(): Promise<void> {
  await refreshTargets();
  for (const name of targets) {
    try {
      const { status, body } = await dockerRequest<ContainerJson>(
        "GET",
        `/containers/${name}/json`
      );

      if (status !== 200) {
        console.warn(`[health] ${name}: container not found (${status})`);
        continue;
      }

      const current = body.State?.Health?.Status ?? "none";
      const prev = healthState[name];
      healthState[name] = current;

      if (current === "unhealthy") {
        healthFailCount[name] = (healthFailCount[name] ?? 0) + 1;
        if (healthFailCount[name] >= HEALTH_FAIL_THRESHOLD) {
          console.error(`[health] ${name}: UNHEALTHY (count=${healthFailCount[name]})`);
          await sendAlarm("HEALTHCHECK", name, `Health status: \`${current}\``);
        }
      } else if (current === "starting") {
        // Container is coming up. NO alarm — every path that reaches
        // `starting` is either voluntary or already surfaced by another
        // alarm type:
        //
        // - Involuntary crash / OOM: the docker-events handler below
        //   fires CRASH on `oom` or `die` with non-graceful exit BEFORE
        //   the container recreates and lands here. CRASH is event-
        //   driven (no poll race) and specific ("Container killed by
        //   OOM killer" / "exit code: 137"), so it's strictly more
        //   useful than a RESTARTING follow-on.
        // - Container hangs without exiting: HEALTHCHECK fires when the
        //   healthcheck flips to `unhealthy`. That path doesn't reach
        //   `starting` at all.
        // - Deploy / `compose restart`: voluntary, no signal needed.
        // - Initial boot: voluntary, no signal needed.
        //
        // Docker's restart policies fire on process EXIT (which
        // triggers CRASH), not on healthcheck failure — so on plain
        // docker-compose there's no involuntary path that produces
        // `unhealthy → starting` without a prior CRASH. And the 60s
        // health poll interval means a transient unhealthy transition
        // between polls could hide from a `prev === "unhealthy"` gate
        // anyway, giving false negatives. Dropping the alarm entirely
        // avoids that whole class of misclassification.
        console.log(`[health] ${name}: restarting (prev=${prev})`);
        // Always reset the HEALTHCHECK cooldown: a new container
        // instance is starting and its first unhealthy poll should fire
        // immediately, not sit under the old instance's cooldown.
        delete lastAlarmAt[`HEALTHCHECK:${name}`];
        healthFailCount[name] = 0;
      } else {
        // healthy (or unknown state)
        const healthRestored =
          (healthFailCount[name] ?? 0) >= HEALTH_FAIL_THRESHOLD && prev === "unhealthy" && current === "healthy";
        const backAfterCrash = isBackAfterCrash(name, body.State, current);
        if (healthRestored || backAfterCrash) {
          delete crashedAt[name];
          console.log(`[health] ${name}: recovered → ${current}`);
          const detail = healthRestored ? "Health restored" : "Back up after crash";
          await sendAlarm("RECOVERY", name, `${detail}: \`${current}\``);
        }
        healthFailCount[name] = 0;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[health] poll failed for ${name}:`, msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Container stats polling (memory, CPU, network, block I/O, PIDs)
// ---------------------------------------------------------------------------

/**
 * Snapshot of one docker stats sample, distilled to the fields we actually
 * use for triage. `usage_bytes` and `limit_bytes` come from `memory_stats`
 * exactly as Docker reports them. `usage_bytes` includes page cache the kernel
 * reclaims before it OOM-kills, so `working_set_bytes` subtracts inactive file
 * cache the way `docker stats` does, and `usage_ratio` is computed from it.
 * `anon_bytes` / `file_bytes` / `inactive_file_bytes` are the cgroup's own
 * breakdown (null when Docker doesn't report them). `cpu_percent` is a nominal
 * single-core % (Docker's `docker stats` calculation) so we can spot a runaway
 * loop.
 *
 * Network and block I/O arrive from Docker as cumulative counters, so the
 * sample stores both the cumulative totals (for "total so far" in the
 * latest sample) and the per-second rates derived from the delta since the
 * previous poll (for history: a cumulative counter's average/min/max over a
 * rollup window would be meaningless, but a rate's are not). Rates are null
 * on the first poll after startup, when a counter is absent, or when a
 * counter resets (container recreate) — never negative. `pids_current` is
 * a point value, so it aggregates like memory/CPU.
 */
interface StatsSample {
  ts: string;
  usage_bytes: number;
  working_set_bytes: number;
  anon_bytes: number | null;
  file_bytes: number | null;
  inactive_file_bytes: number | null;
  limit_bytes: number | null;
  usage_ratio: number | null;
  cpu_percent: number | null;
  net_rx_bytes_per_sec: number | null;
  net_tx_bytes_per_sec: number | null;
  net_rx_packets_per_sec: number | null;
  net_tx_packets_per_sec: number | null;
  net_rx_bytes_total: number | null;
  net_tx_bytes_total: number | null;
  blk_read_bytes_per_sec: number | null;
  blk_write_bytes_per_sec: number | null;
  blk_read_bytes_total: number | null;
  blk_write_bytes_total: number | null;
  pids_current: number | null;
  /** Aggregation window that produced this point (1s for raw samples). */
  resolution_ms: number;
}

interface DockerStatsResponse {
  read?: string;
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: Record<string, number>;
  };
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  networks?: Record<string, {
    rx_bytes?: number;
    tx_bytes?: number;
    rx_packets?: number;
    tx_packets?: number;
  }> | null;
  blkio_stats?: {
    io_service_bytes_recursive?: { op?: string; value?: number }[] | null;
  } | null;
  pids_stats?: {
    current?: number;
  } | null;
}

/**
 * Cascading rollups: every poll sample feeds the 10s bucket; each
 * finalized bucket feeds the next tier up, so a 1min point aggregates
 * six 10s points (via two 30s points — count-weighted, so the average
 * is exact, and min-of-mins / max-of-maxes are exact too). Each tier
 * keeps average, min, and max per metric over its window, and each
 * tier is retained for its own span: raw 1s samples live in segmented
 * files for STATS_RAW_RETENTION_DAYS, the rollups for up to 3 years.
 * A query picks the tier by window span (see queryStats) and reads
 * only that tier's segments — never the millions of raw points.
 */
interface StatsTier {
  windowMs: number;
  label: string;
  /** Segment subdirectory under STATS_DATA_DIR/<container>/. */
  key: string;
  /** How far back this tier is kept, in days. */
  retentionDays: number;
  /** One segment file covers this much time. */
  fileSpanMs: number;
  /** Largest query span served by this tier. */
  maxSpanMs: number;
}
const STATS_TIERS: StatsTier[] = [
  // The 10s/30s tiers are rollup steps feeding 1min; no query reads
  // them directly (raw covers spans up to 30m, 1min covers up to 1d).
  { windowMs: 10_000, label: "10s", key: "t10s", retentionDays: 90, fileSpanMs: 3_600_000, maxSpanMs: 600_000 },
  { windowMs: 30_000, label: "30s", key: "t30s", retentionDays: 365, fileSpanMs: 3_600_000, maxSpanMs: 1_800_000 },
  // Tier thresholds are chosen so every picker window yields at least
  // ~60 points: 1s points to 30m, 1min points to 1d, 1h points to
  // 30d, 1d points to 1y, 1wk beyond that.
  { windowMs: 60_000, label: "1min", key: "t1m", retentionDays: 365, fileSpanMs: 3_600_000, maxSpanMs: 86_400_000 },
  { windowMs: 3_600_000, label: "1h", key: "t1h", retentionDays: 1095, fileSpanMs: 86_400_000, maxSpanMs: 2_592_000_000 },
  { windowMs: 86_400_000, label: "1d", key: "t1d", retentionDays: 1095, fileSpanMs: 86_400_000, maxSpanMs: 31_536_000_000 },
  { windowMs: 604_800_000, label: "1wk", key: "t1w", retentionDays: 1095, fileSpanMs: 86_400_000, maxSpanMs: Number.MAX_SAFE_INTEGER },
];
/** The raw tier: unaggregated 1s samples, one segment file per hour. */
const RAW_TIER = { windowMs: 1_000, label: "1s", key: "raw", fileSpanMs: 3_600_000, maxSpanMs: 1_800_000 };

/** One metric's running aggregate: sum + count give the exact mean, and min/max cascade exactly (min-of-mins, max-of-maxes). Null when no non-null value contributed. */
interface MetricAgg {
  sum: number;
  count: number;
  min: number | null;
  max: number | null;
}

/** In-progress aggregation for one tier window. Rate/PID metrics aggregate
 * like the memory/CPU ones; cumulative network/block totals are latest-only
 * and never enter a bucket. */
interface StatsBucket {
  windowStart: number;
  usage: MetricAgg;
  workingSet: MetricAgg;
  anon: MetricAgg;
  file: MetricAgg;
  inactiveFile: MetricAgg;
  limit: MetricAgg;
  ratio: MetricAgg;
  cpu: MetricAgg;
  netRx: MetricAgg;
  netTx: MetricAgg;
  netRxPackets: MetricAgg;
  netTxPackets: MetricAgg;
  blkRead: MetricAgg;
  blkWrite: MetricAgg;
  pids: MetricAgg;
}

/** The aggregated metrics, shared by buckets and by child items fed into them. */
type AggSet = Pick<StatsBucket, "usage" | "workingSet" | "anon" | "file" | "inactiveFile" | "limit" | "ratio" | "cpu" | "netRx" | "netTx" | "netRxPackets" | "netTxPackets" | "blkRead" | "blkWrite" | "pids">;

const AGG_KEYS = ["usage", "workingSet", "anon", "file", "inactiveFile", "limit", "ratio", "cpu", "netRx", "netTx", "netRxPackets", "netTxPackets", "blkRead", "blkWrite", "pids"] as const;

/** One finalized rollup point as stored in segments and served by /stats. */
interface StatsRollupPoint {
  ts: string;
  resolution_ms: number;
  /** Raw samples represented (working-set count — the always-present metric). */
  count: number;
  usage_avg: number | null;
  usage_min: number | null;
  usage_max: number | null;
  working_set_avg: number | null;
  working_set_min: number | null;
  working_set_max: number | null;
  anon_avg: number | null;
  anon_min: number | null;
  anon_max: number | null;
  file_avg: number | null;
  file_min: number | null;
  file_max: number | null;
  inactive_file_avg: number | null;
  inactive_file_min: number | null;
  inactive_file_max: number | null;
  limit_avg: number | null;
  limit_min: number | null;
  limit_max: number | null;
  usage_ratio_avg: number | null;
  usage_ratio_min: number | null;
  usage_ratio_max: number | null;
  cpu_avg: number | null;
  cpu_min: number | null;
  cpu_max: number | null;
  net_rx_bytes_per_sec_avg: number | null;
  net_rx_bytes_per_sec_min: number | null;
  net_rx_bytes_per_sec_max: number | null;
  net_tx_bytes_per_sec_avg: number | null;
  net_tx_bytes_per_sec_min: number | null;
  net_tx_bytes_per_sec_max: number | null;
  net_rx_packets_per_sec_avg: number | null;
  net_rx_packets_per_sec_min: number | null;
  net_rx_packets_per_sec_max: number | null;
  net_tx_packets_per_sec_avg: number | null;
  net_tx_packets_per_sec_min: number | null;
  net_tx_packets_per_sec_max: number | null;
  blk_read_bytes_per_sec_avg: number | null;
  blk_read_bytes_per_sec_min: number | null;
  blk_read_bytes_per_sec_max: number | null;
  blk_write_bytes_per_sec_avg: number | null;
  blk_write_bytes_per_sec_min: number | null;
  blk_write_bytes_per_sec_max: number | null;
  pids_current_avg: number | null;
  pids_current_min: number | null;
  pids_current_max: number | null;
}

/** Open (unfinalized) bucket per tier, per container. Finalized buckets go straight to segments. */
const openBuckets: Record<string, (StatsBucket | null)[]> = {};
const latestSample: Record<string, StatsSample> = {};
/** Host CPU count last seen on a stats poll (`online_cpus`, identical for
 * every container on the host). Powers the overview CPU-capacity ratio. */
let hostCpuCount: number | null = null;
/** Previous poll's cumulative network/block counters + read time, per
 * container, for per-second rate derivation. Reset on counter reset. */
const prevCounters: Record<string, {
  readMs: number;
  netRx: number | null;
  netTx: number | null;
  netRxPackets: number | null;
  netTxPackets: number | null;
  blkRead: number | null;
  blkWrite: number | null;
} | null> = {};
/** Wall-clock start of the current above-threshold episode, per container. */
const pressureSince: Record<string, number> = {};

function emptyAgg(): MetricAgg {
  return { sum: 0, count: 0, min: null, max: null };
}

function newBucket(windowStart: number): StatsBucket {
  return {
    windowStart,
    usage: emptyAgg(),
    workingSet: emptyAgg(),
    anon: emptyAgg(),
    file: emptyAgg(),
    inactiveFile: emptyAgg(),
    limit: emptyAgg(),
    ratio: emptyAgg(),
    cpu: emptyAgg(),
    netRx: emptyAgg(),
    netTx: emptyAgg(),
    netRxPackets: emptyAgg(),
    netTxPackets: emptyAgg(),
    blkRead: emptyAgg(),
    blkWrite: emptyAgg(),
    pids: emptyAgg(),
  };
}

function aggFromValue(value: number | null): MetricAgg {
  return value === null ? emptyAgg() : { sum: value, count: 1, min: value, max: value };
}

/** Merge one child's aggregate into a bucket. Count-weighted, so averages cascade exactly. */
function combineAgg(into: MetricAgg, child: MetricAgg): void {
  into.sum += child.sum;
  into.count += child.count;
  if (child.min !== null) into.min = into.min === null ? child.min : Math.min(into.min, child.min);
  if (child.max !== null) into.max = into.max === null ? child.max : Math.max(into.max, child.max);
}

function feedBucket(bucket: StatsBucket, child: AggSet): void {
  for (const key of AGG_KEYS) combineAgg(bucket[key], child[key]);
}

/** A raw sample as an aggregate item: each metric contributes one value.
 * Cumulative totals deliberately excluded — they are latest-only. */
function sampleToAgg(sample: StatsSample): AggSet {
  return {
    usage: aggFromValue(sample.usage_bytes),
    workingSet: aggFromValue(sample.working_set_bytes),
    anon: aggFromValue(sample.anon_bytes),
    file: aggFromValue(sample.file_bytes),
    inactiveFile: aggFromValue(sample.inactive_file_bytes),
    limit: aggFromValue(sample.limit_bytes),
    ratio: aggFromValue(sample.usage_ratio),
    cpu: aggFromValue(sample.cpu_percent),
    netRx: aggFromValue(sample.net_rx_bytes_per_sec),
    netTx: aggFromValue(sample.net_tx_bytes_per_sec),
    netRxPackets: aggFromValue(sample.net_rx_packets_per_sec),
    netTxPackets: aggFromValue(sample.net_tx_packets_per_sec),
    blkRead: aggFromValue(sample.blk_read_bytes_per_sec),
    blkWrite: aggFromValue(sample.blk_write_bytes_per_sec),
    pids: aggFromValue(sample.pids_current),
  };
}

function finalizeBucket(bucket: StatsBucket, resolutionMs: number): StatsRollupPoint {
  const avg = (agg: MetricAgg): number | null => (agg.count > 0 ? agg.sum / agg.count : null);
  return {
    ts: new Date(bucket.windowStart).toISOString(),
    resolution_ms: resolutionMs,
    count: bucket.workingSet.count,
    usage_avg: avg(bucket.usage),
    usage_min: bucket.usage.min,
    usage_max: bucket.usage.max,
    working_set_avg: avg(bucket.workingSet),
    working_set_min: bucket.workingSet.min,
    working_set_max: bucket.workingSet.max,
    anon_avg: avg(bucket.anon),
    anon_min: bucket.anon.min,
    anon_max: bucket.anon.max,
    file_avg: avg(bucket.file),
    file_min: bucket.file.min,
    file_max: bucket.file.max,
    inactive_file_avg: avg(bucket.inactiveFile),
    inactive_file_min: bucket.inactiveFile.min,
    inactive_file_max: bucket.inactiveFile.max,
    limit_avg: avg(bucket.limit),
    limit_min: bucket.limit.min,
    limit_max: bucket.limit.max,
    usage_ratio_avg: avg(bucket.ratio),
    usage_ratio_min: bucket.ratio.min,
    usage_ratio_max: bucket.ratio.max,
    cpu_avg: avg(bucket.cpu),
    cpu_min: bucket.cpu.min,
    cpu_max: bucket.cpu.max,
    net_rx_bytes_per_sec_avg: avg(bucket.netRx),
    net_rx_bytes_per_sec_min: bucket.netRx.min,
    net_rx_bytes_per_sec_max: bucket.netRx.max,
    net_tx_bytes_per_sec_avg: avg(bucket.netTx),
    net_tx_bytes_per_sec_min: bucket.netTx.min,
    net_tx_bytes_per_sec_max: bucket.netTx.max,
    net_rx_packets_per_sec_avg: avg(bucket.netRxPackets),
    net_rx_packets_per_sec_min: bucket.netRxPackets.min,
    net_rx_packets_per_sec_max: bucket.netRxPackets.max,
    net_tx_packets_per_sec_avg: avg(bucket.netTxPackets),
    net_tx_packets_per_sec_min: bucket.netTxPackets.min,
    net_tx_packets_per_sec_max: bucket.netTxPackets.max,
    blk_read_bytes_per_sec_avg: avg(bucket.blkRead),
    blk_read_bytes_per_sec_min: bucket.blkRead.min,
    blk_read_bytes_per_sec_max: bucket.blkRead.max,
    blk_write_bytes_per_sec_avg: avg(bucket.blkWrite),
    blk_write_bytes_per_sec_min: bucket.blkWrite.min,
    blk_write_bytes_per_sec_max: bucket.blkWrite.max,
    pids_current_avg: avg(bucket.pids),
    pids_current_min: bucket.pids.min,
    pids_current_max: bucket.pids.max,
  };
}

/** A served point back to aggregate form (for rebuilding an open bucket after a restart). Per-metric counts aren't stored, so the point count stands in for each non-null metric — exact whenever Docker reports a field consistently, which it does in practice. Fields absent from segments written before they existed (or non-numeric) coerce to null, so old segments rebuild as gaps for the new metrics instead of NaN. */
function pointToAgg(point: StatsRollupPoint): AggSet {
  const numField = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const agg = (avg: unknown, min: unknown, max: unknown): MetricAgg => {
    const a = numField(avg);
    return a === null
      ? emptyAgg()
      : { sum: a * point.count, count: point.count, min: numField(min), max: numField(max) };
  };
  return {
    usage: agg(point.usage_avg, point.usage_min, point.usage_max),
    workingSet: agg(point.working_set_avg, point.working_set_min, point.working_set_max),
    anon: agg(point.anon_avg, point.anon_min, point.anon_max),
    file: agg(point.file_avg, point.file_min, point.file_max),
    inactiveFile: agg(point.inactive_file_avg, point.inactive_file_min, point.inactive_file_max),
    limit: agg(point.limit_avg, point.limit_min, point.limit_max),
    ratio: agg(point.usage_ratio_avg, point.usage_ratio_min, point.usage_ratio_max),
    cpu: agg(point.cpu_avg, point.cpu_min, point.cpu_max),
    netRx: agg(point.net_rx_bytes_per_sec_avg, point.net_rx_bytes_per_sec_min, point.net_rx_bytes_per_sec_max),
    netTx: agg(point.net_tx_bytes_per_sec_avg, point.net_tx_bytes_per_sec_min, point.net_tx_bytes_per_sec_max),
    netRxPackets: agg(point.net_rx_packets_per_sec_avg, point.net_rx_packets_per_sec_min, point.net_rx_packets_per_sec_max),
    netTxPackets: agg(point.net_tx_packets_per_sec_avg, point.net_tx_packets_per_sec_min, point.net_tx_packets_per_sec_max),
    blkRead: agg(point.blk_read_bytes_per_sec_avg, point.blk_read_bytes_per_sec_min, point.blk_read_bytes_per_sec_max),
    blkWrite: agg(point.blk_write_bytes_per_sec_avg, point.blk_write_bytes_per_sec_min, point.blk_write_bytes_per_sec_max),
    pids: agg(point.pids_current_avg, point.pids_current_min, point.pids_current_max),
  };
}

/** A raw sample as a served point: avg = min = max = the value.
 * Cumulative totals are not carried into history (see StatsSample). */
function pointFromSample(sample: StatsSample): StatsRollupPoint {
  const point = (value: number | null): { avg: number | null; min: number | null; max: number | null } => ({
    avg: value,
    min: value,
    max: value,
  });
  const usage = point(sample.usage_bytes);
  const workingSet = point(sample.working_set_bytes);
  const anon = point(sample.anon_bytes);
  const file = point(sample.file_bytes);
  const inactiveFile = point(sample.inactive_file_bytes);
  const limit = point(sample.limit_bytes);
  const ratio = point(sample.usage_ratio);
  const cpu = point(sample.cpu_percent);
  const netRx = point(sample.net_rx_bytes_per_sec);
  const netTx = point(sample.net_tx_bytes_per_sec);
  const netRxPackets = point(sample.net_rx_packets_per_sec);
  const netTxPackets = point(sample.net_tx_packets_per_sec);
  const blkRead = point(sample.blk_read_bytes_per_sec);
  const blkWrite = point(sample.blk_write_bytes_per_sec);
  const pids = point(sample.pids_current);
  return {
    ts: sample.ts,
    resolution_ms: RAW_TIER.windowMs,
    count: 1,
    usage_avg: usage.avg,
    usage_min: usage.min,
    usage_max: usage.max,
    working_set_avg: workingSet.avg,
    working_set_min: workingSet.min,
    working_set_max: workingSet.max,
    anon_avg: anon.avg,
    anon_min: anon.min,
    anon_max: anon.max,
    file_avg: file.avg,
    file_min: file.min,
    file_max: file.max,
    inactive_file_avg: inactiveFile.avg,
    inactive_file_min: inactiveFile.min,
    inactive_file_max: inactiveFile.max,
    limit_avg: limit.avg,
    limit_min: limit.min,
    limit_max: limit.max,
    usage_ratio_avg: ratio.avg,
    usage_ratio_min: ratio.min,
    usage_ratio_max: ratio.max,
    cpu_avg: cpu.avg,
    cpu_min: cpu.min,
    cpu_max: cpu.max,
    net_rx_bytes_per_sec_avg: netRx.avg,
    net_rx_bytes_per_sec_min: netRx.min,
    net_rx_bytes_per_sec_max: netRx.max,
    net_tx_bytes_per_sec_avg: netTx.avg,
    net_tx_bytes_per_sec_min: netTx.min,
    net_tx_bytes_per_sec_max: netTx.max,
    net_rx_packets_per_sec_avg: netRxPackets.avg,
    net_rx_packets_per_sec_min: netRxPackets.min,
    net_rx_packets_per_sec_max: netRxPackets.max,
    net_tx_packets_per_sec_avg: netTxPackets.avg,
    net_tx_packets_per_sec_min: netTxPackets.min,
    net_tx_packets_per_sec_max: netTxPackets.max,
    blk_read_bytes_per_sec_avg: blkRead.avg,
    blk_read_bytes_per_sec_min: blkRead.min,
    blk_read_bytes_per_sec_max: blkRead.max,
    blk_write_bytes_per_sec_avg: blkWrite.avg,
    blk_write_bytes_per_sec_min: blkWrite.min,
    blk_write_bytes_per_sec_max: blkWrite.max,
    pids_current_avg: pids.avg,
    pids_current_min: pids.min,
    pids_current_max: pids.max,
  };
}

/** Ingest one raw poll sample: append it to the raw segments, then feed the cascade starting at the 10s tier. */
function ingestSample(name: string, sample: StatsSample): void {
  latestSample[name] = sample;
  const parsed = Date.parse(sample.ts);
  const sampleMs = Number.isFinite(parsed) ? parsed : Date.now();
  appendRawSample(name, sample, sampleMs);
  const secondStart = Math.floor(sampleMs / RAW_TIER.windowMs) * RAW_TIER.windowMs;
  feedTier(name, 0, sampleToAgg(sample), secondStart);
}

/**
 * Feed one aggregate item into a tier's open bucket, sealing the bucket
 * (append to segments + cascade upward) when the item crosses into a
 * newer window. Windows nest exactly (each window divides the next),
 * so the child's window start always maps to the right parent window.
 */
function feedTier(name: string, tierIdx: number, child: AggSet, childWindowStart: number): void {
  const tier = STATS_TIERS[tierIdx];
  const buckets = openBuckets[name] ?? (openBuckets[name] = STATS_TIERS.map(() => null));
  const windowStart = Math.floor(childWindowStart / tier.windowMs) * tier.windowMs;
  let bucket = buckets[tierIdx];
  if (bucket === null) {
    bucket = buckets[tierIdx] = newBucket(windowStart);
  } else if (windowStart > bucket.windowStart) {
    finalizeTierBucket(name, tierIdx, bucket);
    bucket = buckets[tierIdx] = newBucket(windowStart);
  }
  // windowStart < bucket.windowStart (a late item) accumulates into the
  // current bucket rather than reopening a sealed window.
  feedBucket(bucket, child);
}

/** Seal a bucket: append the point to the tier's segments, then feed it upward. */
function finalizeTierBucket(name: string, tierIdx: number, bucket: StatsBucket): void {
  const tier = STATS_TIERS[tierIdx];
  const point = finalizeBucket(bucket, tier.windowMs);
  if (point.count === 0) return; // empty bucket — nothing to store
  appendRollupPoint(name, tier, point);
  const next = tierIdx + 1;
  if (next < STATS_TIERS.length) feedTier(name, next, bucket, bucket.windowStart);
}

// ---------------------------------------------------------------------------
// Stats history persistence
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stats segment store
// ---------------------------------------------------------------------------
//
// Raw samples and rollup points live in append-only segment files:
//
//   <STATS_DATA_DIR>/<container>/raw/<YYYY-MM>/<YYYY-MM-DD-HH>.jsonl[.gz]
//   <STATS_DATA_DIR>/<container>/t10s|t30s|t1m/<YYYY-MM>/<YYYY-MM-DD-HH>.jsonl[.gz]
//   <STATS_DATA_DIR>/<container>/t1h|t1d|t1w/<YYYY-MM>/<YYYY-MM-DD>.jsonl[.gz]
//
// One segment covers fileSpanMs; closed segments are gzipped in the
// background. Reads touch only the segments overlapping the queried
// window, so a 1-minute query reads one hour-file (~2 ms measured),
// never the millions of retained points. All I/O failures warn and
// keep the monitor running — the store must never take down alarming
// or the log server.

function segmentName(periodStart: number, fileSpanMs: number): string {
  const d = new Date(periodStart);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return fileSpanMs < 86_400_000 ? `${date}-${pad(d.getUTCHours())}` : date;
}

function segmentPath(container: string, key: string, periodStart: number, fileSpanMs: number): string {
  const name = segmentName(periodStart, fileSpanMs);
  return join(STATS_DATA_DIR, container, key, name.slice(0, 7), `${name}.jsonl`);
}

/** "2026-10-27-14.jsonl[.gz]" / "2026-10-27.jsonl[.gz]" -> period start ms (UTC), or null. */
function parseSegmentName(file: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:-(\d{2}))?\.jsonl(?:\.gz)?$/.exec(file);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "00"}:00:00.000Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** Currently-open segment per container+key: path + its period start. */
const openSegments: Record<string, { path: string; periodStart: number }> = {};

function appendToSegment(container: string, key: string, fileSpanMs: number, tsMs: number, line: string): void {
  const periodStart = Math.floor(tsMs / fileSpanMs) * fileSpanMs;
  const cacheKey = `${container}/${key}`;
  let seg = openSegments[cacheKey];
  if (!seg || seg.periodStart !== periodStart) {
    if (seg) closeSegment(seg.path);
    const path = segmentPath(container, key, periodStart, fileSpanMs);
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (e: unknown) {
      console.warn("[stats] segment mkdir failed:", e instanceof Error ? e.message : String(e));
      return;
    }
    seg = openSegments[cacheKey] = { path, periodStart };
  }
  try {
    appendFileSync(seg.path, `${line}\n`);
  } catch (e: unknown) {
    console.warn("[stats] segment append failed:", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Gzip a closed segment in the background; failures log and leave the
 * .jsonl for the prune sweep to retry. A sample for an already-gzipped
 * period would be dropped from reads (listSegments prefers .gz) — that
 * can't happen with live Docker timestamps, which are always current.
 */
function closeSegment(path: string): void {
  readFile(path, (readErr, data) => {
    if (readErr) return;
    gzip(data, (gzipErr, gzipped) => {
      if (gzipErr) {
        console.warn("[stats] segment gzip failed:", gzipErr.message);
        return;
      }
      writeFile(`${path}.gz`, gzipped, (writeErr) => {
        if (writeErr) {
          console.warn("[stats] segment gzip write failed:", writeErr.message);
          return;
        }
        unlink(path, () => {
          /* already gone is fine */
        });
      });
    });
  });
}

function appendRawSample(name: string, sample: StatsSample, sampleMs: number): void {
  appendToSegment(name, RAW_TIER.key, RAW_TIER.fileSpanMs, sampleMs, JSON.stringify(sample));
}

function appendRollupPoint(name: string, tier: StatsTier, point: StatsRollupPoint): void {
  const tsMs = Date.parse(point.ts);
  if (!Number.isFinite(tsMs)) return;
  appendToSegment(name, tier.key, tier.fileSpanMs, tsMs, JSON.stringify(point));
}

function readSegmentLines(path: string): string[] {
  try {
    const raw = readFileSync(path);
    const text = path.endsWith(".gz") ? gunzipSync(raw).toString("utf-8") : raw.toString("utf-8");
    return text.split("\n").filter((line) => line.length > 0);
  } catch (e: unknown) {
    console.warn("[stats] segment read failed:", e instanceof Error ? e.message : String(e));
    return [];
  }
}

/** Segment files overlapping [fromMs, toMs], oldest-first. Prefers .gz, falls back to .jsonl. */
function listSegments(container: string, key: string, fileSpanMs: number, fromMs: number, toMs: number): string[] {
  const out: string[] = [];
  const firstPeriod = Math.floor(fromMs / fileSpanMs) * fileSpanMs;
  const lastPeriod = Math.floor(toMs / fileSpanMs) * fileSpanMs;
  for (let period = firstPeriod; period <= lastPeriod; period += fileSpanMs) {
    const base = segmentPath(container, key, period, fileSpanMs);
    if (existsSync(`${base}.gz`)) out.push(`${base}.gz`);
    else if (existsSync(base)) out.push(base);
  }
  return out;
}

function isValidSample(p: unknown): p is StatsSample {
  if (typeof p !== "object" || p === null) return false;
  const s = p as Record<string, unknown>;
  return (
    typeof s.ts === "string" &&
    Number.isFinite(Date.parse(s.ts)) &&
    typeof s.usage_bytes === "number" &&
    typeof s.working_set_bytes === "number" &&
    typeof s.resolution_ms === "number"
  );
}

function isValidRollupPoint(p: unknown): p is StatsRollupPoint {
  if (typeof p !== "object" || p === null) return false;
  const s = p as Record<string, unknown>;
  return (
    typeof s.ts === "string" &&
    Number.isFinite(Date.parse(s.ts)) &&
    typeof s.resolution_ms === "number" &&
    typeof s.count === "number" &&
    (typeof s.working_set_avg === "number" || s.working_set_avg === null)
  );
}

/** Parse + validate + window-filter one tier's segments. Malformed lines (torn trailing line from a crash mid-append) are skipped. */
function parsePoints<T extends { ts: string }>(
  files: string[],
  isValid: (v: unknown) => v is T,
  fromMs: number,
  toMs: number
): T[] {
  const points: T[] = [];
  for (const file of files) {
    for (const line of readSegmentLines(file)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isValid(parsed)) continue;
      const ts = Date.parse(parsed.ts);
      if (Number.isFinite(ts) && ts >= fromMs && ts <= toMs) points.push(parsed);
    }
  }
  points.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return points;
}

function readRawRange(container: string, fromMs: number, toMs: number): StatsSample[] {
  return parsePoints(listSegments(container, RAW_TIER.key, RAW_TIER.fileSpanMs, fromMs, toMs), isValidSample, fromMs, toMs);
}

function readRollupRange(container: string, tier: StatsTier, fromMs: number, toMs: number): StatsRollupPoint[] {
  return parsePoints(listSegments(container, tier.key, tier.fileSpanMs, fromMs, toMs), isValidRollupPoint, fromMs, toMs);
}

/**
 * Serve a window: pick the tier by span (a 30m window gets 1s points,
 * a 1d window gets 1min points, a 30d window gets 1h points), read
 * only that tier's segments overlapping the window, and merge the
 * tier's open bucket (the partial current window, finalized on the
 * fly). Bounded by construction: at most 1800 points (a 30-minute
 * window at 1s), and at least ~60 for every picker window.
 */
function queryStats(container: string, spanMs: number, endMs: number): { points: StatsRollupPoint[]; resolutionMs: number } {
  const fromMs = endMs - spanMs;
  if (spanMs <= RAW_TIER.maxSpanMs) {
    return { points: readRawRange(container, fromMs, endMs).map(pointFromSample), resolutionMs: RAW_TIER.windowMs };
  }
  for (let i = 0; i < STATS_TIERS.length; i++) {
    const tier = STATS_TIERS[i];
    if (spanMs > tier.maxSpanMs) continue;
    const points = readRollupRange(container, tier, fromMs, endMs);
    const open = openBuckets[container]?.[i] ?? null;
    if (open !== null) {
      const point = finalizeBucket(open, tier.windowMs);
      const tsMs = open.windowStart;
      if (point.count > 0 && tsMs >= fromMs && tsMs <= endMs) {
        const idx = points.findIndex((p) => Date.parse(p.ts) === tsMs);
        if (idx >= 0) points[idx] = point;
        else points.push(point);
        points.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
      }
    }
    return { points, resolutionMs: tier.windowMs };
  }
  // Unreachable: the 1wk tier's maxSpanMs is MAX_SAFE_INTEGER.
  return { points: [], resolutionMs: RAW_TIER.windowMs };
}

/**
 * Rebuild open buckets after a (re)start from the tier below, and
 * finalize windows that fully elapsed while down (see
 * finalizeElapsedWindows): the current window's children are already
 * on disk (raw samples for the 10s tier, finalized child points above
 * that), so the partial window resumes exactly. Runs bottom-up.
 */
function rebuildOpenBuckets(): void {
  let containers: string[];
  try {
    containers = readdirSync(STATS_DATA_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return; // no store yet — first boot
  }
  const now = Date.now();
  for (const name of containers) {
    finalizeElapsedWindows(name, now);
    const buckets: (StatsBucket | null)[] = STATS_TIERS.map(() => null);
    openBuckets[name] = buckets;
    const w0 = Math.floor(now / STATS_TIERS[0].windowMs) * STATS_TIERS[0].windowMs;
    const raws = readRawRange(name, w0, now);
    if (raws.length > 0) {
      const bucket = newBucket(w0);
      for (const s of raws) feedBucket(bucket, sampleToAgg(s));
      buckets[0] = bucket;
    }
    for (let i = 1; i < STATS_TIERS.length; i++) {
      const tier = STATS_TIERS[i];
      const childTier = STATS_TIERS[i - 1];
      const w = Math.floor(now / tier.windowMs) * tier.windowMs;
      const children = readRollupRange(name, childTier, w, now);
      const childOpen = buckets[i - 1];
      if (childOpen !== null) {
        const p = finalizeBucket(childOpen, childTier.windowMs);
        if (p.count > 0) children.push(p);
      }
      if (children.length === 0) continue;
      const bucket = newBucket(w);
      for (const p of children) feedBucket(bucket, pointToAgg(p));
      buckets[i] = bucket;
    }
  }
}

/**
 * Newest persisted point of one tier, or null when the tier holds
 * nothing: scan segment files newest-first so a restart after a long
 * outage doesn't re-read the tier's whole retention. Points append in
 * window order, so the first non-empty file holds the latest point.
 */
function latestPersistedTs(name: string, tier: StatsTier, now: number): number | null {
  const retentionMs = tier.retentionDays * 86_400_000;
  const files = listSegments(name, tier.key, tier.fileSpanMs, now - retentionMs, now);
  for (let k = files.length - 1; k >= 0; k--) {
    const points = parsePoints([files[k]], isValidRollupPoint, 0, now);
    if (points.length === 0) continue;
    let latest = 0;
    for (const p of points) latest = Math.max(latest, Date.parse(p.ts));
    return latest;
  }
  return null;
}

/**
 * Append one rollup point the way finalizeTierBucket does, except a
 * period whose segment is already gzipped gets the point merged into
 * the .gz: reads prefer .gz, so a plain append to a resurrected .jsonl
 * would be invisible. The merge writes a temp file and renames it
 * over the .gz, so a kill mid-write leaves the old .gz intact and an
 * orphan .tmp the readers ignore. Never throws.
 */
function appendRollupPointAllowingGzip(name: string, tier: StatsTier, point: StatsRollupPoint): void {
  const tsMs = Date.parse(point.ts);
  if (!Number.isFinite(tsMs)) return;
  const periodStart = Math.floor(tsMs / tier.fileSpanMs) * tier.fileSpanMs;
  const path = segmentPath(name, tier.key, periodStart, tier.fileSpanMs);
  const gzPath = `${path}.gz`;
  if (!existsSync(gzPath)) {
    appendRollupPoint(name, tier, point);
    return;
  }
  try {
    const line = JSON.stringify(point);
    const seen = new Set<string>();
    const lines: string[] = [];
    const files = [gzPath];
    if (existsSync(path)) files.push(path);
    for (const file of files) {
      for (const existing of readSegmentLines(file)) {
        if (seen.has(existing)) continue;
        seen.add(existing);
        lines.push(existing);
      }
    }
    if (!seen.has(line)) lines.push(line);
    const tmpPath = `${gzPath}.tmp`;
    writeFileSync(tmpPath, gzipSync(lines.join("\n") + "\n"));
    renameSync(tmpPath, gzPath);
    try {
      unlinkSync(path);
    } catch {
      /* a leftover .jsonl beside the .gz is ignored by reads */
    }
  } catch (e: unknown) {
    console.warn("[stats] gzipped segment merge failed:", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Finalize windows that fully elapsed while the process was down,
 * bottom-up: a window's children are already on disk (raw samples for
 * the 10s tier, finalized child points above that), so the point is
 * rebuilt exactly as the live cascade would have built it. A window
 * already stored is skipped, which makes repeated restarts
 * idempotent; a window with no children gets no point, as live.
 * Runs before the open-bucket rebuild, so the tiers above see the
 * recovered points on disk. I/O failures warn and skip, as elsewhere
 * in the store.
 */
function finalizeElapsedWindows(name: string, now: number): void {
  for (let i = 0; i < STATS_TIERS.length; i++) {
    try {
      finalizeElapsedTier(name, i, now);
    } catch (e: unknown) {
      console.warn("[stats] elapsed-window finalization failed:", e instanceof Error ? e.message : String(e));
    }
  }
}

function finalizeElapsedTier(name: string, tierIdx: number, now: number): void {
  const tier = STATS_TIERS[tierIdx];
  const cur = Math.floor(now / tier.windowMs) * tier.windowMs;
  // Windows at or before the latest stored point either have one or
  // were empty when sealed; only windows after it can be missing, and
  // children older than it were already counted into later windows
  // live (late items accumulate into the current bucket), so reading
  // from the latest point cannot double-count them.
  const latest = latestPersistedTs(name, tier, now);
  const from = latest ?? now - tier.retentionDays * 86_400_000;
  if (from >= cur) return;
  // Children in [from, cur), grouped by the window of this tier
  // they belong to (floor by this tier's window, as the live cascade
  // does). For tier 0 the children are raw samples; above that,
  // child-tier points — re-read from disk so points this pass
  // finalized for the tier below count.
  const buckets = new Map<number, StatsBucket>();
  const addChild = (windowStart: number, child: AggSet): void => {
    if (windowStart >= cur) return;
    let bucket = buckets.get(windowStart);
    if (bucket === undefined) {
      bucket = newBucket(windowStart);
      buckets.set(windowStart, bucket);
    }
    feedBucket(bucket, child);
  };
  if (tierIdx === 0) {
    for (const s of readRawRange(name, from, cur)) {
      const ms = Date.parse(s.ts);
      if (!Number.isFinite(ms)) continue;
      addChild(Math.floor(ms / tier.windowMs) * tier.windowMs, sampleToAgg(s));
    }
  } else {
    const childTier = STATS_TIERS[tierIdx - 1];
    for (const p of readRollupRange(name, childTier, from, cur)) {
      const ms = Date.parse(p.ts);
      if (!Number.isFinite(ms)) continue;
      addChild(Math.floor(ms / tier.windowMs) * tier.windowMs, pointToAgg(p));
    }
  }
  if (buckets.size === 0) return;
  const persisted = new Set<number>();
  for (const p of readRollupRange(name, tier, from, cur)) persisted.add(Date.parse(p.ts));
  const starts = [...buckets.keys()].sort((a, b) => a - b);
  for (const windowStart of starts) {
    if (persisted.has(windowStart)) continue;
    const bucket = buckets.get(windowStart);
    if (bucket === undefined) continue;
    const point = finalizeBucket(bucket, tier.windowMs);
    if (point.count === 0) continue;
    appendRollupPointAllowingGzip(name, tier, point);
    persisted.add(windowStart);
  }
}

/**
 * Daily sweep: gzip stale uncompressed segments (closed periods whose
 * .gz is missing — e.g. a container stopped mid-hour; a 1h grace period
 * keeps the rollover path from racing it) and delete segments older
 * than their tier's retention. Never throws.
 */
function pruneStatsData(): void {
  const now = Date.now();
  let containers: string[];
  try {
    containers = readdirSync(STATS_DATA_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return;
  }
  const tiers: { key: string; fileSpanMs: number; retentionDays: number }[] = [
    { key: RAW_TIER.key, fileSpanMs: RAW_TIER.fileSpanMs, retentionDays: STATS_RAW_RETENTION_DAYS },
    ...STATS_TIERS,
  ];
  for (const name of containers) {
    for (const tier of tiers) {
      const cutoff = now - tier.retentionDays * 86_400_000;
      const tierDir = join(STATS_DATA_DIR, name, tier.key);
      let months: string[];
      try {
        months = readdirSync(tierDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        continue;
      }
      for (const month of months) {
        const monthDir = join(tierDir, month);
        let files: string[];
        try {
          files = readdirSync(monthDir);
        } catch {
          continue;
        }
        for (const file of files) {
          const periodStart = parseSegmentName(file);
          if (periodStart === null) continue;
          const path = join(monthDir, file);
          try {
            if (periodStart + tier.fileSpanMs <= cutoff) {
              unlinkSync(path);
            } else if (
              file.endsWith(".jsonl") &&
              periodStart + tier.fileSpanMs < now - 3_600_000 &&
              !existsSync(`${path}.gz`)
            ) {
              closeSegment(path);
            }
          } catch (e: unknown) {
            console.warn("[stats] prune failed for", path, e instanceof Error ? e.message : String(e));
          }
        }
      }
    }
  }
}

/**
 * Network counters summed across interfaces, the way `docker stats` sums
 * NET I/O. Null when Docker reports no `networks` object (or no
 * interfaces) — a missing field is a gap, never a zero.
 */
function networkCounters(s: DockerStatsResponse): {
  rxBytes: number | null;
  txBytes: number | null;
  rxPackets: number | null;
  txPackets: number | null;
} | null {
  const networks = s.networks;
  if (!networks || typeof networks !== "object") return null;
  const ifaces = Object.values(networks);
  if (ifaces.length === 0) return null;
  const sum = (pick: (i: NonNullable<DockerStatsResponse["networks"]>[string]) => number | undefined): number | null => {
    let total = 0;
    let seen = false;
    for (const iface of ifaces) {
      const v = pick(iface);
      if (typeof v === "number" && Number.isFinite(v)) {
        total += v;
        seen = true;
      }
    }
    return seen ? total : null;
  };
  return {
    rxBytes: sum((i) => i.rx_bytes),
    txBytes: sum((i) => i.tx_bytes),
    rxPackets: sum((i) => i.rx_packets),
    txPackets: sum((i) => i.tx_packets),
  };
}

/**
 * Block I/O totals from `io_service_bytes_recursive`: sum the `Read` and
 * `Write` ops only — `Total`/`Sync`/`Async`/`Discard` would double-count
 * the same bytes. Null per direction when that op is absent; null overall
 * when the array is missing or empty.
 */
function blkioCounters(s: DockerStatsResponse): {
  readBytes: number | null;
  writeBytes: number | null;
} | null {
  const entries = s.blkio_stats?.io_service_bytes_recursive;
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const sumOp = (op: string): number | null => {
    let total = 0;
    let seen = false;
    for (const e of entries) {
      if (e?.op === op && typeof e.value === "number" && Number.isFinite(e.value)) {
        total += e.value;
        seen = true;
      }
    }
    return seen ? total : null;
  };
  return { readBytes: sumOp("Read"), writeBytes: sumOp("Write") };
}

/** Per-second rate from two cumulative counter readings. Null on a missing
 * reading, a non-positive interval, or a counter reset (current < previous,
 * e.g. container recreate) — a reset must never surface as a negative spike. */
function counterRate(prev: number | null, curr: number | null, dtMs: number): number | null {
  if (prev === null || curr === null || dtMs <= 0) return null;
  if (curr < prev) return null;
  return (curr - prev) / (dtMs / 1000);
}

/**
 * Compute the `docker stats`-style CPU percentage. Returns null when we
 * don't have both a current and prior CPU sample (first poll after startup)
 * or when totals are unset — treating those as null is what `docker stats`
 * itself does on the first frame.
 */
function calcCpuPercent(s: DockerStatsResponse): number | null {
  const cpu = s.cpu_stats?.cpu_usage?.total_usage;
  const system = s.cpu_stats?.system_cpu_usage;
  const preCpu = s.precpu_stats?.cpu_usage?.total_usage;
  const preSystem = s.precpu_stats?.system_cpu_usage;
  const onlineCpus = s.cpu_stats?.online_cpus ?? 1;
  if (
    cpu === undefined ||
    system === undefined ||
    preCpu === undefined ||
    preSystem === undefined
  )
    return null;
  const cpuDelta = cpu - preCpu;
  const systemDelta = system - preSystem;
  if (systemDelta <= 0 || cpuDelta < 0) return null;
  return Math.round((cpuDelta / systemDelta) * onlineCpus * 100 * 10) / 10;
}

/**
 * Inactive file cache in bytes, from cgroup v1's `total_inactive_file` or
 * cgroup v2's `inactive_file`. Null when Docker reports neither.
 */
function inactiveFileBytes(mem: DockerStatsResponse["memory_stats"]): number | null {
  return mem?.stats?.total_inactive_file ?? mem?.stats?.inactive_file ?? null;
}

/**
 * Memory the container can't give back without OOM risk: usage minus inactive
 * file cache, the same figure `docker stats` reports as MEM USAGE. Mirrors the
 * Docker CLI: `total_inactive_file` if below usage, else `inactive_file` if
 * below usage, else raw usage.
 */
function calcWorkingSetBytes(mem: DockerStatsResponse["memory_stats"]): number {
  const usage = mem?.usage ?? 0;
  const totalInactiveFile = mem?.stats?.total_inactive_file;
  if (totalInactiveFile !== undefined && totalInactiveFile < usage) {
    return usage - totalInactiveFile;
  }
  const inactiveFile = mem?.stats?.inactive_file;
  if (inactiveFile !== undefined && inactiveFile < usage) return usage - inactiveFile;
  return usage;
}

// Stats polls run every second; a hung socket must fail fast rather than
// stall the cycle behind the in-flight guard below.
const STATS_REQUEST_TIMEOUT_MS = 10_000;

let statsPollInFlight = false;

/**
 * Overlap guard: at a 1s cadence a slow Docker socket must not stack
 * overlapping poll cycles (each cycle fans out one stats request per
 * container). A tick that lands while the previous cycle is still
 * running is skipped — the next tick picks the containers up.
 */
async function pollStats(): Promise<void> {
  if (statsPollInFlight) return;
  statsPollInFlight = true;
  try {
    await pollStatsOnce();
  } finally {
    statsPollInFlight = false;
  }
}

async function pollStatsOnce(): Promise<void> {
  await refreshTargets();
  for (const name of targets) {
    try {
      const { status, body } = await dockerRequest<DockerStatsResponse>(
        "GET",
        `/containers/${name}/stats?stream=false`,
        STATS_REQUEST_TIMEOUT_MS
      );
      if (status !== 200) continue;

      const usage = body.memory_stats?.usage ?? 0;
      const workingSet = calcWorkingSetBytes(body.memory_stats);
      const memStats = body.memory_stats?.stats;
      const limit = body.memory_stats?.limit ?? null;
      // Docker reports the host's total RAM as "limit" when the
      // container has no explicit `--memory` cap. Ratios computed
      // against host RAM are misleading — the numbers look fine
      // (0.03) even for a container about to OOM against a real cap.
      // Use `IS_UNLIMITED` (defined at top with the host-mem read) so
      // `/stats` reports `null` and the alarm block skips this
      // container consistently.
      const usageRatio = IS_UNLIMITED(limit) ? null : workingSet / (limit as number);
      const cpuPercent = calcCpuPercent(body);
      const onlineCpus = body.cpu_stats?.online_cpus;
      if (typeof onlineCpus === "number" && onlineCpus > 0) hostCpuCount = onlineCpus;

      // Network / block I/O rates from cumulative counters. The interval
      // is the delta between Docker `read` timestamps (the samples'
      // own clock), falling back to wall-clock now when unparseable.
      const readMs = Date.parse(body.read ?? "");
      const readNow = Number.isFinite(readMs) ? readMs : Date.now();
      const net = networkCounters(body);
      const blk = blkioCounters(body);
      const prev = prevCounters[name] ?? null;
      const dtMs = prev === null ? 0 : readNow - prev.readMs;
      const sample: StatsSample = {
        ts: body.read ?? new Date().toISOString(),
        usage_bytes: usage,
        working_set_bytes: workingSet,
        anon_bytes: memStats?.anon ?? memStats?.total_rss ?? null,
        file_bytes: memStats?.file ?? memStats?.total_cache ?? null,
        inactive_file_bytes: inactiveFileBytes(body.memory_stats),
        limit_bytes: limit,
        usage_ratio: usageRatio,
        cpu_percent: cpuPercent,
        net_rx_bytes_per_sec: counterRate(prev?.netRx ?? null, net?.rxBytes ?? null, dtMs),
        net_tx_bytes_per_sec: counterRate(prev?.netTx ?? null, net?.txBytes ?? null, dtMs),
        net_rx_packets_per_sec: counterRate(prev?.netRxPackets ?? null, net?.rxPackets ?? null, dtMs),
        net_tx_packets_per_sec: counterRate(prev?.netTxPackets ?? null, net?.txPackets ?? null, dtMs),
        net_rx_bytes_total: net?.rxBytes ?? null,
        net_tx_bytes_total: net?.txBytes ?? null,
        blk_read_bytes_per_sec: counterRate(prev?.blkRead ?? null, blk?.readBytes ?? null, dtMs),
        blk_write_bytes_per_sec: counterRate(prev?.blkWrite ?? null, blk?.writeBytes ?? null, dtMs),
        blk_read_bytes_total: blk?.readBytes ?? null,
        blk_write_bytes_total: blk?.writeBytes ?? null,
        pids_current:
          typeof body.pids_stats?.current === "number" ? body.pids_stats.current : null,
        // Raw samples are 1s points. (Previously this read the 10s tier's
        // window, mislabeling every stored raw sample's resolution.)
        resolution_ms: RAW_TIER.windowMs,
      };
      prevCounters[name] = {
        readMs: readNow,
        netRx: net?.rxBytes ?? null,
        netTx: net?.txBytes ?? null,
        netRxPackets: net?.rxPackets ?? null,
        netTxPackets: net?.txPackets ?? null,
        blkRead: blk?.readBytes ?? null,
        blkWrite: blk?.writeBytes ?? null,
      };

      ingestSample(name, sample);

      // Sustained memory-pressure alarm: the ratio must stay above the
      // threshold for MEMORY_PRESSURE_SUSTAINED_MS of wall-clock time (a
      // poll-count rule would fire on any 3-second spike at 1s polling).
      // Only fires when the container has an explicit memory limit
      // (usage_ratio non-null). The elapsed check uses `>=` so continued
      // pressure re-attempts the alarm on every subsequent poll —
      // `ALARM_COOLDOWN_MS` gates the actual Discord spam. With `===` a
      // single ping fired once and then stayed silent for the entire
      // pressure episode.
      if (usageRatio !== null && usageRatio >= MEMORY_PRESSURE_RATIO) {
        let since = pressureSince[name];
        if (since === undefined) {
          since = Date.now();
          pressureSince[name] = since;
        }
        if (Date.now() - since >= MEMORY_PRESSURE_SUSTAINED_MS) {
          const pct = Math.round(usageRatio * 100);
          const workingSetMB = Math.round(workingSet / 1024 / 1024);
          const usageMB = Math.round(usage / 1024 / 1024);
          const limitMB = limit ? Math.round(limit / 1024 / 1024) : "?";
          await sendAlarm(
            "MEMORY_PRESSURE",
            name,
            `Memory at ${pct}% of container limit (${workingSetMB} MB / ${limitMB} MB working set, ${usageMB} MB with page cache) sustained ${Math.round(MEMORY_PRESSURE_SUSTAINED_MS / 1000)}s+ — OOM likely if trend continues.`
          );
        }
      } else if (usageRatio !== null) {
        delete pressureSince[name];
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[stats] poll failed for ${name}:`, msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Journald log reader
// ---------------------------------------------------------------------------

/**
 * Read the last `tail` log lines a container has written to systemd-journald.
 * The `journald` docker log driver labels each log entry with
 * `CONTAINER_NAME=<name>`; we filter by that and use `--output=cat` to
 * return just the message bodies (no timestamp/host prefix — the caller
 * decides how to render). Streams stdout back through `onChunk` so a
 * `follow=1` mode can be added later without refactor.
 *
 * Returns a disposer that kills the child when the caller is done
 * (usually the HTTP client disconnecting mid-tail).
 */
const STDERR_BUFFER_MAX = 64 * 1024;

function readContainerLogsFromJournal(params: {
  container: string;
  tail: number;
  /**
   * Optional `journalctl --since` expression. When set, journalctl returns
   * every entry from that instant onward — the `-n tail` cap still applies
   * as a safety upper bound but the WINDOW is now time-based rather than
   * line-count-based. Callers use this to reach logs older than `tail`
   * lines' worth of history during a log-storm (e.g. an inbox retry storm
   * generating ~1700 lines/min drowns the default 10k-line cap in 6 min;
   * `since=30m ago` recovers the older, quieter pre-storm entries).
   *
   * journalctl accepts absolute (`2026-07-28 17:00:00`) or relative
   * (`10m ago`, `2 hours ago`, `yesterday`) expressions per systemd.time(7).
   * The caller is trusted to pass a well-formed value; a malformed one is
   * surfaced as a journalctl-exit-nonzero error via the standard error
   * pipeline below.
   */
  since?: string;
  onChunk: (buf: Buffer) => void;
  onEnd: () => void;
  onError: (err: Error) => void;
}): () => void {
  const { container, tail, since, onChunk, onEnd, onError } = params;
  const args = [
    `CONTAINER_NAME=${container}`,
    "-n",
    String(tail),
    "--output=cat",
    "--no-pager",
  ];
  if (since) {
    args.push("--since", since);
  }
  const child = spawn(JOURNALCTL_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  // `error` (ENOENT / spawn failure) and `close` (with nonzero code)
  // both fire on failed spawn — without a settled guard, `onError`
  // runs twice and the caller writes to a response that's already
  // ended (ERR_STREAM_WRITE_AFTER_END). Also protects against the
  // disposer-then-close race when the HTTP client disconnects.
  let settled = false;
  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    fn();
  };

  // Bound `stderr` growth. journalctl normally exits on first fatal
  // error, but a corrupt journal under stress could stream KB/s of
  // errors indefinitely.
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < STDERR_BUFFER_MAX) stderr += chunk.toString();
  });
  child.on("error", (e) => settle(() => onError(e)));
  child.on("close", (code) => {
    settle(() => {
      if (code === 0) onEnd();
      else onError(new Error(`journalctl exited ${code}${stderr ? ": " + stderr.trim() : ""}`));
    });
  });

  // Hard timeout — a hung journalctl (rare, but possible on
  // systemd-journald under load) shouldn't leak the child if the HTTP
  // client isn't enforcing its own deadline.
  const timeoutHandle = setTimeout(() => {
    settle(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      onError(new Error(`journalctl timeout after ${JOURNALCTL_TIMEOUT_MS}ms`));
    });
  }, JOURNALCTL_TIMEOUT_MS);
  child.on("close", () => clearTimeout(timeoutHandle));

  return () => {
    // Mark settled BEFORE killing so the ensuing `close` event's
    // handler no-ops (otherwise it would `onError` on an
    // already-ended socket).
    settled = true;
    clearTimeout(timeoutHandle);
    try { child.kill(); } catch { /* already gone */ }
  };
}

// ---------------------------------------------------------------------------
// Docker event stream (#3)
// ---------------------------------------------------------------------------

// Exit codes that indicate a clean/intentional stop, not a crash:
//   0   — process exited cleanly (handled SIGTERM gracefully)
//   137 — killed by SIGKILL (128+9), e.g. docker compose up -d replacing a container
//   143 — killed by SIGTERM (128+15), e.g. docker stop / compose graceful shutdown
// Any other non-zero exit code is treated as a crash and triggers an alarm.
const GRACEFUL_EXIT_CODES = new Set([0, 137, 143]);

async function watchEvents(): Promise<void> {
  try {
    const stream = await dockerStream("/events");

    // Docker event stream sends one JSON object per line
    let buf = "";
    stream.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as {
            Action: string;
            Actor: { Attributes: { name: string; exitCode?: string } & Record<string, string> };
            timeNano?: number;
          };
          const action = event.Action;
          const name = event.Actor?.Attributes?.name ?? "";

          // Only process "die" and "oom" events for monitored containers.
          // "die" carries the real exit code; "kill" fires before the process exits
          // and always lacks an exit code — using it caused false alarms on deployments.
          // "oom" has no exit code but always signals a real crash (kernel OOM kill).
          const monitored = MONITOR_PROJECT
            ? isProjectService(event.Actor?.Attributes)
            : MONITOR_TARGETS.includes(name);
          if (!monitored) continue;

          if (action === "oom") {
            console.error(`[events] ${name}: OOM kill`);
            markCrashed(name, event.timeNano);
            sendAlarm("CRASH", name, "Container killed by OOM killer").catch(
              (e: unknown) => {
                console.error("[events] sendAlarm failed:", e instanceof Error ? e.message : String(e));
              }
            );
            continue;
          }

          if (action === "die") {
            const exitCodeRaw = event.Actor?.Attributes?.exitCode;
            const exitCode = exitCodeRaw !== undefined ? parseInt(exitCodeRaw, 10) : NaN;
            const isGraceful = !isNaN(exitCode) && GRACEFUL_EXIT_CODES.has(exitCode);
            const exitDisplay = isNaN(exitCode) ? "?" : String(exitCode);

            // Container logs live in systemd-journald (see file header) and
            // survive container recreate independently — no pre-deploy dump
            // needed. `journalctl CONTAINER_NAME=<name> --since <die-ts>`
            // recovers the tail post-hoc when triage requires it.

            if (isGraceful) {
              console.log(`[events] ${name}: die (exit=${exitCode}) — graceful stop, no alarm`);
              continue;
            }

            console.error(`[events] ${name}: die (exit=${exitDisplay}) — crash`);
            markCrashed(name, event.timeNano);
            sendAlarm(
              "CRASH",
              name,
              `Container exited unexpectedly (exit code: \`${exitDisplay}\`)`
            ).catch((e: unknown) => {
              console.error("[events] sendAlarm failed:", e instanceof Error ? e.message : String(e));
            });
          }
        } catch {
          // partial JSON or non-event line
        }
      }
    });

    stream.on("end", () => {
      console.error("[events] stream ended, reconnecting in 5s...");
      setTimeout(() => void watchEvents(), 5_000);
    });

    stream.on("error", (e: Error) => {
      console.error("[events] stream error:", e.message, "— reconnecting in 5s");
      setTimeout(() => void watchEvents(), 5_000);
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[events] connect failed:", msg, "— retrying in 5s");
    setTimeout(() => void watchEvents(), 5_000);
  }
}

// ---------------------------------------------------------------------------
// Frontend + cookie login
// ---------------------------------------------------------------------------
//
// The dashboard is a static file (`frontend.html`, shipped in the repo
// next to the compiled `monitor.js` and read from disk per request, so a
// `git pull` updates it with no restart and no second process). It calls
// the same API routes below — the browser just authenticates with a
// cookie instead of a token:
//
//   POST /login { token } — the token is the existing LOG_SERVER_TOKEN.
//     On match, the server mints a random session id, stores it with a
//     1-day expiry, and sets it as an HttpOnly cookie.
//   Cookie auth — every request carrying a valid session cookie is
//     authenticated, and the cookie is re-issued with a fresh 1-day
//     expiry on every such transaction (sliding expiry: the session
//     only lapses after a full day with no requests).
//   POST /logout — drops the session server-side and clears the cookie.
//
// Bearer auth is unchanged: API clients keep working exactly as before,
// and a request may authenticate by either method. The token itself
// never goes into a cookie or localStorage — the page sends it once,
// in the login POST body, and the browser then only presents the
// opaque session id.

const SESSION_COOKIE_NAME = "monitor_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const SESSION_COOKIE_MAX_AGE = 86_400; // seconds, matches SESSION_TTL_MS

/** Session id -> expiry (epoch ms). Swept hourly; see `sweepSessions`. */
const sessions = new Map<string, number>();

function sessionCookieHeader(sessionId: string): string {
  return `${SESSION_COOKIE_NAME}=${sessionId}; Max-Age=${SESSION_COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax`;
}

function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`;
}

function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

/** True when the session exists and has not expired (expired ids are dropped). */
function hasValidSession(sessionId: string): boolean {
  const expiresAt = sessions.get(sessionId);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return false;
  }
  return true;
}

/**
 * Validate the request's session cookie and, when valid, slide its expiry
 * to a fresh 1 day and re-issue the cookie on this response. Returns
 * false when there is no session cookie or it is missing/expired.
 * Must run before the response headers are written — it sets the
 * cookie via `setHeader`, which `writeHead` merges with its own headers.
 */
function refreshSession(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const sessionId = parseCookies(req)[SESSION_COOKIE_NAME];
  if (!sessionId || !hasValidSession(sessionId)) return false;
  sessions.set(sessionId, Date.now() + SESSION_TTL_MS);
  res.setHeader("Set-Cookie", sessionCookieHeader(sessionId));
  return true;
}

/** Drop sessions past expiry so the map can't grow without bound. */
function sweepSessions(): void {
  const now = Date.now();
  for (const [id, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(id);
  }
}

/** Constant-time token comparison for the login route (lengths may differ). */
function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Read the request body, capped so a login POST can't stream unboundedly. */
function readBody(req: http.IncomingMessage, maxBytes = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("Body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

/** The static dashboard file, resolved next to the running script first. */
function readFrontendHtml(): string | null {
  for (const candidate of [join(__dirname, "frontend.html"), join(__dirname, "..", "frontend.html")]) {
    try {
      return readFileSync(candidate, "utf-8");
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Log server (#4)
// ---------------------------------------------------------------------------

function isAuthenticated(req: http.IncomingMessage): boolean {
  if (!LOG_SERVER_TOKEN) {
    console.error("[security] LOG_SERVER_TOKEN is not set — all authenticated endpoints are blocked");
    return false; // fail closed
  }
  return req.headers.authorization === `Bearer ${LOG_SERVER_TOKEN}`;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

interface ContainerListItem {
  Id: string;
  Names: string[];
  Image: string;
  Status: string;
  State: string;
}

const server = http.createServer(
  (req: http.IncomingMessage, res: http.ServerResponse) => {
    handleRequest(req, res).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[server] unhandled error:", msg);
      try {
        if (!res.headersSent) sendJson(res, 500, { error: "Internal server error" });
        else res.end();
      } catch { /* socket already gone */ }
    });
  }
);

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const rawUrl = req.url ?? "/";
  let url: URL;
  try {
    url = new URL(rawUrl, "http://localhost");
  } catch {
    sendJson(res, 400, { error: "Bad request" });
    return;
  }
  const pathname = url.pathname;

  // `/health` is intentionally unauthenticated — its body is
  // low-sensitivity (process uptime + monitored container names +
  // last-known health/restart states) and orchestrator health probes
  // need a public endpoint. README documents this row as "no auth"; a
  // Bearer gate here would silent-401 the probes.
  if (pathname === "/health") {
    // A logged-in browser hitting /health keeps its session sliding too;
    // orchestrator probes carry no cookie, so this is a no-op for them.
    refreshSession(req, res);
    sendJson(res, 200, {
      status: "ok",
      targets,
      health: healthState,
      uptime: process.uptime(),
    });
    return;
  }

  // Static frontend — public by design: the page itself carries no data,
  // and every data call it makes goes through the auth gate below.
  if ((pathname === "/" || pathname === "/frontend.html") && req.method === "GET") {
    refreshSession(req, res);
    const html = readFrontendHtml();
    if (html === null) {
      sendJson(res, 500, { error: "Frontend not found" });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  // POST /login — exchange the existing token for a session cookie.
  if (pathname === "/login" && req.method === "POST") {
    let body: string;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { error: "Bad request" });
      return;
    }
    let token: unknown;
    try {
      token = (JSON.parse(body) as { token?: unknown }).token;
    } catch {
      sendJson(res, 400, { error: "Bad request" });
      return;
    }
    if (typeof token !== "string" || !LOG_SERVER_TOKEN || !tokensEqual(token, LOG_SERVER_TOKEN)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    const sessionId = randomBytes(32).toString("base64url");
    sessions.set(sessionId, Date.now() + SESSION_TTL_MS);
    res.setHeader("Set-Cookie", sessionCookieHeader(sessionId));
    sendJson(res, 200, { ok: true });
    return;
  }

  // POST /logout — drop the session and clear the cookie.
  if (pathname === "/logout" && req.method === "POST") {
    const sessionId = parseCookies(req)[SESSION_COOKIE_NAME];
    if (sessionId) sessions.delete(sessionId);
    res.setHeader("Set-Cookie", clearSessionCookieHeader());
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!isAuthenticated(req) && !refreshSession(req, res)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  // GET /containers — list running containers
  if (pathname === "/containers" && req.method === "GET") {
    try {
      const { body } = await dockerRequest<ContainerListItem[]>(
        "GET",
        "/containers/json"
      );
      const list = (Array.isArray(body) ? body : []).map((c) => ({
        id: c.Id.slice(0, 12),
        name: (c.Names[0] ?? "").replace(/^\//, ""),
        image: c.Image,
        status: c.Status,
        state: c.State,
      }));
      sendJson(res, 200, list);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      sendJson(res, 500, { error: msg });
    }
    return;
  }

  // GET /stats — latest sample per monitored container, for the
  // dashboard overview (donuts). No history, no Docker calls: the
  // samples are the in-memory latest from the 1s poll. Containers with
  // no sample yet report `latest: null`.
  if (pathname === "/stats" && req.method === "GET") {
    sendJson(res, 200, {
      containers: targets.map((container) => ({
        container,
        latest: latestSample[container] ?? null,
      })),
      host_cpus: hostCpuCount,
      poll_interval_ms: STATS_POLL_INTERVAL_MS,
      pressure_threshold_ratio: MEMORY_PRESSURE_RATIO,
    });
    return;
  }

  // GET /stats/:container — restricted to monitored containers
  const statsMatch = /^\/stats\/([^/]+)$/.exec(pathname);
  if (statsMatch && req.method === "GET") {
    const container = statsMatch[1] ?? "";
    if (!targets.includes(container)) {
      sendJson(res, 403, { error: "Container not monitored" });
      return;
    }
    // Windowed query: `span` seconds ending at `end` (default: last hour
    // ending now). The span picks the tier — see queryStats. Both params
    // are clamped so a malformed query can't scan the whole store.
    const spanRaw = parseInt(url.searchParams.get("span") ?? "3600", 10);
    const spanS = Number.isFinite(spanRaw) && spanRaw > 0 ? Math.min(spanRaw, 3 * 365.25 * 24 * 3600) : 3600;
    const endRaw = url.searchParams.get("end");
    let endMs = endRaw ? Date.parse(endRaw) : Date.now();
    if (!Number.isFinite(endMs) || endMs > Date.now()) endMs = Date.now();
    const { points, resolutionMs } = queryStats(container, spanS * 1000, endMs);
    sendJson(res, 200, {
      container,
      poll_interval_ms: STATS_POLL_INTERVAL_MS,
      pressure_threshold_ratio: MEMORY_PRESSURE_RATIO,
      host_cpus: hostCpuCount,
      latest: latestSample[container] ?? null,
      history: points,
      span_s: spanS,
      end: new Date(endMs).toISOString(),
      resolution_ms: resolutionMs,
    });
    return;
  }

  // GET /logs/:container — restricted to monitored containers
  const logsMatch = /^\/logs\/([^/]+)$/.exec(pathname);
  if (logsMatch && req.method === "GET") {
    const container = logsMatch[1] ?? "";
    if (!targets.includes(container)) {
      sendJson(res, 403, { error: "Container not monitored" });
      return;
    }
    // Validate `tail`: unbounded / non-numeric / negative values used to
    // reach journalctl and either error out or return an unbounded
    // history. Clamp to [1, 10000] and default to 100.
    const tailRaw = parseInt(url.searchParams.get("tail") ?? "100", 10);
    const tail = Number.isFinite(tailRaw) && tailRaw > 0 && tailRaw <= 10_000 ? tailRaw : 100;

    // Optional time-based window. journalctl's `--since` accepts absolute
    // (`2026-07-28 17:00:00`) and relative (`10m ago`, `2 hours ago`,
    // `yesterday`) forms per systemd.time(7). Combined with `-n tail`,
    // this returns "at most `tail` entries from within the requested
    // window", which is what triage needs during a log-storm — the tail
    // cap alone can't reach older entries when the storm generates more
    // lines than the cap.
    //
    // Length-capped defensively — a very long value could make
    // journalctl parse-error at the process-arg boundary. 200 octets
    // covers every legitimate expression comfortably (longest realistic
    // form is ~44 chars: `2026-07-28+17:00:00+America/Los_Angeles`).
    // Byte-cap via `Buffer.byteLength` because a multi-byte-UTF-8 value
    // could otherwise smuggle past a naive char cap.
    const sinceRaw = url.searchParams.get("since");
    let since: string | undefined;
    if (sinceRaw !== null && sinceRaw.length > 0) {
      if (Buffer.byteLength(sinceRaw, "utf8") > 200) {
        // Explicit 400 rather than silently dropping the filter. A silent
        // drop would serve the default `-n 100` tail with no signal that
        // the caller's window was ignored — the exact "wrong answer, no
        // error" shape #13's premature-200 fix worked to eliminate.
        sendJson(res, 400, {
          error: "since must be 1-200 UTF-8 octets",
        });
        return;
      }
      since = sinceRaw;
    }

    // Delay `writeHead` until first stdout chunk arrives. journalctl
    // spawn failures (missing binary, permission denied) previously
    // returned 200 with an error message in the body, so any consumer
    // gating on status treated it as success.
    let headersSent = false;
    const startStreaming = () => {
      if (headersSent) return;
      headersSent = true;
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    };

    const disposer = readContainerLogsFromJournal({
      container,
      tail,
      since,
      onChunk: (chunk) => {
        startStreaming();
        res.write(chunk);
      },
      onEnd: () => {
        startStreaming();
        res.end();
      },
      onError: (e) => {
        if (!headersSent) {
          sendJson(res, 500, { error: `journalctl failed: ${e.message}` });
          return;
        }
        res.write(`\n[error reading logs: ${e.message}]\n`);
        res.end();
      },
    });
    // Kill journalctl if the HTTP client disconnects mid-read.
    req.on("close", disposer);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(LOG_PORT, () => {
  console.log(`[monitor] Log server listening on port ${LOG_PORT}`);
  console.log(
    MONITOR_PROJECT
      ? `[monitor] Targets: services of compose project "${MONITOR_PROJECT}"`
      : `[monitor] Targets: ${MONITOR_TARGETS.join(", ") || "(none)"}`
  );
  console.log(`[monitor] Health poll interval: ${HEALTH_POLL_INTERVAL_MS}ms`);
  console.log(
    `[monitor] Stats poll interval: ${STATS_POLL_INTERVAL_MS}ms · store: ${STATS_DATA_DIR} · raw 1s × ${STATS_RAW_RETENTION_DAYS}d · rollups: ${STATS_TIERS.map((t) => `${t.label}×${t.retentionDays}d`).join(" ")} · pressure=${MEMORY_PRESSURE_RATIO} sustained ${MEMORY_PRESSURE_SUSTAINED_MS}ms`
  );
  if (!DISCORD_WEBHOOK) console.warn("[monitor] DISCORD_ALARM_WEBHOOK not set — alarms disabled");
  if (!LOG_SERVER_TOKEN) console.warn("[monitor] LOG_SERVER_TOKEN not set — log API is open");
});

rebuildOpenBuckets();
pruneStatsData();

setInterval(() => void pollHealth(), HEALTH_POLL_INTERVAL_MS);
void pollHealth(); // immediate first check
setInterval(() => void pollStats(), STATS_POLL_INTERVAL_MS);
void pollStats(); // immediate first sample
setInterval(pruneStatsData, 24 * 60 * 60 * 1000); // gzip stale segments, drop expired ones
setInterval(sweepSessions, 60 * 60 * 1000); // drop expired login sessions
void watchEvents();
