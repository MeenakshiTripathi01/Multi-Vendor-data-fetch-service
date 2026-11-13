# Multi-vendor data fetch

Clients submit a JSON payload and receive a `request_id` immediately. A worker calls either a synchronous mock vendor or an asynchronous mock vendor. Both paths store one cleaned result in MongoDB. `GET /jobs/:request_id` is the only status API.

```
Client
  |  POST /jobs                         GET /jobs/:request_id
  v
Express API ---- MongoDB transaction: job + outbox row
  |                     |
  | 202 {request_id}    | outbox publisher (confirmed publish)
  |                     v
  |                  RabbitMQ durable queue
  |                     |
  |                     v
  |                  Worker (manual ack, shared rate limit)
  |                    |                         \
  |                    v                          v
  |             Sync vendor HTTP            Async vendor HTTP
  |             result in the response      202 + vendor_job_id
  |                    |                          |
  |                    |                          | signed callback
  |                    v                          v
  |                 clean result            POST /vendor-webhook/async
  |                    \                          /
  |                     v                        v
  |                        MongoDB jobs collection
```

## Prerequisites

- Node.js 20 or newer
- Docker with Docker Compose
- k6 is optional. The load-test command below uses the `grafana/k6` image.

## Setup

```bash
docker compose up --build
```

MongoDB and RabbitMQ start inside Compose. Nothing else needs to be installed locally for the stack itself. Copy `.env.example` to `.env` only if you run a process on the host. The example values are local development defaults, not production secrets.

Stop the stack with `docker compose down`. Add `-v` to delete MongoDB and RabbitMQ data volumes.

Compose publishes the API on host port 3000 when `API_HOST_PORT` is unset, and MongoDB on 27017 when `MONGO_HOST_PORT` is unset. If either port is already taken, set those variables to free ports. Containers still talk to each other on the internal ports. This workspace started with `API_HOST_PORT=3100` and `MONGO_HOST_PORT=27018`, so the examples below use those host ports.

RabbitMQ uses the user `vendor` / `vendor` because the image's default `guest` user refuses connections from other containers. The management UI is `http://localhost:15672`.

## API

| Call | Result |
| --- | --- |
| `POST /jobs` | `202 {"request_id":"<uuid>"}` |
| `GET /jobs/:request_id` while pending or processing | `200 {"status":"processing"}` |
| `GET /jobs/:request_id` when complete | `200 {"status":"complete","result":{...}}` |
| `GET /jobs/:request_id` when failed | `200 {"status":"failed","error_code":"<safe code>"}` |
| Unknown id | `404 {"error":"job_not_found"}` |
| Malformed JSON or a bad id | `400` |

Public failure codes: `vendor_timeout`, `vendor_unavailable`, `invalid_vendor_response`, `rate_limited`, `max_retries_exceeded`, `vendor_rejected`, `queue_unavailable`.

`vendor` is `sync` (default) or `async`. A query parameter overrides the JSON field. `scenario` on the JSON body drives the mocks: `success`, `rate_limit`, `server_error`, `timeout`, `malformed`, and `fail` (async callback failure).

### Examples

These four calls use `http://localhost:3100` because that is the published API port in this workspace. When `API_HOST_PORT` is unset, Compose publishes the API on port 3000, and the same paths belong on `http://localhost:3000`.

```bash
curl -s -X POST http://localhost:3100/jobs \
  -H 'content-type: application/json' \
  -d '{"vendor":"sync","customer":"Ada"}'

curl -s -X POST http://localhost:3100/jobs \
  -H 'content-type: application/json' \
  -d '{"vendor":"async","customer":"Grace"}'

curl -s http://localhost:3100/jobs/PASTE_REQUEST_ID_HERE

curl -s -i http://localhost:3100/jobs/not-a-uuid
```

## Tests

```bash
npm test
npm run test:integration
npm run test:all
```

Unit tests do not need Docker. Integration tests start an in-memory MongoDB replica set and the mock vendors. They do not call a real external vendor. The first integration run downloads a MongoDB binary.

## Load test

Run these from the project directory with the stack already up. Compose publishes the API on port 3000 unless `API_HOST_PORT` is set. `docker compose ps` on this workspace shows `3100->3000`, and the saved run used `3100`.

PowerShell, synchronous vendor (the saved 200 VU / 60s run used this vendor):

```powershell
# Change 3100 to 3000 when Compose was started without API_HOST_PORT.
$apiPort = "3100"
docker run --rm -v "${PWD}:/work" -w /work grafana/k6 run -e "BASE_URL=http://host.docker.internal:$apiPort" -e "VENDOR=sync" load-test/load-test.js
```

`${PWD}` is the project directory. The k6 container reaches the host through `host.docker.internal`.

The same script targets the asynchronous vendor when `VENDOR=async`. That does not change the sync default. The saved async run is 200 virtual users for 60 seconds, and its raw output is `load-test/results/async-summary.json`:

```powershell
# Same host port as the sync command. SUMMARY_PATH keeps the saved sync file.
$apiPort = "3100"
docker run --rm -v "${PWD}:/work" -w /work grafana/k6 run -e "BASE_URL=http://host.docker.internal:$apiPort" -e "VENDOR=async" -e "SUMMARY_PATH=load-test/results/async-summary.json" load-test/load-test.js
```

`SUMMARY_PATH` keeps that run from replacing `load-test/results/summary.json`.

k6 numbers are not job-completion numbers:

