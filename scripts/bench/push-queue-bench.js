#!/usr/bin/env node
/**
 * Bench mock — file d'attente push (sans FCM/APNs réels).
 * Usage: node scripts/bench/push-queue-bench.js
 *        node scripts/bench/push-queue-bench.js --users=50 --devices=3
 */
const { performance } = require('perf_hooks');

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k, v ?? 'true'];
    }),
);

const USERS = Number(args.users || 20);
const DEVICES = Number(args.devices || 3);
const CONCURRENCY = Number(args.concurrency || 5);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Simule sendDataOnlyNotification (1–3 ms). */
const mockSend = async () => {
  await sleep(1 + Math.random() * 2);
  return `mock_${Math.random().toString(36).slice(2, 10)}`;
};

const resolveTargets = (userId) =>
  Array.from({ length: DEVICES }, (_, i) => ({
    deviceId: `dev_${userId}_${i}`,
    fcmToken: `token_${userId}_${i}`,
    platform: i % 2 === 0 ? 'android' : 'ios',
  }));

const sendToUserDevices = async (userId) => {
  const targets = resolveTargets(userId);
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(() => mockSend()));
  }
};

const percentile = (sorted, p) => {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
};

const main = async () => {
  const durations = [];
  const t0 = performance.now();

  for (let u = 1; u <= USERS; u += 1) {
    const start = performance.now();
    await sendToUserDevices(u);
    durations.push(performance.now() - start);
  }

  durations.sort((a, b) => a - b);
  const totalMs = performance.now() - t0;
  const sum = durations.reduce((a, b) => a + b, 0);

  const report = {
    event: 'push_queue_bench',
    users: USERS,
    devicesPerUser: DEVICES,
    concurrency: CONCURRENCY,
    totalSends: USERS * DEVICES,
    totalMs: Math.round(totalMs),
    avgMs: Math.round(sum / durations.length),
    p50Ms: Math.round(percentile(durations, 50)),
    p95Ms: Math.round(percentile(durations, 95)),
    p99Ms: Math.round(percentile(durations, 99)),
  };

  console.log('[PushBench]', JSON.stringify(report));
  console.log(
    `push-queue-bench OK — P50=${report.p50Ms}ms P95=${report.p95Ms}ms P99=${report.p99Ms}ms`,
  );
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
