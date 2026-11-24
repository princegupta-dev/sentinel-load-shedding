'use strict';

const { performance } = require('node:perf_hooks');
const PRIORITIES = ['critical', 'normal', 'background'];

class Sentinel {
  constructor({ mode = 'baseline', limit = 20, minLimit = 2, maxLimit = 100,
    targetMs = 100, intervalMs = 1000, borrowAfterMs = 2000 } = {}) {
    if (!['baseline', 'fixed', 'priority', 'adaptive'].includes(mode)) throw new Error('Invalid MODE');
    if (!Number.isInteger(limit) || limit < 1) throw new Error('LIMIT must be positive');
    this.mode = mode;
    this.limit = limit;
    this.minLimit = minLimit;
    this.maxLimit = maxLimit;
    this.targetMs = targetMs;
    this.borrowAfterMs = borrowAfterMs;
    this.active = { critical: 0, normal: 0, background: 0 };
    this.lastDemand = { critical: performance.now(), normal: performance.now() };
    this.counters = Object.fromEntries(PRIORITIES.map(p => [p, { accepted: 0, rejected: 0, completed: 0, failed: 0 }]));
    this.ewmaMs = null;
    this.samples = 0;
    this.utilization = 0;
    this.loopDelayMs = 0;
    this.timer = null;
    this.intervalMs = intervalMs;
  }

  get inFlight() { return Object.values(this.active).reduce((a, b) => a + b, 0); }

  admit(priority) {
    if (!PRIORITIES.includes(priority)) throw new Error('Invalid priority');
    const now = performance.now();
    if (priority !== 'background') this.lastDemand[priority] = now;

    let available = this.limit;
    if (this.mode === 'priority' || this.mode === 'adaptive') {
      const criticalReserve = Math.ceil(this.limit * 0.3);
      const normalReserve = Math.ceil(this.limit * 0.2);
      const criticalDemandRecent = now - this.lastDemand.critical < this.borrowAfterMs;
      const normalDemandRecent = now - this.lastDemand.normal < this.borrowAfterMs;
      if (priority !== 'critical' && criticalDemandRecent) {
        available -= Math.max(0, criticalReserve - this.active.critical);
      }
      if (priority === 'background' && normalDemandRecent) {
        available -= Math.max(0, normalReserve - this.active.normal);
      }
    }
    if (this.mode !== 'baseline' && this.inFlight >= available) {
      this.counters[priority].rejected++;
      return null;
    }
    this.active[priority]++;
    this.counters[priority].accepted++;
    const started = performance.now();
    let released = false;
    return (failed = false) => {
      if (released) return;
      released = true;
      this.active[priority]--;
      this.counters[priority].completed++;
      if (failed) this.counters[priority].failed++;
      const elapsed = performance.now() - started;
      this.ewmaMs = this.ewmaMs === null ? elapsed : 0.2 * elapsed + 0.8 * this.ewmaMs;
      this.samples++;
    };
  }

  adjust({ utilization, loopDelayMs } = {}) {
    if (this.mode !== 'adaptive') return this.limit;
    if (Number.isFinite(utilization)) this.utilization = utilization;
    if (Number.isFinite(loopDelayMs)) this.loopDelayMs = loopDelayMs;
    if (this.samples === 0 || this.ewmaMs === null) return this.limit;

    // AIMD: fast reduction under overload, slow recovery with hysteresis.
    const overloaded = this.ewmaMs > this.targetMs * 1.4 ||
      this.utilization > 0.9 || this.loopDelayMs > 40;
    const healthy = this.ewmaMs < this.targetMs * 0.85 &&
      this.utilization < 0.75 && this.loopDelayMs < 20;
    if (overloaded) this.limit = Math.max(this.minLimit, Math.floor(this.limit * 0.8));
    else if (healthy) this.limit = Math.min(this.maxLimit, this.limit + 1);
    this.samples = 0;
    return this.limit;
  }

  snapshot() {
    return {
      mode: this.mode, limit: this.limit, inFlight: this.inFlight,
      active: { ...this.active }, ewmaMs: this.ewmaMs === null ? null : Math.round(this.ewmaMs * 10) / 10,
      eventLoopUtilization: Math.round(this.utilization * 1000) / 1000,
      eventLoopDelayMs: Math.round(this.loopDelayMs * 10) / 10,
      requests: structuredClone(this.counters),
    };
  }
}

module.exports = { Sentinel };