| What you see | What it means |
| --- | --- |
| `http_req_failed` near 0 | The HTTP call returned. The vendor may not have run. |
| `jobs_created` and HTTP 202 | The API accepted a job. This is job creation, not completion. |
| `post_job_duration`, `get_job_duration` | Latency of that one HTTP call. |
| `status_processing`, `status_complete`, `status_failed` | How many polls saw that body. One finished job can be counted more than once. Jobs that nobody polled are missing. |
| `e2e_observed_ms` | Time from this virtual user's HTTP 202 until a later GET by that same user returns `complete`. The sample includes `sleep(1)` and any time spent polling other ids. A job still queued, or one this user never polls again, is absent. The saved sync `summary.json` has no `e2e_observed_ms` samples. The async file has 30. |
| Queue depth | Not in the k6 file. The snapshot script reads RabbitMQ at the moment it runs. That depth is the current backlog, not the 4,112 messages recorded after the saved run. |

`status_complete` is not a completion count. The snapshot field `jobs_by_status.complete` is how many `complete` documents are stored when the script runs, including jobs created outside k6. `stored_processing_latency_ms` is `completed_at` minus `created_at` on those stored documents. It is not `e2e_observed_ms`, and it does not reconstruct the saved run.

The snapshot needs the Compose stack already up, `npm install` so Node can load `mongodb`, and the host ports below. It connects to MongoDB with `directConnection=true` because the replica set advertises the Docker hostname `mongo`, which the host cannot resolve. RabbitMQ's management API must be reachable at `http://127.0.0.1:15672` with the Compose user `vendor` / `vendor`. The script's own defaults are MongoDB port 27017 and management port 15672. This workspace publishes MongoDB on 27018:

```powershell
$env:MONGO_HOST_PORT = "27018"
node load-test/completion-snapshot.js
```

See `load-test/analysis.md` for the saved sync run and the 13 November async run. The async backlog later drained to 0 pending, 0 processing, 0 failed, and 0 queue messages. Those 4,469 load-test jobs are stored as `complete`, along with 6 older completed jobs.

## Design

- **Outbox.** `POST /jobs` inserts the job and an outbox row in one MongoDB transaction, then returns 202. A publisher loop confirms the RabbitMQ publish and marks the row published. That is not a distributed transaction. A crash after the broker confirm and before the published flag can deliver the same job twice. The worker treats that as one job. If the outbox row is missing, a sweeper recreates it for pending jobs. If the broker still cannot accept the message after repeated tries, the job is marked `failed` with `queue_unavailable` instead of being dropped.
- **Manual acks.** The worker acks a sync job only after the cleaned result is saved, and acks an async job only after `vendor_job_id` is saved. The async acknowledgement does not complete the job. Exhausted or permanent failures are written to MongoDB and then dead-lettered (`jobs.dlq`). Transient failures are acked only after a delayed retry message is published. Retry delays are 1s, 2s, 4s, 8s, and 16s, and `Retry-After` can push the delay higher. Attempts stop at `WORKER_MAX_ATTEMPTS` (default 5).
- **Crash after the vendor responds.** If the worker dies before ack, RabbitMQ redelivers. A terminal job, or an async job that already has `vendor_job_id`, is acked with no second vendor call. If the crash was before that write, the vendor may be called again. Updates include the lock token and the current status, so a late write cannot replace a newer terminal result.
- **Rate limit.** Each vendor allows 2 grants in any rolling 1000ms window. Grants are stored on one MongoDB document per vendor and committed with a compare-and-swap on `version`, so every worker replica shares the same window. The mock vendors enforce the same window inside their own process and answer `429` with `Retry-After`. The worker waits for a free slot before calling, and still honors a vendor `429`.
- **Throughput.** Two submissions per second is not the same as two completed jobs per second of API capacity. `POST /jobs` only writes MongoDB. Sync jobs then wait for a vendor slot, so completion stays near 2 jobs/second/vendor. Async jobs also wait for `ASYNC_VENDOR_DELAY_MS` after the submission slot. A load test can accept far more jobs than it can finish. Most `GET` responses during that test will say `processing`.
- **Cleaning.** Vendor results are copied, string fields are trimmed, and `email`, `phone`, and `ssn` (any depth, any casing) become `[REDACTED]`. The original object is not changed. Free text, custom field names, and the stored request payload are not scrubbed. Logs record request ids and status codes, not payloads or vendor bodies.
- **Webhook.** `POST /vendor-webhook/async` requires `X-Vendor-Signature: sha256=<HMAC-SHA256 of the raw body>` using `WEBHOOK_SECRET`. Invalid signatures are `401`. The first terminal state wins. A repeat delivery returns `200` and does not overwrite the result. A persistence error returns `500` so the mock vendor retries with backoff. `4xx` other than `429` is not retried.
- **One worker, prefetch 1.** That is the default so a single process does not hold a pile of unacked messages. Extra replicas still share the MongoDB limiter: `docker compose up --build --scale worker=2`.

## Known limitations

- Posting the same logical request twice creates two jobs. There is no client idempotency key.
- The async mock remembers `request_id` only in memory. A vendor restart can create a second vendor job.
- Rate-limit timestamps use each host's clock. Large clock skew can nudge the shared window.
- Request payloads are stored as submitted so the worker can forward them. `GET` does not return them.
- Load-test numbers are in `load-test/analysis.md`. HTTP 202 is acceptance. `status_complete` counts polls, not finished jobs. `e2e_observed_ms` includes client sleep and misses jobs the same virtual user does not see complete. Queue depth comes only from `completion-snapshot.js` and only for the database that exists at that moment. The 29 October run is synchronous. The 13 November run is asynchronous, and its backlog later reached 0 with all 4,469 load-test jobs stored as `complete`. A multi-worker load test was not executed.
