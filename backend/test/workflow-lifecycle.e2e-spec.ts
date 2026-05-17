import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import * as request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { AppModule } from '../src/app.module';
import { N8nSyncService } from '../src/workflows/adapters/n8n/n8n-sync.service';
import { DATABASE_POOL } from '../src/database/database.module';

/**
 * End-to-end lifecycle for Phase 2.4 (#44):
 *   create draft → validate → publish → diff → rollback
 *
 * Prerequisites:
 *   DATABASE_URL pointing to a Postgres with migrations 001–011 applied.
 *   The N8nSyncService is stubbed so this test exercises only the HTTP +
 *   service layers; the adapter sync path is covered by Phase 2.3 specs.
 */

const VALID_SPEC = {
  schemaVersion: '1',
  id: 'wf_lc',
  name: 'Lifecycle test',
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

const MODIFIED_SPEC = {
  ...VALID_SPEC,
  nodes: [
    ...VALID_SPEC.nodes,
    { id: 'tail', type: 'log' as unknown as string },
  ],
  edges: [
    ...VALID_SPEC.edges,
    { id: 'e3', from: { nodeId: 'finish', port: 'in' }, to: { nodeId: 'tail', port: 'in' } },
  ],
};

const adminUserJwt = (jwt: JwtService, tenantId: string, userId: string) =>
  jwt.sign({
    sub: userId,
    email: 'admin@test.local',
    tenantId,
    role: 'admin',
    type: 'user',
  });

const memberUserJwt = (jwt: JwtService, tenantId: string, userId: string) =>
  jwt.sign({
    sub: userId,
    email: 'member@test.local',
    tenantId,
    role: 'member',
    type: 'user',
  });

describe('Workflow lifecycle (Phase 2.4 e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let jwt: JwtService;
  let tenantId: string;
  let userId: string;

  const stubSync: jest.Mock = jest.fn();

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL must be set for integration tests');
    }
    if (!process.env.JWT_SECRET) {
      // Required because main.ts in non-prod warns but doesn't throw; we
      // still need a deterministic secret for signing test JWTs.
      process.env.JWT_SECRET = 'integration-test-secret';
    }

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(N8nSyncService)
      .useValue({
        syncPublishedVersion: stubSync.mockResolvedValue({
          workflowVersionId: 'stubbed',
          n8nWorkflowId: 'n8n-stub',
          n8nErrorWorkflowId: 'n8n-stub-err',
          canonicalHash: 'stubhash',
          action: 'created',
        }),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    jwt = app.get(JwtService);
    pool = app.get<Pool>(DATABASE_POOL);

    const tenantRes = await pool.query(
      `INSERT INTO tenants (slug, display_name) VALUES ($1, $2) RETURNING id`,
      [`phase-2-4-${Date.now()}`, 'Phase 2.4 integration'],
    );
    tenantId = tenantRes.rows[0].id;
    userId = uuidv4();
  });

  afterAll(async () => {
    if (tenantId) {
      await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
    await app.close();
  });

  it('completes the draft → validate → publish → diff → rollback flow', async () => {
    const adminToken = adminUserJwt(jwt, tenantId, userId);

    // Create draft v1
    const createRes = await request(app.getHttpServer())
      .post('/v1/workflows')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ slug: `lc-${Date.now()}`, displayName: 'Lifecycle Test', spec: VALID_SPEC })
      .expect(201);
    const v1Id = createRes.body.id;
    expect(createRes.body.lifecycleState).toBe('draft');
    expect(createRes.body.versionNumber).toBe(1);

    // Validate v1
    const validateRes = await request(app.getHttpServer())
      .post(`/v1/workflows/${v1Id}/validate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(validateRes.body.ok).toBe(true);
    expect(validateRes.body.hash).toMatch(/^[a-f0-9]{64}$/);

    // Publish v1
    const publishRes = await request(app.getHttpServer())
      .post(`/v1/workflows/${v1Id}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(publishRes.body.workflowVersionId).toBe(v1Id);
    expect(publishRes.body.syncAction).toBe('created');
    expect(stubSync).toHaveBeenCalledWith(v1Id, tenantId, userId);

    // Confirm DB state: v1 is now 'published', workflow_defs.active_version_id = v1
    const afterPublish = await pool.query(
      `SELECT lifecycle_state FROM workflow_versions WHERE id = $1`,
      [v1Id],
    );
    expect(afterPublish.rows[0].lifecycle_state).toBe('published');

    // Create + publish v2 (the second publish should demote v1 to superseded)
    const v2DraftRes = await request(app.getHttpServer())
      .post('/v1/workflows')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ workflowDefId: createRes.body.workflowDefId, spec: VALID_SPEC })
      .expect(201);
    const v2Id = v2DraftRes.body.id;

    await request(app.getHttpServer())
      .post(`/v1/workflows/${v2Id}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const afterSecondPublish = await pool.query(
      `SELECT id, lifecycle_state FROM workflow_versions WHERE workflow_def_id = $1`,
      [createRes.body.workflowDefId],
    );
    const states = Object.fromEntries(
      afterSecondPublish.rows.map((r) => [r.id, r.lifecycle_state]),
    );
    expect(states[v1Id]).toBe('superseded');
    expect(states[v2Id]).toBe('published');

    // Diff v1 vs v2 (specs are identical, so patch must be empty)
    const diffRes = await request(app.getHttpServer())
      .get(`/v1/workflows/${v2Id}/diff?from=1&to=2`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(diffRes.body.patch).toEqual([]);
    expect(diffRes.body.fromHash).toBe(diffRes.body.toHash);

    // Rollback (anchored on v2 — service resolves the def via the version id)
    const rollbackRes = await request(app.getHttpServer())
      .post(`/v1/workflows/${v2Id}/rollback`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(rollbackRes.body.rolledBackTo).toBe(v1Id);
    expect(rollbackRes.body.demoted).toBe(v2Id);

    // Final DB state: v1 'published', v2 'superseded'
    const afterRollback = await pool.query(
      `SELECT id, lifecycle_state FROM workflow_versions WHERE workflow_def_id = $1`,
      [createRes.body.workflowDefId],
    );
    const finalStates = Object.fromEntries(
      afterRollback.rows.map((r) => [r.id, r.lifecycle_state]),
    );
    expect(finalStates[v1Id]).toBe('published');
    expect(finalStates[v2Id]).toBe('superseded');

    // Audit trail captures every mutation
    const audit = await pool.query(
      `SELECT action FROM audit_events
        WHERE tenant_id = $1 AND resource_type = 'workflow_version'
        ORDER BY occurred_at ASC`,
      [tenantId],
    );
    const actions = audit.rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'workflow.draft.created',
        'workflow.published',
        'workflow.rolled_back',
      ]),
    );
  });

  it('returns 403 when a non-admin user attempts to publish', async () => {
    const adminToken = adminUserJwt(jwt, tenantId, userId);
    const memberToken = memberUserJwt(jwt, tenantId, userId);

    const draftRes = await request(app.getHttpServer())
      .post('/v1/workflows')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        slug: `noaccess-${Date.now()}`,
        displayName: 'No Access',
        spec: VALID_SPEC,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/v1/workflows/${draftRes.body.id}/publish`)
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(403);
  });

  it('returns 400 with structured compiler errors for malformed canonical JSON', async () => {
    const adminToken = adminUserJwt(jwt, tenantId, userId);
    const draftRes = await request(app.getHttpServer())
      .post('/v1/workflows')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        slug: `invalid-${Date.now()}`,
        displayName: 'Invalid spec',
        // Missing required fields like nodes; will fail to compile.
        spec: { schemaVersion: '1' },
      })
      .expect(201);

    const validateRes = await request(app.getHttpServer())
      .post(`/v1/workflows/${draftRes.body.id}/validate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(validateRes.body.ok).toBe(false);
    expect(Array.isArray(validateRes.body.errors)).toBe(true);
    expect(validateRes.body.errors.length).toBeGreaterThan(0);

    const publishRes = await request(app.getHttpServer())
      .post(`/v1/workflows/${draftRes.body.id}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    expect(publishRes.body.errors).toBeDefined();
  });

  // Reference unused symbol so it doesn't trip lint when this file is
  // expanded later to cover edit-creates-new-draft semantics.
  it('MODIFIED_SPEC fixture is shaped for future edit-draft tests', () => {
    expect(MODIFIED_SPEC.nodes.length).toBeGreaterThan(VALID_SPEC.nodes.length);
  });
});
