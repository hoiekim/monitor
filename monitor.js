"use strict";
/**
 * monitor.ts — Single-file prod monitor + log server
 *
 * Responsibilities:
 *   1. Discord alarm trigger — webhook on any error/crash/health failure
 *   2. Healthcheck polling — Docker socket, GET /containers/{name}/json every 60s
 *   3. Docker event capture — die/oom events via Docker socket event stream (kill events ignored)
 *   4. Log server — read-only HTTP API backed by Docker socket
 *
 * All four run in one process, managed by pm2 on the host.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = __importDefault(require("http"));
const https_1 = __importDefault(require("https"));
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DISCORD_WEBHOOK = process.env.DISCORD_ALARM_WEBHOOK ?? "";
const LOG_SERVER_TOKEN = process.env.LOG_SERVER_TOKEN ?? "";
const MONITOR_TARGETS = (process.env.MONITOR_TARGETS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const HEALTH_FAIL_THRESHOLD = parseInt(process.env.HEALTH_FAIL_THRESHOLD ?? "1", 10);
const HEALTH_POLL_INTERVAL_MS = parseInt(process.env.HEALTH_POLL_INTERVAL_MS ?? "60000", 10);
const ALARM_COOLDOWN_MS = parseInt(process.env.ALARM_COOLDOWN_MS ?? "60000", 10);
const LOG_PORT = parseInt(process.env.LOG_PORT ?? "9000", 10);
const DOCKER_SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
function dockerRequest(method, path) {
    return new Promise((resolve, reject) => {
        const req = http_1.default.request({ socketPath: DOCKER_SOCKET, method, path }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                const raw = Buffer.concat(chunks).toString();
                try {
                    resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
                }
                catch {
                    resolve({ status: res.statusCode ?? 0, body: raw });
                }
            });
        });
        req.on("error", reject);
        req.end();
    });
}
/** Stream raw bytes from Docker socket into an IncomingMessage-like stream. */
function dockerStream(path) {
    return new Promise((resolve, reject) => {
        const req = http_1.default.request({ socketPath: DOCKER_SOCKET, method: "GET", path }, resolve);
        req.on("error", reject);
        req.end();
    });
}
// ---------------------------------------------------------------------------
// Discord alarm
// ---------------------------------------------------------------------------
const lastAlarmAt = {};
async function sendAlarm(type, service, detail) {
    if (!DISCORD_WEBHOOK)
        return;
    const key = `${type}:${service}`;
    const now = Date.now();
    if (lastAlarmAt[key] !== undefined && now - lastAlarmAt[key] < ALARM_COOLDOWN_MS) {
        return; // cooldown active
    }
    lastAlarmAt[key] = now;
    const emoji = type === "RECOVERY" ? "✅" : type === "HEALTHCHECK" ? "⚠️" : "🚨";
    const content = [
        `${emoji} **[${type}]** \`${service}\``,
        `⏰ ${new Date().toISOString()}`,
        detail,
        `📄 Logs: <http://localhost:${LOG_PORT}/logs/${service}>`,
    ].join("\n");
    const payload = Buffer.from(JSON.stringify({ content }));
    const url = new URL(DISCORD_WEBHOOK);
    await new Promise((resolve) => {
        const req = https_1.default.request({
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": payload.length,
            },
        }, (res) => {
            res.resume();
            res.on("end", resolve);
        });
        req.on("error", (e) => {
            console.error("[alarm] Discord webhook failed:", e.message);
            resolve();
        });
        req.write(payload);
        req.end();
    });
}
const healthFailCount = {};
const healthState = {};
async function pollHealth() {
    for (const name of MONITOR_TARGETS) {
        try {
            const { status, body } = await dockerRequest("GET", `/containers/${name}/json`);
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
            }
            else if (current === "starting") {
                // Container restarted — keep healthFailCount so the next unhealthy
                // cycle fires immediately without waiting for the threshold again.
                // Do NOT fire RECOVERY; starting is not a recovery.
                console.log(`[health] ${name}: restarting (prev=${prev}, failCount=${healthFailCount[name] ?? 0})`);
            }
            else {
                // healthy (or unknown state)
                if ((healthFailCount[name] ?? 0) >= HEALTH_FAIL_THRESHOLD && prev === "unhealthy" && current === "healthy") {
                    console.log(`[health] ${name}: recovered → ${current}`);
                    await sendAlarm("RECOVERY", name, `Health restored: \`${current}\``);
                }
                healthFailCount[name] = 0;
            }
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[health] poll failed for ${name}:`, msg);
        }
    }
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
async function watchEvents() {
    try {
        const stream = await dockerStream("/events");
        // Docker event stream sends one JSON object per line
        let buf = "";
        stream.on("data", (chunk) => {
            buf += chunk.toString();
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
                if (!line.trim())
                    continue;
                try {
                    const event = JSON.parse(line);
                    const action = event.Action;
                    const name = event.Actor?.Attributes?.name ?? "";
                    // Only process "die" and "oom" events for monitored containers.
                    // "die" carries the real exit code; "kill" fires before the process exits
                    // and always lacks an exit code — using it caused false alarms on deployments.
                    // "oom" has no exit code but always signals a real crash (kernel OOM kill).
                    if (!MONITOR_TARGETS.includes(name))
                        continue;
                    if (action === "oom") {
                        console.error(`[events] ${name}: OOM kill`);
                        sendAlarm("CRASH", name, "Container killed by OOM killer").catch((e) => {
                            console.error("[events] sendAlarm failed:", e instanceof Error ? e.message : String(e));
                        });
                        continue;
                    }
                    if (action === "die") {
                        const exitCodeRaw = event.Actor?.Attributes?.exitCode;
                        const exitCode = exitCodeRaw !== undefined ? parseInt(exitCodeRaw, 10) : NaN;
                        const isGraceful = !isNaN(exitCode) && GRACEFUL_EXIT_CODES.has(exitCode);
                        if (isGraceful) {
                            console.log(`[events] ${name}: die (exit=${exitCode}) — graceful stop, no alarm`);
                            continue;
                        }
                        const exitDisplay = isNaN(exitCode) ? "?" : String(exitCode);
                        console.error(`[events] ${name}: die (exit=${exitDisplay}) — crash`);
                        sendAlarm("CRASH", name, `Container exited unexpectedly (exit code: \`${exitDisplay}\`)`).catch((e) => {
                            console.error("[events] sendAlarm failed:", e instanceof Error ? e.message : String(e));
                        });
                    }
                }
                catch {
                    // partial JSON or non-event line
                }
            }
        });
        stream.on("end", () => {
            console.error("[events] stream ended, reconnecting in 5s...");
            setTimeout(() => void watchEvents(), 5000);
        });
        stream.on("error", (e) => {
            console.error("[events] stream error:", e.message, "— reconnecting in 5s");
            setTimeout(() => void watchEvents(), 5000);
        });
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[events] connect failed:", msg, "— retrying in 5s");
        setTimeout(() => void watchEvents(), 5000);
    }
}
// ---------------------------------------------------------------------------
// Log server (#4)
// ---------------------------------------------------------------------------
/**
 * Docker log stream uses a multiplexed framing format:
 *   [stream_type(1)] [0(3)] [size(4 BE)] [payload(size)]
 * Strip headers so callers receive plain text.
 */
