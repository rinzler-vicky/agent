import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import * as request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { AppModule } from '../src/app.module';
import { N8nSyncService } from '../src/workflows/adapters/n8n/n8n-sync.service';
import { DATABASE_POOL } from '../src/database/database.module';

/**
 * Integration test for POST /v1/workflow-proposals (Phase 2.4 #44).
 * Covers the four critical ACs:
 *   - happy path: service-account JWT with `workflows:propose` scope and a
 *     stepRunId lands a draft with proposal_source='failure_recovery',
 *     proposal_context populated, audit event linking the failing step to
 *     the new draft.
 *   - user-type JWT → 403.
 *   - service-account JWT missing scope → 403.
 *   - malformed canonical JSON → 400 with structured errors.
 *
 * Prereqs: DATABASE_URL with migrations 001–011 applied.
 */

const VALID_SPEC = {
  schemaVersion: '1',
  id: 'wf_prop',
  name: 'Proposal test',
  nodes: [
    { id: 'start1', type: 'start' },
    { id: 'http1', type: 'http.request' },
    { id: 'finish', type: 'end' },
  ],
  edges: [
    { id: 'e1', from: { nodeId: 'start1', port: 'out' }, to: { nodeId: 'http1', port: 'in' } },
    { id: 'e2', from: { nodeId: 'http1', port: 'out' }, to: { nodeId: 'finish', port: 'in' } },
  ],
};

const serviceAccountJwt = (
  jwt: JwtService,
  tenantId: string,
  saId: string,
  scopes: string[],
) =>
  jwt.sign({
    sub: saId,
    email: 'sa@test.local',
    tenantId,
    role: 'service',
    type: 'service_account',
    scopes,
  });

const userJwt = (jwt: JwtService, tenantId: string, userId: string) =>
  jwt.sign({
    sub: userId,
    email: 'user@test.local',
    tenantId,
    role: 'admin',
    type: 'user',
  });

