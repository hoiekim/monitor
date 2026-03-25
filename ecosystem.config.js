/** @type {import('pm2').StartOptions} */
module.exports = {
  apps: [
    {
      name: "monitor",
      script: "monitor.js",
      interpreter: "node",
      autorestart: true,
      watch: false,
      max_memory_restart: "100M",
      env: {
        NODE_ENV: "production",
        // Required
        DISCORD_ALARM_WEBHOOK: process.env.DISCORD_ALARM_WEBHOOK,
        LOG_SERVER_TOKEN: process.env.LOG_SERVER_TOKEN,
        MONITOR_TARGETS: process.env.MONITOR_TARGETS,
        // Optional (defaults shown)
        LOG_PORT: process.env.LOG_PORT || "9000",
        HEALTH_POLL_INTERVAL_MS: process.env.HEALTH_POLL_INTERVAL_MS || "60000",
        HEALTH_FAIL_THRESHOLD: process.env.HEALTH_FAIL_THRESHOLD || "1",
        ALARM_COOLDOWN_MS: process.env.ALARM_COOLDOWN_MS || "60000",
        DOCKER_SOCKET: process.env.DOCKER_SOCKET || "/var/run/docker.sock",
      },
    },
  ],
};
