# Multi-Vendor Data Fetch Service

A Node.js service that accepts jobs through one API and processes them with a RabbitMQ worker. It has exactly two mock vendors: `sync`, which returns the result in the vendor HTTP call, and `async`, which accepts the job and later posts an HMAC-SHA256 webhook. Both share a MongoDB rolling-window limit of two calls per vendor per second.

## Architecture

```text
Client -> Express API -> MongoDB (jobs + outbox) -> RabbitMQ -> Worker
                                                         +-> sync vendor -> HTTP result -> MongoDB
                                                         \-> async vendor -> webhook -> MongoDB
```

## Stack

Node.js 20 or newer, Express, a MongoDB replica set, RabbitMQ, Docker Compose, k6, and the Node.js built-in test runner.

## Quick start

Prerequisites: Docker Desktop. Node.js and npm are needed for the tests and the completion snapshot, not for the containers. k6 is optional; the recorded runs used the `grafana/k6` image.

Copy `.env.example` to `.env` only when you run a process on the host. Those values are local defaults. Compose injects its own settings and does not read that file.

This workspace publishes the API on host port 3100 and MongoDB on 27018 because 3000 and 27017 were already in use:

```powershell
git clone https://github.com/MeenakshiTripathi01/Multi-Vendor-data-fetch-service.git
cd Multi-Vendor-data-fetch-service
$env:API_HOST_PORT = "3100"
$env:MONGO_HOST_PORT = "27018"
docker compose up --build
```

The API process listens on container port 3000. Compose publishes that as host port 3000 when `API_HOST_PORT` is unset, and MongoDB as 27017 when `MONGO_HOST_PORT` is unset. Containers still call each other by service name. The examples below use host port 3100.

RabbitMQ is published on 5672. Its management UI is `http://localhost:15672`. The Compose user is `vendor` / `vendor`. The image's `guest` user cannot be used from another container. Sync and async mocks are on host ports 4001 and 4002.

`docker compose down` stops the stack and keeps the volumes. Adding `-v` deletes the MongoDB and RabbitMQ data.

## API

| Call | Result |
| --- | --- |
| `POST /jobs` | `202 {"request_id":"<uuid>"}` after the job and outbox row are stored |
| `GET /jobs/:request_id` while `pending` or `processing` | `200 {"status":"processing"}` |
| `GET /jobs/:request_id` when complete | `200 {"status":"complete","result":{...}}` |
| `GET /jobs/:request_id` when failed | `200 {"status":"failed","error_code":"<code>"}` |
| Unknown id | `404 {"error":"job_not_found"}` |
| Malformed JSON | `400 {"error":"invalid_json"}` |
| Unknown vendor | `400 {"error":"invalid_vendor"}` |
| Id that is not a UUID v4 | `400 {"error":"invalid_request_id"}` |
| `GET /health` when MongoDB answers | `200 {"status":"ok"}` |
| `GET /health` when MongoDB does not answer | `503 {"status":"unavailable"}` |

Public `error_code` values are `vendor_timeout`, `vendor_unavailable`, `invalid_vendor_response`, `rate_limited`, `max_retries_exceeded`, `vendor_rejected`, and `queue_unavailable`. Any other stored code is returned as `vendor_unavailable`.

`vendor` is `sync` or `async`. If it is omitted, the job is `sync`. A `?vendor=` query parameter overrides the JSON field. Other JSON fields are stored and forwarded. `scenario` selects a mock behaviour and defaults to `success`.

| `scenario` | Where | What the mock does |
| --- | --- | --- |
| `success` | both | Sync returns the sample record. Async accepts, then webhooks that record. |
| `rate_limit` | both | `429` and `Retry-After` |
| `server_error` | both | `500` |
| `malformed` | both | HTTP 200 with plain text, which the worker treats as an invalid vendor response |
| `timeout` | sync only | Sleeps, then returns JSON. The worker HTTP timeout is 2000 ms, so this path times out. |
| `fail` | async only | Accepts, then webhooks `status: "failed"` with `vendor_rejected` |

```powershell
curl.exe -X POST http://localhost:3100/jobs -H "Content-Type: application/json" -d '{"vendor":"sync","customer":"Alice"}'
```

```powershell
curl.exe -X POST http://localhost:3100/jobs -H "Content-Type: application/json" -d '{"vendor":"async","customer":"Alice"}'
```

```powershell
curl.exe http://localhost:3100/jobs/YOUR_REQUEST_ID
```

```powershell
curl.exe http://localhost:3100/health
```

When Compose is started without `API_HOST_PORT`, use port 3000 in those URLs.

## Design

`POST /jobs` inserts the job and an outbox row in one MongoDB transaction on the replica set, then returns. It does not call a vendor. The publisher confirms the persistent RabbitMQ message and then marks the outbox row published. A crash after the confirm and before that flag can deliver the same job twice. The worker treats the duplicate as the same job. A sweeper recreates a missing outbox row for an old pending job. After `OUTBOX_MAX_ATTEMPTS` (10), the job is marked `failed` with `queue_unavailable`.

