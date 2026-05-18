import {
  Inject,
  Injectable,
  Logger,
  MessageEvent,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, Pool } from 'pg';
import { EventEmitter } from 'events';
import { Observable, Subject, interval, merge } from 'rxjs';
import { finalize, map, takeUntil } from 'rxjs/operators';
import { DATABASE_POOL } from '@/database/database.module';

const CHANNEL = 'run_events';

export interface NotifyPayload {
  run_id: string;
  tenant_id: string;
  sequence: number;
  event_type: string;
  step_run_id: string | null;
  event_id: string;
}

interface RunSubscription {
  subject: Subject<MessageEvent>;
  tenantId: string;
  lastSentSequence: number; // monotonically increasing; de-dups against backfill/notify race
  /**
   * True while initial backfill is still running. Live notifications received
   * during this window are queued into `pendingLive` instead of fanning out
   * directly — otherwise a live event with sequence N can advance
   * `lastSentSequence` past backfill rows with sequence < N, causing those
   * backfill rows to be silently dropped by the watermark check.
   */
  backfilling: boolean;
  /** Buffer for live NOTIFY-derived events that arrive during backfill. */
  pendingLive: MessageEvent[];
}

/**
 * Owns a single long-lived Postgres LISTEN client (NOT from the pool —
 * pool clients are recycled every `idleTimeoutMillis`, which would silently
 * drop LISTEN subscriptions). Fans out notifications to per-run RxJS
 * subjects consumed by:
 *   - `RunsController.events` SSE endpoint
 *   - `FailureHookService` (next slice) via the `notifications` EventEmitter
 *
 * Reconnect strategy is bounded exponential backoff (1s → 30s). On reconnect
 * we re-issue `LISTEN run_events`; existing SSE consumers transparently
 * resume because their `EventSource` clients reconnect with `Last-Event-ID`
 * which triggers a fresh backfill via `subscribe()`.
 */
