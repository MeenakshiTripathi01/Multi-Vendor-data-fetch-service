# Load test analysis

## Execution

This run was executed. k6 is not installed on the host, so the script ran in the official `grafana/k6` image against the Compose stack.

```text
docker run --rm -v "<project>:/work" -w /work grafana/k6 run \
  -e BASE_URL=http://host.docker.internal:3100 \
  -e VENDOR=sync \
  load-test/load-test.js
```

The API was published on host port **3100**, not 3000, because another local stack already owned ports 3000 and 27017. Container ports were unchanged. The scenario was the default: **200 virtual users for 60 seconds**, sync vendor, one `sleep(1)` per iteration. k6 exited **0**. Thresholds in the script passed. Raw output is `load-test/results/summary.json` and `load-test/results/k6-stdout.txt`.

Other Docker containers were already running on the same machine, so this is not an idle-machine benchmark.

## Results

| Measure | Value |
| --- | --- |
| HTTP requests | 11,317 (about 186/s) |
| POST /jobs | 4,439, all HTTP 202 |
| GET /jobs/:id | 6,878, all HTTP 200 |
| HTTP failure rate | 0 |
| Check pass rate | 100% (4,439 creates, 6,878 status reads) |
| Request duration | median 11 ms, p95 423 ms, p99 951 ms, max 1,499 ms |
| POST duration | average 106 ms, median 16 ms, p95 722 ms |
| GET duration | average 42 ms, median 6 ms, p95 283 ms |
| GET bodies observed as processing | 6,811 |
| GET bodies observed as complete | 67 |
| Failed job responses | none recorded (`status_failed` is absent from `summary.json`) |
| End-to-end processing latency | Not in this file. `e2e_observed_ms` was added after the run. |
| Queue backlog | Not in `summary.json`. See the post-run check below. |

Thresholds that passed: `http_req_failed` rate under 5%, `http_req_duration` p95 under 1,500 ms, checks above 90%.

`http_req_failed.fails` in the JSON is 11,317 with rate 0. In k6 that means the failure flag was false 11,317 times, not that 11,317 calls failed.

## What each number is

| Number | It is | It is not |
| --- | --- | --- |
| HTTP failure rate 0 | Every sampled HTTP call succeeded. | Proof that a job completed. |
| 4,439 HTTP 202 | Job creation. The API stored a job and returned `request_id`. | Vendor completion. |
| POST and GET durations | Latency of that HTTP call. | Time from accept until the worker stored a result. |
| 6,811 processing | Polls whose body said `processing`. | 6,811 distinct jobs. |
| 67 complete | Polls whose body said `complete`. | A count of jobs the worker finished. |
| No failed poll | No sampled GET returned `failed`. | Proof that no job failed after k6 stopped. |
| 4,112 queue messages | Backlog read from RabbitMQ immediately after this run. | A k6 metric. |
| 306 / 4,134 | MongoDB `complete` / `pending` a few minutes later, while the worker was still draining. | The final total, and not re-queryable. Those volumes were recreated later. |
| About 120 vendor calls | A capacity estimate: 2 grants/second × 60 seconds. | A measured k6 value. |

## What the numbers mean

The API accepted about 74 new jobs per second. The sync vendor is capped at 2 submissions per second, and the worker's shared limiter enforces that before the call. Worker logs after the test showed completions in pairs about one second apart, for example two `job_complete` lines at `14:31:40.103` and `14:31:40.139`, then the next pair at `14:31:41.198` and `14:31:41.233`. That is the 2-per-second window, not an API limit.

A check a few minutes after the run, while the worker was still draining, showed MongoDB at **306 complete**, **1 processing**, and **4,134 pending**. Immediately after the test the `jobs` queue held **4,112** messages and **1** consumer. Nothing was in the dead-letter queue. The 67 complete GET responses are polls that happened to land on a finished job. They are not the number of jobs the worker finished.

So request acceptance and job completion are different rates. POST only writes MongoDB and returns 202. Completion waits for a vendor slot. At 2 sync calls per second, a 60-second test can finish on the order of 120 vendor calls, while this run accepted 4,439 jobs. Most status checks correctly stayed on `processing`.

## Bottleneck

The vendor rate limit is the completion bottleneck. API latency stayed well under the threshold. One worker with prefetch 1 can feed a 2-per-second vendor. Extra workers share that same MongoDB window, so they are not expected to raise the cap. A two-worker run was not load-tested.

## Tuning

No limit was raised after the test. Prefetch stays 1, the vendor cap stays 2 per rolling second, and the k6 script keeps a 1-second pause so status checks are not a tight loop. The outbox publisher was already keeping the broker ahead of the worker, which is why thousands of jobs were `pending` in MongoDB and sitting in RabbitMQ.

## Later snapshot (30 October 2026)

This is not the load-test database. The volume from the 29 October run was recreated before this command. `MONGO_HOST_PORT=27018 node load-test/completion-snapshot.js` printed:

```json
{
  "note": "Stored job statuses, time from created_at to completed_at, and RabbitMQ depth. A 202 from POST /jobs is not a completed job.",
  "jobs_by_status": {
    "pending": 0,
    "processing": 0,
    "complete": 3,
    "failed": 0
  },
  "jobs_total": 3,
  "stored_processing_latency_ms": {
    "complete": {
      "jobs": 3,
      "min_ms": 732,
      "avg_ms": 1155.6666666666667,
      "max_ms": 1930
    }
  },
  "queue": {
    "name": "jobs",
    "messages": 0,
    "messages_ready": 0,
    "messages_unacknowledged": 0,
    "consumers": 1
  }
}
```

