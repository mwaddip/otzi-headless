import { afterEach, describe, expect, it } from 'vitest';
import { CronTrigger } from './cron';
import { HttpTrigger } from './http';
import type { HttpHandler, HttpRequest } from './types';

// ─────────────────────────────────────────────────────────────────────────
// HTTP trigger
// ─────────────────────────────────────────────────────────────────────────

async function startServer(handler: HttpHandler, extras: { authTokenEnv?: string } = {}) {
  const trigger = new HttpTrigger({
    bind: '127.0.0.1:0',
    handler,
    authTokenEnv: extras.authTokenEnv,
  });
  await trigger.start();
  const addr = trigger.address()!;
  const baseUrl = `http://${addr.host}:${addr.port}`;
  return { trigger, baseUrl };
}

describe('HttpTrigger — bind parsing', () => {
  it('rejects bind without port', () => {
    expect(() => new HttpTrigger({ bind: '127.0.0.1', handler: async () => ({ status: 200 }) })).toThrow(
      /expected 'host:port'/,
    );
  });
  it('rejects bind with out-of-range port', () => {
    expect(() => new HttpTrigger({ bind: '127.0.0.1:99999', handler: async () => ({ status: 200 }) })).toThrow(
      /invalid port/,
    );
  });
  it('rejects bind with empty host', () => {
    expect(() => new HttpTrigger({ bind: ':7080', handler: async () => ({ status: 200 }) })).toThrow(
      /invalid bind|host required/,
    );
  });
});

describe('HttpTrigger — request handling', () => {
  let cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanup.map((f) => f()));
    cleanup = [];
  });

  it('parses JSON body and returns handler response', async () => {
    let received: HttpRequest | null = null;
    const { trigger, baseUrl } = await startServer(async (req) => {
      received = req;
      return { status: 200, body: { echoed: req.body } };
    });
    cleanup.push(() => trigger.stop());

    const res = await fetch(`${baseUrl}/ceremony`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'btc-transfer', amount: 50000 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echoed: { op: 'btc-transfer', amount: 50000 } });
    expect(received!.method).toBe('POST');
    expect(received!.path).toBe('/ceremony');
    expect(received!.body).toEqual({ op: 'btc-transfer', amount: 50000 });
    expect(received!.headers['content-type']).toMatch(/application\/json/);
  });

  it('handles empty body (null)', async () => {
    let receivedBody: unknown = 'sentinel';
    const { trigger, baseUrl } = await startServer(async (req) => {
      receivedBody = req.body;
      return { status: 200 };
    });
    cleanup.push(() => trigger.stop());

    const res = await fetch(`${baseUrl}/`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(receivedBody).toBeNull();
  });

  it('returns 400 on invalid JSON body', async () => {
    const { trigger, baseUrl } = await startServer(async () => ({ status: 200 }));
    cleanup.push(() => trigger.stop());

    const res = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid JSON/);
  });

  it('returns 500 when handler throws', async () => {
    const { trigger, baseUrl } = await startServer(async () => {
      throw new Error('boom');
    });
    cleanup.push(() => trigger.stop());

    const res = await fetch(`${baseUrl}/`, { method: 'GET' });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/handler error/);
  });

  it('passes through handler-specified status and body', async () => {
    const { trigger, baseUrl } = await startServer(async () => ({ status: 404, body: { error: 'no such thing' } }));
    cleanup.push(() => trigger.stop());

    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no such thing' });
  });
});