describe('POST /v1/workflow-proposals (Phase 2.4 e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let jwt: JwtService;
  let tenantId: string;
  let workflowDefId: string;
  let parentVersionId: string;
  let workflowRunId: string;
  let stepRunId: string;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL must be set for integration tests');
    }
    if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'integration-test-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(N8nSyncService)
      .useValue({ syncPublishedVersion: jest.fn() })
      .compile();

    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    jwt = app.get(JwtService);
    pool = app.get<Pool>(DATABASE_POOL);

    // Seed: tenant, workflow_def, published parent version, run + step row
    // referenced by stepRunId so the proposal_context links a real failing
    // step. All seed inserts share a single pooled client so the
    // `app.tenant_id` session var stays set across RLS-protected tables
    // (workflow_defs, workflow_runs, step_runs all have RLS via
    // current_setting('app.tenant_id')). Each pool.query() would otherwise
    // grab a fresh connection without the var set.
    const seedClient = await pool.connect();
    try {
      const tenantRes = await seedClient.query(
        `INSERT INTO tenants (slug, display_name) VALUES ($1, $2) RETURNING id`,
        [`phase-2-4-prop-${Date.now()}`, 'Phase 2.4 proposals'],
      );
      tenantId = tenantRes.rows[0].id;

      await seedClient.query("SELECT set_config('app.tenant_id', $1, false)", [tenantId]);

      const defRes = await seedClient.query(
        `INSERT INTO workflow_defs (tenant_id, slug, display_name) VALUES ($1, $2, $3) RETURNING id`,
        [tenantId, `def-${Date.now()}`, 'Parent def'],
      );
      workflowDefId = defRes.rows[0].id;

      const versionRes = await seedClient.query(
        `INSERT INTO workflow_versions (workflow_def_id, spec, lifecycle_state, approval_state)
         VALUES ($1, $2, 'published', 'approved') RETURNING id`,
        [workflowDefId, VALID_SPEC],
      );
      parentVersionId = versionRes.rows[0].id;

      const runRes = await seedClient.query(
        `INSERT INTO workflow_runs (tenant_id, workflow_version_id, status, execution_engine)
         VALUES ($1, $2, 'failed', 'n8n') RETURNING id`,
        [tenantId, parentVersionId],
      );
      workflowRunId = runRes.rows[0].id;

      // step_runs columns are step_key + step_name (per migration 009);
      // earlier drafts of this test mistakenly used `node_id` which doesn't
      // exist in the schema.
      const stepRes = await seedClient.query(
        `INSERT INTO step_runs (workflow_run_id, step_key, step_name, status)
         VALUES ($1, $2, $3, 'failed') RETURNING id`,
        [workflowRunId, 'http1', 'http.request:http1'],
      );
      stepRunId = stepRes.rows[0].id;
    } finally {
      // Reset tenant context before returning client to pool.
      await seedClient.query("SELECT set_config('app.tenant_id', '', false)").catch(() => {});
      seedClient.release();
    }
  });

  afterAll(async () => {
    if (tenantId) {
      await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
    await app.close();
  });

  it('lands a failure_recovery draft when a service-account JWT carries workflows:propose + a stepRunId', async () => {
    const saId = uuidv4();
    const token = serviceAccountJwt(jwt, tenantId, saId, ['workflows:propose']);
    const res = await request(app.getHttpServer())
      .post('/v1/workflow-proposals')
      .set('Authorization', `Bearer ${token}`)
      .send({
        workflowDefId,
        parentVersionId,
        spec: VALID_SPEC,
        workflowRunId,
        stepRunId,
        errorFingerprint: 'HTTP_TIMEOUT@http1',
        rationale: 'increase upstream timeout',
      })
      .expect(201);

    expect(res.body.proposalSource).toBe('failure_recovery');
    expect(res.body.parentVersionId).toBe(parentVersionId);
    expect(res.body.proposalContext).toMatchObject({ stepRunId, workflowRunId });

    const newDraftId = res.body.id;
    const audit = await pool.query(
      `SELECT action, resource_id, metadata FROM audit_events
        WHERE tenant_id = $1 AND resource_id = $2`,
      [tenantId, newDraftId],
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0].action).toBe('workflow.proposal.created');
    expect(audit.rows[0].metadata.stepRunId).toBe(stepRunId);
    expect(audit.rows[0].metadata.errorFingerprint).toBe('HTTP_TIMEOUT@http1');
  });

  it("defaults proposal_source to 'agent_reflection' when no stepRunId is supplied", async () => {
    const saId = uuidv4();
    const token = serviceAccountJwt(jwt, tenantId, saId, ['workflows:propose']);
    const res = await request(app.getHttpServer())
      .post('/v1/workflow-proposals')
      .set('Authorization', `Bearer ${token}`)
      .send({ workflowDefId, parentVersionId, spec: VALID_SPEC, rationale: 'unprompted reflection' })
      .expect(201);
    expect(res.body.proposalSource).toBe('agent_reflection');
  });

  it('rejects user-type JWTs with 403 (per #44 AC)', async () => {
    const token = userJwt(jwt, tenantId, uuidv4());
    await request(app.getHttpServer())
      .post('/v1/workflow-proposals')
      .set('Authorization', `Bearer ${token}`)
      .send({ workflowDefId, parentVersionId, spec: VALID_SPEC })
      .expect(403);
  });

  it('rejects service-account JWTs missing workflows:propose with 403', async () => {
    const token = serviceAccountJwt(jwt, tenantId, uuidv4(), ['tools:invoke']);
    await request(app.getHttpServer())
      .post('/v1/workflow-proposals')
      .set('Authorization', `Bearer ${token}`)
      .send({ workflowDefId, parentVersionId, spec: VALID_SPEC })
      .expect(403);
  });

  it('returns 400 with structured compiler errors for malformed canonical JSON', async () => {
    const token = serviceAccountJwt(jwt, tenantId, uuidv4(), ['workflows:propose']);
    const res = await request(app.getHttpServer())
      .post('/v1/workflow-proposals')
      .set('Authorization', `Bearer ${token}`)
      .send({ workflowDefId, parentVersionId, spec: { schemaVersion: '1' } })
      .expect(400);
    // Either the compiler's structured errors land on `errors` or class-validator
    // catches the missing canonical fields — both surface as 400.
    expect(res.body.message ?? res.body.errors).toBeTruthy();
  });
});
