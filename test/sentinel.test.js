'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Sentinel } = require('../src/sentinel');

test('fixed mode rejects above limit and recovers after release', () => {
  const s = new Sentinel({ mode: 'fixed', limit: 2 });
  const a = s.admit('background');
  const b = s.admit('normal');
  assert.ok(a && b);
  assert.equal(s.admit('critical'), null);
  a();
  assert.ok(s.admit('critical'));
  b();
});

test('priority reserves space for critical and normal traffic', () => {
  const s = new Sentinel({ mode: 'priority', limit: 10 });
  const releases = Array.from({ length: 5 }, () => s.admit('background'));
  assert.ok(releases.every(Boolean));
  assert.equal(s.admit('background'), null);
  const critical = s.admit('critical');
  const normal = s.admit('normal');
  assert.ok(critical && normal);
  for (const release of [...releases, critical, normal]) release();
  assert.equal(s.inFlight, 0);
});

test('adaptive limit decreases under load, increases in healthy conditions', () => {
  const s = new Sentinel({ mode: 'adaptive', limit: 10, targetMs: 100, minLimit: 2, maxLimit: 20 });
  s.ewmaMs = 200;
  s.samples = 1;
  assert.equal(s.adjust({ utilization: 0.95, loopDelayMs: 70 }), 8);
  s.ewmaMs = 20;
  s.samples = 1;
  assert.equal(s.adjust({ utilization: 0.1, loopDelayMs: 1 }), 9);
});

test('released token is idempotent', () => {
  const s = new Sentinel({ mode: 'fixed', limit: 1 });
  const release = s.admit('critical');
  release(); release();
  assert.equal(s.inFlight, 0);
  assert.equal(s.counters.critical.completed, 1);
});
