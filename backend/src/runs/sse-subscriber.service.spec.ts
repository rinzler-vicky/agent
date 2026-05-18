import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { MessageEvent } from '@nestjs/common';
import { firstValueFrom, take, toArray, lastValueFrom, timer } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { SseSubscriberService, NotifyPayload } from './sse-subscriber.service';
import { DATABASE_POOL } from '@/database/database.module';

const RUN = '11111111-1111-1111-1111-111111111111';
const TENANT = '22222222-2222-2222-2222-222222222222';

interface MockClient {
  query: jest.Mock;
  release: jest.Mock;
}

interface MockPool {
  connect: jest.Mock;
  client: MockClient;
}

const makeMockPool = (
  rowsByCall: Array<{ rows: any[] }> = [],
): MockPool => {
  const queue = [...rowsByCall];
  const client: MockClient = {
    query: jest.fn().mockImplementation((sql: string) => {
      if (sql.startsWith('BEGIN') || sql.startsWith('SELECT set_config') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve(queue.shift() ?? { rows: [] });
    }),
    release: jest.fn(),
  };
  return {
    connect: jest.fn().mockResolvedValue(client),
    client,
  };
};

const buildService = async (
  pool: MockPool,
  heartbeatMs = 1_000_000, // disable in tests
): Promise<SseSubscriberService> => {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      SseSubscriberService,
      { provide: DATABASE_POOL, useValue: pool },
      {
        provide: ConfigService,
        useValue: {
          get: (k: string) => (k === 'SSE_HEARTBEAT_MS' ? String(heartbeatMs) : ''),
        },
      },
    ],
  }).compile();
  return module.get(SseSubscriberService);
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('SseSubscriberService', () => {
  describe('subscribe + backfill', () => {
    it('backfills events with sequence > lastEventId in order', async () => {
      const pool = makeMockPool([
        {
          rows: [
            { id: 'e2', sequence: 2, event_type: 'step.started', event_data: { a: 1 }, step_run_id: null, occurred_at: '2026-05-18T10:00:01Z' },
            { id: 'e3', sequence: 3, event_type: 'step.completed', event_data: { a: 2 }, step_run_id: null, occurred_at: '2026-05-18T10:00:02Z' },
          ],
        },
      ]);
      const svc = await buildService(pool);
      const obs$ = svc.subscribe(RUN, TENANT, 1);
      const events = await firstValueFrom(obs$.pipe(take(2), toArray()));
      expect(events.map((e) => e.id)).toEqual(['2', '3']);
      expect(events.map((e) => e.type)).toEqual(['step.started', 'step.completed']);
    });

    it('starts from sequence 0 when no lastEventId is provided', async () => {
      const pool = makeMockPool([
        { rows: [{ id: 'e1', sequence: 1, event_type: 'workflow.started', event_data: {}, step_run_id: null, occurred_at: '2026-05-18T10:00:00Z' }] },
      ]);
      const svc = await buildService(pool);
      const obs$ = svc.subscribe(RUN, TENANT);
      const ev = await firstValueFrom(obs$.pipe(take(1)));
      expect(ev.id).toBe('1');
      // Verify the SQL parameters used afterSequence=0
      const backfillCall = pool.client.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('FROM run_events'),
      );
      expect(backfillCall?.[1]).toEqual([RUN, 0]);
    });
  });

  describe('fan-out + de-dup', () => {
    it('de-duplicates a live notification whose sequence was already backfilled', async () => {
      // Backfill returns seq=1,2. Then a live NOTIFY at seq=2 arrives. Only
      // the original 2 events should be emitted.
      const pool = makeMockPool([
        {
          rows: [
            { id: 'e1', sequence: 1, event_type: 'workflow.started', event_data: {}, step_run_id: null, occurred_at: 't1' },
            { id: 'e2', sequence: 2, event_type: 'step.started', event_data: {}, step_run_id: null, occurred_at: 't2' },
          ],
        },
        // Second pool.connect (fetchEventRow for the live notification)
        {
          rows: [
            { sequence: 2, event_type: 'step.started', event_data: {}, occurred_at: 't2' },
          ],
        },
      ]);
      const svc = await buildService(pool);
      const obs$ = svc.subscribe(RUN, TENANT, 0);
      const collected: MessageEvent[] = [];
      const sub = obs$.subscribe((e) => collected.push(e));

      // Wait for backfill to flush
      await flush();
      await flush();

      // Fire a live notification at sequence=2 — should be dropped.
      const payload: NotifyPayload = {
        run_id: RUN,
        tenant_id: TENANT,
        sequence: 2,
        event_type: 'step.started',
        step_run_id: null,
        event_id: 'e2',
      };
      (svc as unknown as { onNotification: (m: { channel: string; payload?: string }) => void }).onNotification({
        channel: 'run_events',
        payload: JSON.stringify(payload),
      });
      await flush();
      sub.unsubscribe();

      expect(collected.map((e) => e.id)).toEqual(['1', '2']);
    });

    it('preserves backfill order when a live event arrives mid-backfill (regression: Copilot review)', async () => {
      // Backfill returns seq=1..5. While backfill is in flight, a live
      // NOTIFY at seq=10 arrives. Without buffering, the live event would
      // advance the watermark and cause backfill rows 2..5 to be silently
      // dropped by the `row.sequence <= lastSentSequence` check.
      const pool = makeMockPool([
        {
          rows: [
            { id: 'e1', sequence: 1, event_type: 'step.started', event_data: {}, step_run_id: null, occurred_at: 't1' },
            { id: 'e2', sequence: 2, event_type: 'step.completed', event_data: {}, step_run_id: null, occurred_at: 't2' },
            { id: 'e3', sequence: 3, event_type: 'step.started', event_data: {}, step_run_id: null, occurred_at: 't3' },
            { id: 'e4', sequence: 4, event_type: 'step.completed', event_data: {}, step_run_id: null, occurred_at: 't4' },
            { id: 'e5', sequence: 5, event_type: 'step.started', event_data: {}, step_run_id: null, occurred_at: 't5' },
          ],
        },
        // fetchEventRow response for the live NOTIFY (seq=10)
        { rows: [{ sequence: 10, event_type: 'workflow.completed', event_data: {}, occurred_at: 't10' }] },
      ]);
      const svc = await buildService(pool);
      const obs$ = svc.subscribe(RUN, TENANT, 0);
      const collected: MessageEvent[] = [];
      const sub = obs$.subscribe((e) => collected.push(e));

      // Fire the live NOTIFY immediately — before backfill's await chain
      // resolves. The subscriber should buffer it as pendingLive.
      (svc as unknown as { onNotification: (m: { channel: string; payload?: string }) => void }).onNotification({
        channel: 'run_events',
        payload: JSON.stringify({
          run_id: RUN,
          tenant_id: TENANT,
          sequence: 10,
          event_type: 'workflow.completed',
          step_run_id: null,
          event_id: 'e10',
        }),
      });

      await flush();
      await flush();
      await flush();
      sub.unsubscribe();

      // All 5 backfill rows must arrive in order, THEN the buffered live event.
      expect(collected.map((e) => e.id)).toEqual(['1', '2', '3', '4', '5', '10']);
    });

    it('serializes per-run fan-out so two back-to-back notifications emit in NOTIFY arrival order even when the second fetch resolves first (regression: Copilot review)', async () => {
      // Pre-fix race: onNotification fired fanOut without awaiting; two
      // concurrent fetches could resolve out of order, the higher seq would
      // win the watermark, the lower seq would be silently dropped.
      // Fix: per-run promise chain serializes fanOut for the same run.
      let resolveSlow: (rows: any) => void = () => {};
      const slowPromise = new Promise<any>((res) => {
        resolveSlow = res;
      });

      const client: MockClient = {
        query: jest.fn().mockImplementation((sql: string, params?: any[]) => {
          if (sql.startsWith('BEGIN') || sql.startsWith('SELECT set_config') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
            return Promise.resolve({ rows: [] });
          }
          if (sql.includes('FROM run_events WHERE id')) {
            // Slow fetch for the seq=5 event id
            if (params?.[0] === 'evt-5') return slowPromise.then((r) => ({ rows: r }));
            // Fast fetch for the seq=6 event id
            if (params?.[0] === 'evt-6') return Promise.resolve({
              rows: [{ sequence: 6, event_type: 'step.completed', event_data: { v: 6 }, occurred_at: 't6' }],
            });
          }
          return Promise.resolve({ rows: [] });
        }),
        release: jest.fn(),
      };
      const pool: MockPool = { connect: jest.fn().mockResolvedValue(client), client };
      const svc = await buildService(pool);

      // Live path only — backfill returns empty (the mock has no rows
      // configured for the backfill SELECT against `WHERE sequence > $2`).
      const obs$ = svc.subscribe(RUN, TENANT, 0);
      const collected: MessageEvent[] = [];
      const sub = obs$.subscribe((e) => collected.push(e));
      // Let backfill txn drain so `backfilling` flips to false.
      await flush(); await flush(); await flush();

      // Fire seq=5 FIRST (slow fetch), then seq=6 (fast fetch).
      const fire = (seq: number, eid: string) =>
        (svc as unknown as { onNotification: (m: any) => void }).onNotification({
          channel: 'run_events',
          payload: JSON.stringify({
            run_id: RUN, tenant_id: TENANT, sequence: seq,
            event_type: 'step.started', step_run_id: null, event_id: eid,
          }),
        });
      fire(5, 'evt-5');
      fire(6, 'evt-6');

      // seq=6's fetch could resolve immediately; let microtasks run.
      await flush(); await flush();
      // With the per-run chain, seq=6's fanOut hasn't even started — it's
      // chained behind seq=5's slow fetch. Resolve seq=5 now.
      resolveSlow([{ sequence: 5, event_type: 'step.started', event_data: { v: 5 }, occurred_at: 't5' }]);
      await flush(); await flush(); await flush();

      sub.unsubscribe();

      // Must arrive in NOTIFY arrival order: seq=5 first, then seq=6.
      // Without the chain, this would be ['6'] only.
      expect(collected.map((e) => e.id)).toEqual(['5', '6']);
    });

    it('emits live notifications whose sequence is greater than the last sent', async () => {
      const pool = makeMockPool([
        { rows: [] }, // empty backfill
        {
          rows: [
            { sequence: 5, event_type: 'workflow.completed', event_data: { ok: true }, occurred_at: 't5' },
          ],
        },
      ]);
      const svc = await buildService(pool);
      const obs$ = svc.subscribe(RUN, TENANT, 0);
      const collected: MessageEvent[] = [];
      const sub = obs$.subscribe((e) => collected.push(e));
      await flush();

      (svc as unknown as { onNotification: (m: { channel: string; payload?: string }) => void }).onNotification({
        channel: 'run_events',
        payload: JSON.stringify({
          run_id: RUN,
          tenant_id: TENANT,
          sequence: 5,
          event_type: 'workflow.completed',
          step_run_id: null,
          event_id: 'e5',
        }),
      });
      await flush();
      sub.unsubscribe();

      expect(collected).toHaveLength(1);
      expect(collected[0].id).toBe('5');
      expect(collected[0].type).toBe('workflow.completed');
    });
  });

  describe('heartbeat', () => {
    it('emits heartbeat ping events on the configured interval', async () => {
      const pool = makeMockPool([{ rows: [] }]);
      const svc = await buildService(pool, 5); // 5ms heartbeat
      const obs$ = svc.subscribe(RUN, TENANT, 0);
      const collected: MessageEvent[] = [];
      const sub = obs$.subscribe((e) => collected.push(e));

      await lastValueFrom(timer(50).pipe(mergeMap(() => [0])));
      sub.unsubscribe();

      const pings = collected.filter((e) => e.type === 'ping');
      // Exact ping count depends on event-loop scheduling under load;
      // assert the stream is alive and a heartbeat actually fired.
      expect(pings.length).toBeGreaterThanOrEqual(1);
      expect(pings[0]).toEqual({ type: 'ping', data: '' });
    });
  });

  describe('FailureHookService bridge', () => {
    it('emits "run_events" on the in-process EventEmitter for every NOTIFY', async () => {
      const pool = makeMockPool();
      const svc = await buildService(pool);
      const received: NotifyPayload[] = [];
      svc.notifications.on('run_events', (p: NotifyPayload) => received.push(p));

      const payload: NotifyPayload = {
        run_id: RUN,
        tenant_id: TENANT,
        sequence: 7,
        event_type: 'workflow.failed',
        step_run_id: null,
        event_id: 'e7',
      };
      (svc as unknown as { onNotification: (m: { channel: string; payload?: string }) => void }).onNotification({
        channel: 'run_events',
        payload: JSON.stringify(payload),
      });
      expect(received).toEqual([payload]);
    });

    it('ignores notifications on the wrong channel', async () => {
      const pool = makeMockPool();
      const svc = await buildService(pool);
      const received: NotifyPayload[] = [];
      svc.notifications.on('run_events', (p: NotifyPayload) => received.push(p));
      (svc as unknown as { onNotification: (m: { channel: string; payload?: string }) => void }).onNotification({
        channel: 'other_channel',
        payload: JSON.stringify({ run_id: RUN }),
      });
      expect(received).toEqual([]);
    });
  });

  describe('workflow_proposals bridge (Phase 2.5b)', () => {
    it('emits "workflow_proposals" on the EE when a proposal notify arrives', async () => {
      const pool = makeMockPool();
      const svc = await buildService(pool);
      const received: any[] = [];
      svc.notifications.on('workflow_proposals', (p: any) => received.push(p));

      const payload = {
        version_id: 'v-1',
        tenant_id: TENANT,
        workflow_def_id: 'wd-1',
        parent_version_id: null,
        proposal_source: 'failure_recovery',
      };
      (svc as unknown as { onNotification: (m: { channel: string; payload?: string }) => void }).onNotification({
        channel: 'workflow_proposals',
        payload: JSON.stringify(payload),
      });
      expect(received).toEqual([payload]);
    });

    it('does not fan out workflow_proposals to per-run SSE subjects', async () => {
      const pool = makeMockPool();
      const svc = await buildService(pool);
      const sseFanouts: unknown[] = [];
      (svc as unknown as { fanOut: (...args: unknown[]) => Promise<void> }).fanOut = jest.fn(
        async (...args: unknown[]) => {
          sseFanouts.push(args);
        },
      );
      (svc as unknown as { onNotification: (m: { channel: string; payload?: string }) => void }).onNotification({
        channel: 'workflow_proposals',
        payload: JSON.stringify({ version_id: 'v-1', tenant_id: TENANT, proposal_source: 'failure_recovery' }),
      });
      expect(sseFanouts).toEqual([]);
    });
  });

  describe('cleanup', () => {
    it('removes the subject from the map when the subscriber unsubscribes', async () => {
      const pool = makeMockPool([{ rows: [] }]);
      const svc = await buildService(pool);
      const obs$ = svc.subscribe(RUN, TENANT);
      const sub = obs$.subscribe();
      const map = (svc as unknown as { subscribers: Map<string, Set<unknown>> }).subscribers;
      expect(map.get(RUN)?.size).toBe(1);
      sub.unsubscribe();
      expect(map.has(RUN)).toBe(false);
    });
  });
});