function stripDockerFraming(buf) {
    const parts = [];
    let offset = 0;
    while (offset + 8 <= buf.length) {
        const size = buf.readUInt32BE(offset + 4);
        if (size === 0) {
            offset += 8;
            continue;
        }
        if (offset + 8 + size > buf.length)
            break;
        parts.push(buf.subarray(offset + 8, offset + 8 + size));
        offset += 8 + size;
    }
    return parts.length > 0 ? Buffer.concat(parts) : buf;
}
function isAuthenticated(req) {
    if (!LOG_SERVER_TOKEN) {
        console.error("[security] LOG_SERVER_TOKEN is not set — all authenticated endpoints are blocked");
        return false; // fail closed
    }
    return req.headers.authorization === `Bearer ${LOG_SERVER_TOKEN}`;
}
function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(payload);
}
const server = http_1.default.createServer((req, res) => {
    handleRequest(req, res).catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[server] unhandled error:", msg);
        try {
            if (!res.headersSent)
                sendJson(res, 500, { error: "Internal server error" });
            else
                res.end();
        }
        catch { /* socket already gone */ }
    });
});
async function handleRequest(req, res) {
    const rawUrl = req.url ?? "/";
    let url;
    try {
        url = new URL(rawUrl, "http://localhost");
    }
    catch {
        sendJson(res, 400, { error: "Bad request" });
        return;
    }
    const pathname = url.pathname;
    if (!isAuthenticated(req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
    }
    if (pathname === "/health") {
        sendJson(res, 200, {
            status: "ok",
            targets: MONITOR_TARGETS,
            health: healthState,
            uptime: process.uptime(),
        });
        return;
    }
    // GET /containers — list running containers
    if (pathname === "/containers" && req.method === "GET") {
        try {
            const { body } = await dockerRequest("GET", "/containers/json");
            const list = (Array.isArray(body) ? body : []).map((c) => ({
                id: c.Id.slice(0, 12),
                name: (c.Names[0] ?? "").replace(/^\//, ""),
                image: c.Image,
                status: c.Status,
                state: c.State,
            }));
            sendJson(res, 200, list);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            sendJson(res, 500, { error: msg });
        }
        return;
    }
    // GET /logs/:container — restricted to MONITOR_TARGETS
    const logsMatch = /^\/logs\/([^/]+)$/.exec(pathname);
    if (logsMatch && req.method === "GET") {
        const container = logsMatch[1] ?? "";
        if (!MONITOR_TARGETS.includes(container)) {
            sendJson(res, 403, { error: "Container not in MONITOR_TARGETS" });
            return;
        }
        const tail = parseInt(url.searchParams.get("tail") ?? "100", 10);
        const path = `/containers/${container}/logs?stdout=1&stderr=1&tail=${tail}&timestamps=1`;
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        try {
            const stream = await dockerStream(path);
            // Close the Docker socket when the HTTP client disconnects.
            // Without this, the Docker stream stays open and accumulates FDs.
            req.on("close", () => stream.destroy());
            stream.on("data", (chunk) => {
                res.write(stripDockerFraming(chunk));
            });
            stream.on("end", () => res.end());
            stream.on("error", (e) => {
                res.write(`\n[error reading logs: ${e.message}]\n`);
                res.end();
            });
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            res.write(`[error: ${msg}]\n`);
            res.end();
        }
        return;
    }
    sendJson(res, 404, { error: "Not found" });
}
// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(LOG_PORT, () => {
    console.log(`[monitor] Log server listening on port ${LOG_PORT}`);
    console.log(`[monitor] Targets: ${MONITOR_TARGETS.join(", ") || "(none)"}`);
    console.log(`[monitor] Health poll interval: ${HEALTH_POLL_INTERVAL_MS}ms`);
    if (!DISCORD_WEBHOOK)
        console.warn("[monitor] DISCORD_ALARM_WEBHOOK not set — alarms disabled");
    if (!LOG_SERVER_TOKEN)
        console.warn("[monitor] LOG_SERVER_TOKEN not set — log API is open");
});
setInterval(() => void pollHealth(), HEALTH_POLL_INTERVAL_MS);
void pollHealth(); // immediate first check
void watchEvents();