Those 3 completed jobs, and their 732–1,930 ms stored latencies, are whatever is in the database now. They are not the 4,439 jobs accepted by k6, and the empty queue is not the 4,112-message backlog. `e2e_observed_ms` was not collected for the k6 run.

## Async output path check (30 October 2026)

This is not a benchmark. The saved sync file was hashed, then this command ran with the README's `SUMMARY_PATH` plus `VUS=1` and `DURATION=1s`:

```text
docker run --rm -v "${PWD}:/work" -w /work grafana/k6 run -e BASE_URL=http://host.docker.internal:3100 -e VENDOR=async -e VUS=1 -e DURATION=1s -e SUMMARY_PATH=load-test/results/async-summary.json load-test/load-test.js
```

k6 exited 0. `summary.json` SHA-256 was `FBA4B8E0262B3E7D6F1ED59EB041CB2B7A41458BDCA42BCE2A4BBFEFD2EF519A` before and after. That file still has the same hash. The 1 VU check wrote `async-summary.json` with `vus_max` 1, `testRunDurationMs` 1130, `http_reqs` 1, and `jobs_created` 1. The 13 November run below replaced that file. It did not replace `summary.json`.

A snapshot immediately afterward printed 4 `complete` jobs, 0 pending, 0 processing, 0 failed, queue depth 0, and stored latency min 732 ms, avg 1078.75 ms, max 1930 ms. One of those four jobs is the path-check job. That snapshot does not replace the 3-job reading above or the 29 October benchmark.

## Async load test (13 November 2026)

This run was executed. k6 ran in the `grafana/k6` image against the Compose stack on host port 3100. The summary is `load-test/results/async-summary.json`. `summary.json` was not replaced.

```text
docker run --rm -v "<project>:/work" -w /work grafana/k6 run \
  -e BASE_URL=http://host.docker.internal:3100 \
  -e VENDOR=async \
  -e SUMMARY_PATH=load-test/results/async-summary.json \
  load-test/load-test.js
```

The scenario was **200 virtual users for 60 seconds** (`testRunDurationMs` 61,009), async vendor, one `sleep(1)` per iteration. k6 exited 0. Interrupted iterations were 0. Other containers were running on the same machine.

| Measure | Value |
| --- | --- |
| HTTP requests | 11,669 (191.27/s) |
| POST /jobs | 4,469, all HTTP 202 |
| GET /jobs/:id | 7,200, all HTTP 200 |
| HTTP failure rate | 0 |
| Check pass rate | 100% (11,669 checks) |
| Request duration | average 34.62 ms, median 16.76 ms, p95 115.45 ms, p99 414.98 ms, max 767.15 ms |
| POST duration | average 63.59 ms, p95 217.68 ms |
| GET duration | average 16.64 ms, p95 57.60 ms |
| GET bodies observed as processing | 7,126 |
| GET bodies observed as complete | 74 |
| Failed job responses | none recorded (`status_failed` is absent) |
| `e2e_observed_ms` | 30 samples, average 14,643 ms, median 14,858 ms, max 39,905 ms |
| `jobs_created` | 4,469 |

`http_req_failed.fails` is 11,669 with rate 0. In k6 that means the failure flag was false 11,669 times. The 74 `status_complete` values are polls, not 74 finished jobs. The 30 `e2e_observed_ms` samples include `sleep(1)` and miss every job that the same virtual user did not see complete before k6 stopped.

The worker kept draining after k6 exited. A snapshot after the backlog was gone showed MongoDB at **4,475 complete**, **0 pending**, **0 processing**, and **0 failed**. The `jobs` queue had **0** ready and **0** unacknowledged messages, with 1 consumer. Six of those completed documents existed before this test. The other **4,469** are the jobs this run created, and all 4,469 reached `complete`.

`stored_processing_latency_ms` on that snapshot was min 629 ms, average 1,211,193 ms (20.2 minutes), max 2,409,636 ms, across all 4,475 complete documents. That average is `completed_at` minus `created_at`. It includes time spent waiting in RabbitMQ. It is not the vendor HTTP call, and it is not `e2e_observed_ms`. The six older jobs are included; they do not account for a 20-minute average.

The API accepted about 73 jobs per second. The async vendor still allows 2 submissions in any rolling second, and the single worker waits for that grant before each call. Completion stayed near 2 jobs per second, so the queue held the rest until the worker finished them. No rate limit was raised.

## Limitations

- The 29 October benchmark is synchronous only. Its raw file is still `load-test/results/summary.json`.
- The 13 November benchmark is asynchronous only, one worker, prefetch 1. `docker compose up --scale worker=2` was not load-tested. Extra workers share the same 2-grant window; that was not measured.
- Docker Desktop on Windows, with other containers using CPU and the original host ports.
- Poll observations under-count completions. Final completion for the async run was read from MongoDB and RabbitMQ after the drain, not from `status_complete`.
- `e2e_observed_ms` was not collected for the 29 October sync run. The async file has 30 samples.
- The 4,112 / 306 / 4,134 figures were read once after the sync run. The database volume was recreated later, so they cannot be queried again.
- The sync backlog is gone with that volume. The async backlog is also gone: the queue is empty and the 4,469 load-test jobs are stored as `complete`.