describe('HttpTrigger — auth', () => {
  let cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanup.map((f) => f()));
    cleanup = [];
    delete process.env.OTZI_TEST_TOKEN;
  });

  it('fails to start when authTokenEnv is set but env var missing', async () => {
    delete process.env.OTZI_TEST_TOKEN;
    const trigger = new HttpTrigger({
      bind: '127.0.0.1:0',
      handler: async () => ({ status: 200 }),
      authTokenEnv: 'OTZI_TEST_TOKEN',
    });
    await expect(trigger.start()).rejects.toThrow(/env var.*not set/);
  });

  it('rejects requests without Bearer token (401)', async () => {
    process.env.OTZI_TEST_TOKEN = 'secret-42';
    const { trigger, baseUrl } = await startServer(async () => ({ status: 200 }), { authTokenEnv: 'OTZI_TEST_TOKEN' });
    cleanup.push(() => trigger.stop());

    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(401);
  });

  it('rejects requests with wrong token (401)', async () => {
    process.env.OTZI_TEST_TOKEN = 'secret-42';
    const { trigger, baseUrl } = await startServer(async () => ({ status: 200 }), { authTokenEnv: 'OTZI_TEST_TOKEN' });
    cleanup.push(() => trigger.stop());

    const res = await fetch(`${baseUrl}/`, { headers: { authorization: 'Bearer wrong' } });
    expect(res.status).toBe(401);
  });

  it('accepts requests with correct Bearer token', async () => {
    process.env.OTZI_TEST_TOKEN = 'secret-42';
    const { trigger, baseUrl } = await startServer(async () => ({ status: 200, body: { ok: true } }), {
      authTokenEnv: 'OTZI_TEST_TOKEN',
    });
    cleanup.push(() => trigger.stop());

    const res = await fetch(`${baseUrl}/`, { headers: { authorization: 'Bearer secret-42' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('HttpTrigger — lifecycle', () => {
  it('double-start is idempotent; double-stop is idempotent', async () => {
    const { trigger } = await startServer(async () => ({ status: 200 }));
    await trigger.start();
    await trigger.stop();
    await trigger.stop();
  });

  it('address() is null before start and after stop', async () => {
    const trigger = new HttpTrigger({
      bind: '127.0.0.1:0',
      handler: async () => ({ status: 200 }),
    });
    expect(trigger.address()).toBeNull();
    await trigger.start();
    expect(trigger.address()).not.toBeNull();
    await trigger.stop();
    expect(trigger.address()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cron trigger
// ─────────────────────────────────────────────────────────────────────────

describe('CronTrigger — scheduling', () => {
  it('rejects invalid cron expressions at construction', () => {
    expect(
      () =>
        new CronTrigger({
          jobName: 'bad',
          schedule: 'not a cron expression',
          handler: async () => {},
        }),
    ).toThrow();
  });

  it('nextRun() is null before start', () => {
    const t = new CronTrigger({
      jobName: 'daily',
      schedule: '0 0 * * *',
      handler: async () => {},
    });
    expect(t.nextRun()).toBeNull();
  });

  it('nextRun() returns a future Date after start', () => {
    const t = new CronTrigger({
      jobName: 'daily',
      schedule: '0 0 * * *',
      handler: async () => {},
    });
    t.start();
    try {
      const next = t.nextRun();
      expect(next).toBeInstanceOf(Date);
      expect(next!.getTime()).toBeGreaterThan(Date.now());
    } finally {
      t.stop();
    }
  });

  it('fires the handler on its schedule (every-second expression)', async () => {
    let ticks = 0;
    const firedNames: string[] = [];
    const t = new CronTrigger({
      jobName: 'heartbeat',
      schedule: '* * * * * *', // every second (6-field)
      handler: async (tick) => {
        ticks += 1;
        firedNames.push(tick.jobName);
      },
    });
    t.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 2_200));
      expect(ticks).toBeGreaterThanOrEqual(1);
      expect(firedNames.every((n) => n === 'heartbeat')).toBe(true);
    } finally {
      t.stop();
    }
  }, 5_000);

  it('stop() prevents further firings', async () => {
    let ticks = 0;
    const t = new CronTrigger({
      jobName: 'stoppable',
      schedule: '* * * * * *',
      handler: async () => {
        ticks += 1;
      },
    });
    t.start();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    t.stop();
    const ticksAtStop = ticks;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(ticks).toBe(ticksAtStop);
  }, 5_000);

  it('handler errors are caught and do not crash the scheduler', async () => {
    let calls = 0;
    const t = new CronTrigger({
      jobName: 'flaky',
      schedule: '* * * * * *',
      handler: async () => {
        calls += 1;
        throw new Error('deliberate');
      },
    });
    t.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 2_200));
      // Handler should have fired at least twice despite errors each time.
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      t.stop();
    }
  }, 5_000);

  it('double-start is idempotent; double-stop is idempotent', () => {
    const t = new CronTrigger({
      jobName: 'idempotent',
      schedule: '0 0 * * *',
      handler: async () => {},
    });
    t.start();
    t.start();
    t.stop();
    t.stop();
  });
});
