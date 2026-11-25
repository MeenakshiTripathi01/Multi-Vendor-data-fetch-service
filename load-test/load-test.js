import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// Graded shape: 200 virtual users for 60 seconds. Override with VUS and DURATION.
// The sync historical run is saved in load-test/results/summary.json.
// The async historical run is saved in load-test/results/async-summary.json.
//
// These counters do not mean the same thing:
// - http_req_failed: the HTTP call itself failed. Zero does not mean jobs finished.
// - jobs_created / "create returns 202": the API accepted a job. The vendor has not run.
// - post_job_duration and get_job_duration: time spent in that HTTP call only.
// - status_processing, status_complete, status_failed: what a polled GET body said.
//   They count observations, not distinct finished jobs.
// - e2e_observed_ms: milliseconds from this VU's 202 until a later GET by the same
//   VU sees "complete". Jobs that stay queued are absent from this trend.
// Queue depth is not visible to k6. Read it with load-test/completion-snapshot.js.

const createFailures = new Counter('job_create_failures');
const jobsCreated = new Counter('jobs_created');
const statusProcessing = new Counter('status_processing');
const statusComplete = new Counter('status_complete');
const statusFailed = new Counter('status_failed');
const postLatency = new Trend('post_job_duration', true);
const getLatency = new Trend('get_job_duration', true);
const e2eObserved = new Trend('e2e_observed_ms', true);

export const options = {
  scenarios: {
    mixed_traffic: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 200),
      duration: __ENV.DURATION || '60s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<1500'],
    checks: ['rate>0.90'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const VENDOR = __ENV.VENDOR || 'sync';
const ids = [];
const createdAt = {};

export default function () {
  const shouldCreate = ids.length < 3 || Math.random() < 0.35;

  if (shouldCreate) {
    const response = http.post(
      `${BASE_URL}/jobs`,
      JSON.stringify({
        vendor: VENDOR,
        customer_ref: `vu-${__VU}`,
        note: 'load-test',
      }),
      {
        headers: { 'Content-Type': 'application/json' },
        tags: { name: 'POST /jobs' },
      }
    );
    postLatency.add(response.timings.duration);
    const accepted = check(response, {
      'create returns 202': (result) => result.status === 202,
    });
    if (!accepted) {
      createFailures.add(1);
      sleep(1);
      return;
    }
    const requestId = response.json('request_id');
    if (typeof requestId === 'string') {
      jobsCreated.add(1);
      createdAt[requestId] = Date.now();
      ids.push(requestId);
      if (ids.length > 10) ids.shift();
    }
  } else {
    const requestId = ids[Math.floor(Math.random() * ids.length)];
    const response = http.get(`${BASE_URL}/jobs/${requestId}`, {
      tags: { name: 'GET /jobs/:request_id' },
    });
    getLatency.add(response.timings.duration);
    check(response, {
      'status returns 200': (result) => result.status === 200,
    });
    if (response.status === 200) {
      let status = '';
      try {
        status = response.json('status');
      } catch (_err) {
        status = '';
      }
      if (status === 'processing') statusProcessing.add(1);
      else if (status === 'complete') {
        statusComplete.add(1);
        if (createdAt[requestId]) {
          e2eObserved.add(Date.now() - createdAt[requestId]);
          delete createdAt[requestId];
        }
      } else if (status === 'failed') statusFailed.add(1);
    }
  }

  sleep(1);
}

export function handleSummary(data) {
  const summaryPath = __ENV.SUMMARY_PATH || 'load-test/results/summary.json';
  return {
    [summaryPath]: JSON.stringify(data, null, 2),
  };
}
