import http from 'k6/http';
import { check } from 'k6';
const rate = Number(__ENV.RATE || 50);
const base = __ENV.BASE_URL || 'http://localhost:8080';
const failPct = Number(__ENV.FAIL_PCT || 0);
const ioMs = Number(__ENV.IO_MS || 0);
const retries = Number(__ENV.RETRIES || 0);
export const options = {
  scenarios: { pressure: { executor: 'constant-arrival-rate', rate, timeUnit: '1s',
    duration: __ENV.DURATION || '30s', preAllocatedVUs: 100, maxVUs: 400 } },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(95)', 'p(99)'],
};
export default function () {
  const r = Math.random();
  const priority = r < 0.3 ? 'critical' : r < 0.6 ? 'normal' : 'background';
  const params = `?fail_pct=${failPct}${ioMs ? `&io_ms=${ioMs}` : ''}`;
  let response;
  for (let attempt = 0; attempt <= retries; attempt++) {
    response = http.get(`${base}/${priority}${params}`, {
      tags: { priority }, timeout: '5s', responseCallback: http.expectedStatuses(200),
    });
    if (response.status === 200) break;
    // Deliberately no backoff: simulates a retry storm, not recommended client behavior.
  }
  check(response, { 'eventually 200': x => x.status === 200 });
}