Queues are durable. The worker uses manual acknowledgements and prefetch 1. A sync job is acknowledged only after the cleaned result is saved. An async job is acknowledged after `vendor_job_id` is saved, which leaves the job `processing` until the webhook. Permanent failures and exhausted retries are saved, then dead-lettered on `jobs.dlq`. Nothing consumes that queue. Transient failures are acknowledged only after a delayed retry message is published. The delay queues are 1, 2, 4, 8, and 16 seconds. `Retry-After` can select a longer slot. Attempts stop at `WORKER_MAX_ATTEMPTS` (5).

A claim sets `lock_token` and a 15-second lease. The worker's result and failure writes match that token, so a late write cannot replace a newer terminal state. If the worker dies before acknowledgement, RabbitMQ redelivers. A job already `complete` or `failed`, or an async job that already has `vendor_job_id`, is acknowledged with no second vendor call. If the crash happened before that write, the vendor can be called again.

Each vendor gets at most 2 grants in any rolling 1000 ms. Grants live on one MongoDB document per vendor and commit with a compare-and-swap on `version`, so every worker shares the window. The mocks also enforce a window inside their own process and can return `429`. The worker waits for a grant before calling. Two submissions per second is the vendor cap, not the API's accept rate. `POST /jobs` only writes MongoDB, so a load test can accept far more jobs than the worker can finish. Extra workers share the same window: `docker compose up --build --scale worker=2`. That shape was not load-tested.

`POST /vendor-webhook/async` requires `X-Vendor-Signature: sha256=<HMAC-SHA256 of the raw body>` using `WEBHOOK_SECRET`. A bad signature is `401` and does not change the job. The first `complete` or `failed` write wins. A repeat delivery returns `200 {"status":"duplicate"}`. A persistence error returns `500`, and the mock retries `429` and `5xx`. It does not retry other `4xx`.

Vendor results are copied, strings are trimmed, and `email`, `phone`, and `ssn` at any depth become `[REDACTED]`. The vendor object is not mutated. Free text, custom field names, unlabeled strings, and the stored request payload are not scrubbed. `GET` returns the cleaned result, not the original request.

## Tests

```powershell
npm.cmd install
npm.cmd test
npm.cmd run test:integration
npm.cmd run test:all
```

`npm test` runs the unit tests for cleaning, vendor selection, retry timing, webhook signatures, and the mock windows. It does not need Docker. `npm run test:integration` starts an in-memory MongoDB replica set and the two mock apps, and calls the worker function through a fake RabbitMQ channel. It does not call a real external vendor or the Compose broker. The first integration run downloads a MongoDB binary.

## Load testing

Run these from the project directory with the stack already up. The script defaults to 200 virtual users for 60 seconds, mixes creates and status polls, uses `http://localhost:3000`, and writes `load-test/results/summary.json`. The recorded runs used host port 3100.

Sync, which writes the historical sync summary:

```powershell
docker run --rm -v "${PWD}:/work" -w /work grafana/k6 run -e BASE_URL=http://host.docker.internal:3100 -e VENDOR=sync load-test/load-test.js
```

Async, which writes a separate file:

```powershell
docker run --rm -v "${PWD}:/work" -w /work grafana/k6 run -e BASE_URL=http://host.docker.internal:3100 -e VENDOR=async -e SUMMARY_PATH=load-test/results/async-summary.json load-test/load-test.js
```

Running either command again replaces that summary file. The saved sync file has 11,317 HTTP requests and an HTTP failure rate of 0. The saved async file has 11,669 HTTP requests and an HTTP failure rate of 0. Those counts are HTTP calls, not finished jobs. The sync file has 4,439 `POST` checks that returned 202 and 6,878 `GET` checks that returned 200. The async file has `jobs_created` 4,469, which means the API accepted 4,469 jobs. `status_complete` is 67 in the sync file and 74 in the async file: those are polls whose body said `complete`, not distinct completed jobs. The sync file has no `e2e_observed_ms` samples. The async file has 30, and each sample includes `sleep(1)`. Notes are in `load-test/analysis.md`. The k6 console transcript was not saved.

With the stack up and dependencies installed, the current database and queue can be read without creating jobs:

```powershell
$env:MONGO_HOST_PORT = "27018"
node load-test/completion-snapshot.js
```

The script uses `directConnection=true` because the replica set advertises the hostname `mongo`. Its RabbitMQ default is `http://127.0.0.1:15672` as user `vendor`. A snapshot describes the database at that moment. It does not reconstruct either saved k6 run.

## Trade-offs

Processing is at-least-once, not exactly-once. Clients poll for job status. There is no client idempotency key, so the same logical request posted twice creates two jobs. The public job API has no authentication. The async mock remembers `request_id` only in memory, so a vendor restart can accept the same id again. Rate-limit timestamps use each process clock. The dead-letter queue has no consumer.
