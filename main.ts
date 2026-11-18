// Entry point: the harness lifecycle for this forge.
//
// The trial pod runs this file and nothing else knows about it. Its whole job is
// to get the forge (built in app.ts) reachable by the suite, then stay alive
// until the suite says the trial is over:
//
//   1. Read MAKEFUN_ENV_URL. It names the suite's sidecar origin. With no env
//      URL there is nobody to talk to, so fail fast instead of idling.
//   2. Start the forge on a kernel-chosen ephemeral port. Port 0 means the
//      kernel picks; 8080 belongs to the sidecar and must never be taken.
//   3. Tell the sidecar the chosen port with POST /register. The sidecar
//      records the request's source address plus that port as the forge's
//      base URL, and dials it from then on.
//   4. Poll GET /done until the sidecar answers {"done": true}. Only then
//      shut the server down and leave with status 0.
//
// The forge itself is app.ts's business; this file only owns the lifecycle.

import { createApp } from './app.ts';

// The sidecar origin, with any trailing slashes trimmed so URL joins stay clean.
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is unset, so there is no suite to join\n');
  process.exit(1);
}

// One HTTP round trip may take at most this long before it is abandoned and retried.
const REQUEST_BUDGET_MS = 30_000;
// Backoff starts here and doubles per failed attempt, never passing the cap below.
const BACKOFF_START_MS = 250;
const BACKOFF_CAP_MS = 2_000;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Wait after `failures` consecutive failed attempts: 250, 500, 1000, 2000, 2000, ...
function backoffFor(failures: number): number {
  const step = Math.min(failures, 8);
  return Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** step);
}

// Tell the sidecar which port the forge bound. A 200 means the port was recorded.
// A 409 means some entry already registered first; that is not ours to fix, and the
// process keeps waiting like any other. 400/405 mean the request itself broke the
// contract, so give up at once. Anything else (a refused connection, a timeout, an
// unexpected status) just means the sidecar is not ready yet: wait and try again.
async function announce(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
    } catch {
      await pause(backoffFor(failures));
      failures += 1;
      continue;
    }
    if (response.status === 200 || response.status === 409) return;
    if (response.status === 400 || response.status === 405) {
      throw new Error(`register was rejected with HTTP ${response.status}: ${await response.text()}`);
    }
    await pause(backoffFor(failures));
    failures += 1;
  }
}

// Keep asking GET /done until the sidecar says the trial is finished. The sidecar
// answers immediately ({"done": false} while the suite is still running), so this
// is a poll with backoff, not a held-open request. A failed or slow poll is not a
// "done" — it is just another attempt.
async function waitUntilFinished(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const response = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // Not answering yet, or the poll timed out: still not done.
    }
    await pause(backoffFor(failures));
    failures += 1;
  }
}

// Start the forge, announce it, then wait for the suite to finish with it.
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the forge did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[forge] serving on port ${bound.port}\n`);

  await announce(bound.port);
  process.stdout.write('[forge] announced; waiting for the suite to finish\n');

  await waitUntilFinished();
  server.close();
  process.stdout.write('[forge] finished\n');
}

try {
  await run();
  process.exit(0);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[forge] ${detail}\n`);
  process.exit(1);
}
