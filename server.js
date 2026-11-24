'use strict';
const http = require('node:http');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { Sentinel } = require('./src/sentinel');

const sentinel = new Sentinel({
  mode: process.env.MODE || 'baseline',
  limit: Number(process.env.LIMIT || 20),
  minLimit: Number(process.env.MIN_LIMIT || 2),
  maxLimit: Number(process.env.MAX_LIMIT || 100),
  targetMs: Number(process.env.TARGET_MS || 100),
});
const profiles = {
  '/critical': { priority: 'critical', cpuMs: 5, ioMs: 10 },
  '/normal': { priority: 'normal', cpuMs: 10, ioMs: 20 },
  '/background': { priority: 'background', cpuMs: 20, ioMs: 30 },
};
const delay = monitorEventLoopDelay({ resolution: 20 });
delay.enable();
let previousUtil = performance.eventLoopUtilization();
const monitor = setInterval(() => {
  const current = performance.eventLoopUtilization();
  const delta = performance.eventLoopUtilization(current, previousUtil);
  previousUtil = current;
  sentinel.adjust({
    utilization: delta.utilization,
    loopDelayMs: Number.isFinite(delay.mean) ? delay.mean / 1e6 : 0,
  });
  delay.reset();
}, 1000);
monitor.unref();

function duration(searchParams, name, fallback) {
  const raw = searchParams.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 1000 ? n : fallback;
}
function cpuWork(ms) {
  const deadline = performance.now() + ms;
  let x = 0;
  while (performance.now() < deadline) {
    for (let i = 1; i < 1000; i++) x += Math.sqrt(i);
  }
  return x;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function respond(res, code, body, extra = {}) {
  if (res.destroyed) return;
  res.writeHead(code, { 'Content-Type': 'application/json', ...extra });
  res.end(JSON.stringify(body));
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/healthz') return respond(res, 200, { ok: true });
  if (req.method === 'GET' && url.pathname === '/metrics') return respond(res, 200, sentinel.snapshot());
  const profile = profiles[url.pathname];
  if (req.method !== 'GET' || !profile) return respond(res, 404, { error: 'not_found' });

  const release = sentinel.admit(profile.priority);
  if (!release) return respond(res, 503, { error: 'overloaded', priority: profile.priority }, { 'Retry-After': '1' });
  let failed = false;
  const started = performance.now();
  try {
    const cpuMs = duration(url.searchParams, 'cpu_ms', profile.cpuMs);
    const ioMs = duration(url.searchParams, 'io_ms', profile.ioMs);
    const failPct = duration(url.searchParams, 'fail_pct', 0);
    // Blocking CPU is deliberately retained to reproduce event-loop starvation.
    cpuWork(cpuMs);
    await sleep(ioMs);
    if (Math.random() * 100 < failPct) {
      failed = true;
      return respond(res, 502, { error: 'simulated_downstream_failure' });
    }
    respond(res, 200, { endpoint: profile.priority, cpu_ms: cpuMs, io_ms: ioMs,
      duration_ms: Math.round(performance.now() - started) });
  } catch (error) {
    failed = true;
    respond(res, 500, { error: 'internal_error' });
  } finally {
    release(failed);
  }
});
server.headersTimeout = 5000;
server.listen(Number(process.env.PORT || 8080), () => {
  console.log(`Sentinel mode=${sentinel.mode} port=${server.address().port} limit=${sentinel.limit}`);
});
module.exports = { server, sentinel };
