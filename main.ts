// Anvil's entrypoint: the entry <-> env lifecycle.
//
// The trial runs this file as `node /bot/main.ts`. It binds an ephemeral port, tells the
// env which port it bound, serves until the env says the trial is done, then exits 0.
// Nothing here knows about repositories, issues or packs: that lives in app.ts.
//
// Two modes:
//   - Trial mode (MAKEFUN_ENV_URL set): register the port, poll /done, exit 0 on done.
//   - Standalone mode (MAKEFUN_ENV_URL unset): listen on $PORT (or an ephemeral port) and
//     serve until killed. This is only for local runs against the kit's sdk/run.ts runner.
//
// The register/done exchange retries with exponential backoff, because the env may still
// be starting when this process binds. A 409 from /register means another entry already
// registered; that is not this process's to fix, so it waits like any other.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const STANDALONE_PORT = Number(process.env.PORT ?? 0);

/** One request may take this long before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** First retry wait, and the cap it grows to. */
const RETRY_FIRST_MS = 250;
const RETRY_CAP_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The wait after `attempt` failed requests: 250ms, doubling, capped at 2s. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer; 409 means a
 * first register already won. 400/405 are contract errors and end the process; anything
 * else (including a refused connection while the env starts) is retried.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

/** Bind, register, serve until done, then close and exit 0. */
async function run(): Promise<void> {
  const { server } = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(ENV_URL === '' ? STANDALONE_PORT : 0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind a TCP port');
  }
  process.stdout.write(`[anvil] listening on port ${address.port}\n`);

  if (ENV_URL === '') {
    // Standalone: no env to register with. Serve until the process is killed.
    process.stdout.write('[anvil] standalone mode (MAKEFUN_ENV_URL unset); serving until killed\n');
    await new Promise<void>((resolve) => {
      const stop = (): void => {
        server.close(() => resolve());
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    return;
  }

  await register(address.port);
  process.stdout.write('[anvil] registered; waiting for the env to say done\n');
  await waitForDone();
  server.close();
  process.stdout.write('[anvil] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[anvil] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