@Injectable()
export class SseSubscriberService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SseSubscriberService.name);
  private readonly subscribers = new Map<string, Set<RunSubscription>>();
  /** In-process bus used by FailureHookService so we don't open a 2nd LISTEN client. */
  readonly notifications = new EventEmitter();
  private client: Client | null = null;
  private readonly destroy$ = new Subject<void>();
  private reconnectAttempts = 0;
  private shuttingDown = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly heartbeatMs: number;
  private readonly connectionString: string;
  private readonly ssl: false | { rejectUnauthorized: boolean };

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.heartbeatMs = Number(config.get<string>('SSE_HEARTBEAT_MS') ?? '15000');
    this.connectionString = config.get<string>('DATABASE_URL') ?? '';
    this.ssl =
      config.get<string>('DATABASE_SSL') === 'true'
        ? {
            rejectUnauthorized:
              config.get<string>('DATABASE_SSL_REJECT_UNAUTHORIZED', 'true') !== 'false',
          }
        : false;
    // Bump the EE cap — one listener per failure-hook + future debugging.
    this.notifications.setMaxListeners(50);
  }

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    this.destroy$.next();
    this.destroy$.complete();
    // Cancel any pending reconnect so we don't open a fresh Client during
    // shutdown (Gemini review PR #65).
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      try {
        await this.client.end();
      } catch (err) {
        this.logger.warn(`shutdown error closing LISTEN client: ${(err as Error).message}`);
      }
    }
    for (const subs of this.subscribers.values()) {
      for (const s of subs) s.subject.complete();
    }
    this.subscribers.clear();
  }

  /**
   * Open the dedicated LISTEN connection. On any subsequent error we drop
   * the client and schedule a reconnect with exponential backoff; SSE
   * consumers stay registered and resume when the channel reopens.
   */
  private async connect(): Promise<void> {
    if (this.shuttingDown) return;
    const client = new Client({ connectionString: this.connectionString, ssl: this.ssl });
    client.on('notification', (msg) => this.onNotification(msg));
    client.on('error', (err) => {
      this.logger.warn(`LISTEN client error: ${err.message}`);
      void this.scheduleReconnect();
    });
    client.on('end', () => {
      if (!this.shuttingDown) {
        this.logger.warn('LISTEN client ended unexpectedly; scheduling reconnect');
        void this.scheduleReconnect();
      }
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      this.client = client;
      this.reconnectAttempts = 0;
      this.logger.log(`SSE subscriber listening on channel "${CHANNEL}"`);
    } catch (err) {
      this.logger.warn(`LISTEN connect failed: ${(err as Error).message}`);
      try { await client.end(); } catch { /* ignore */ }
      this.client = null;
      void this.scheduleReconnect();
    }
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.shuttingDown) return;
    this.client = null;
    this.reconnectAttempts++;
    const delayMs = Math.min(30000, 1000 * 2 ** Math.min(this.reconnectAttempts - 1, 5));
    this.logger.log(`reconnecting LISTEN client in ${delayMs}ms (attempt ${this.reconnectAttempts})`);
    // Store the handle so onModuleDestroy can clear it cleanly.
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delayMs);
  }

  /**
   * Handle one Postgres NOTIFY message. Re-emits on the in-process bus for
   * non-SSE consumers (FailureHookService) and pushes to any per-run SSE
   * subjects. RLS is honored by re-fetching the full row under the run's
   * tenant scope when the SSE pipeline needs `event_data`.
   */
  private onNotification(msg: { channel: string; payload?: string }): void {
    if (msg.channel !== CHANNEL || !msg.payload) return;
    let payload: NotifyPayload;
    try {
      payload = JSON.parse(msg.payload);
    } catch (err) {
      this.logger.warn(`malformed NOTIFY payload: ${(err as Error).message}`);
      return;
    }
    this.notifications.emit('event', payload);

    const subs = this.subscribers.get(payload.run_id);
    if (!subs || subs.size === 0) return;
    void this.fanOut(payload, subs);
  }

  private async fanOut(payload: NotifyPayload, subs: Set<RunSubscription>): Promise<void> {
    try {
      const row = await this.fetchEventRow(payload.event_id, payload.tenant_id);
      if (!row) return;
      const event: MessageEvent = {
        id: String(row.sequence),
        type: row.event_type,
        data: JSON.stringify({
          run_id: payload.run_id,
          step_run_id: payload.step_run_id,
          event_data: row.event_data,
          occurred_at: row.occurred_at,
        }),
      };
      for (const s of subs) {
        if (s.backfilling) {
          // Queue live events arriving during backfill. Without this,
          // advancing `lastSentSequence` here would cause backfill rows
          // with smaller sequences to be skipped silently by the watermark
          // check in `backfill()` — Copilot review PR #65.
          s.pendingLive.push(event);
          continue;
        }
        if (row.sequence <= s.lastSentSequence) continue;
        s.subject.next(event);
        s.lastSentSequence = row.sequence;
      }
    } catch (err) {
      this.logger.warn(`fanOut failed for run ${payload.run_id}: ${(err as Error).message}`);
    }
  }

  private async fetchEventRow(
    eventId: string,
    tenantId: string,
  ): Promise<{
    sequence: number;
    event_type: string;
    event_data: unknown;
    occurred_at: Date;
  } | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const res = await client.query(
        `SELECT sequence, event_type, event_data, occurred_at
           FROM run_events WHERE id = $1 LIMIT 1`,
        [eventId],
      );
      await client.query('COMMIT');
      return res.rows[0] ?? null;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Returns an Observable that emits MessageEvents for `runId`, backfilled
   * starting after `lastEventId` (inclusive of all newer rows), then live
   * from NOTIFY. Heartbeats every `SSE_HEARTBEAT_MS` keep reverse-proxies
   * from closing the connection.
   */
  subscribe(
    runId: string,
    tenantId: string,
    lastEventId?: number,
  ): Observable<MessageEvent> {
    const subject = new Subject<MessageEvent>();
    const startingSequence = Number.isFinite(lastEventId) ? Number(lastEventId) : 0;
    const sub: RunSubscription = {
      subject,
      tenantId,
      lastSentSequence: startingSequence,
      backfilling: true,
      pendingLive: [],
    };

    // Register BEFORE backfill so a notification arriving in the window
    // between backfill and live subscribe lands in the subject; the
    // de-dup on `lastSentSequence` makes the overlap idempotent.
    let set = this.subscribers.get(runId);
    if (!set) {
      set = new Set();
      this.subscribers.set(runId, set);
    }
    set.add(sub);

    // Kick off backfill asynchronously so the caller gets the Observable
    // synchronously and downstream `.pipe(...)` can hook in.
    void this.backfill(runId, tenantId, startingSequence, sub);

    // Heartbeat keeps proxies happy. We use `type: 'ping'` to make the
    // record explicit (clients can ignore unknown types).
    const heartbeat$ = interval(this.heartbeatMs).pipe(
      map<number, MessageEvent>(() => ({ type: 'ping', data: '' })),
    );

    return merge(subject.asObservable(), heartbeat$).pipe(
      takeUntil(this.destroy$),
      finalize(() => {
        const current = this.subscribers.get(runId);
        if (current) {
          current.delete(sub);
          if (current.size === 0) this.subscribers.delete(runId);
        }
        subject.complete();
      }),
    );
  }

  private async backfill(
    runId: string,
    tenantId: string,
    afterSequence: number,
    sub: RunSubscription,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const res = await client.query(
        `SELECT id, sequence, event_type, event_data, step_run_id, occurred_at
           FROM run_events
          WHERE run_id = $1 AND sequence > $2
          ORDER BY sequence ASC`,
        [runId, afterSequence],
      );
      await client.query('COMMIT');

      for (const row of res.rows) {
        if (row.sequence <= sub.lastSentSequence) continue;
        sub.subject.next({
          id: String(row.sequence),
          type: row.event_type,
          data: JSON.stringify({
            run_id: runId,
            step_run_id: row.step_run_id,
            event_data: row.event_data,
            occurred_at: row.occurred_at,
          }),
        });
        sub.lastSentSequence = row.sequence;
      }

      // Phase 2.5a — flush events that were queued while backfill ran.
      // Any pending live event with sequence <= lastSentSequence (already
      // covered by backfill) is discarded; the rest replay in arrival order.
      // The flag flip + flush must happen synchronously so a notification
      // arriving here doesn't slip into pendingLive after we've already
      // started draining.
      sub.backfilling = false;
      const queued = sub.pendingLive;
      sub.pendingLive = [];
      for (const ev of queued) {
        const seq = Number(ev.id);
        if (!Number.isFinite(seq) || seq <= sub.lastSentSequence) continue;
        sub.subject.next(ev);
        sub.lastSentSequence = seq;
      }
    } catch (err) {
      await client.query('ROLLBACK');
      this.logger.warn(`backfill failed for run ${runId}: ${(err as Error).message}`);
      sub.backfilling = false;
      sub.subject.error(err);
    } finally {
      client.release();
    }
  }
}

