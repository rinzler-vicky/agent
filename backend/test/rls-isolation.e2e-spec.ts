import { Pool, PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';

/**
 * Integration test for RLS (Row-Level Security) isolation on Phase 2.1 tables.
 *
 * Prerequisites:
 * - DATABASE_URL environment variable must point to a test Postgres instance
 * - Migrations 001-011 must be applied
 *
 * This test validates that tenant isolation is enforced at the database level
 * for all Phase 2.1 tables: conversations, messages, task_graphs, tasks,
 * task_edges, workflow_runs, step_runs, run_events, and proposal_triggers.
 */

describe('Phase 2.1 RLS Isolation (Integration)', () => {
  let pool: Pool;
  let tenantAId: string;
  let tenantBId: string;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL must be set for integration tests');
    }

    pool = new Pool({ connectionString: process.env.DATABASE_URL });

    // Create two test tenants
    const resultA = await pool.query(
      `INSERT INTO tenants (slug, display_name) VALUES ($1, $2) RETURNING id`,
      ['test-tenant-a', 'Test Tenant A'],
    );
    tenantAId = resultA.rows[0].id;

    const resultB = await pool.query(
      `INSERT INTO tenants (slug, display_name) VALUES ($1, $2) RETURNING id`,
      ['test-tenant-b', 'Test Tenant B'],
    );
    tenantBId = resultB.rows[0].id;
  });

  afterAll(async () => {
    // Clean up test tenants (cascade will clean up related data)
    await pool.query('DELETE FROM tenants WHERE id = ANY($1)', [[tenantAId, tenantBId]]);
    await pool.end();
  });

  describe('Conversations RLS', () => {
    it('should isolate conversations by tenant', async () => {
      const client = await pool.connect();
      try {
        // Create conversation for tenant A
        await client.query(`SET app.tenant_id = '${tenantAId}'`);
        const convA = await client.query(
          `INSERT INTO conversations (tenant_id, title) VALUES ($1, $2) RETURNING id`,
          [tenantAId, 'Tenant A Conversation'],
        );
        const convAId = convA.rows[0].id;

        // Create conversation for tenant B
        await client.query(`SET app.tenant_id = '${tenantBId}'`);
        const convB = await client.query(
          `INSERT INTO conversations (tenant_id, title) VALUES ($1, $2) RETURNING id`,
          [tenantBId, 'Tenant B Conversation'],
        );
        const convBId = convB.rows[0].id;

        // Tenant A should only see their conversation
        await client.query(`SET app.tenant_id = '${tenantAId}'`);
        const resultA = await client.query('SELECT id FROM conversations');
        expect(resultA.rows).toHaveLength(1);
        expect(resultA.rows[0].id).toBe(convAId);

        // Tenant B should only see their conversation
        await client.query(`SET app.tenant_id = '${tenantBId}'`);
        const resultB = await client.query('SELECT id FROM conversations');
        expect(resultB.rows).toHaveLength(1);
        expect(resultB.rows[0].id).toBe(convBId);

        // Clean up
        await client.query('RESET app.tenant_id');
        await client.query('DELETE FROM conversations WHERE id = ANY($1)', [[convAId, convBId]]);
      } finally {
        client.release();
      }
    });
  });

  describe('Messages RLS', () => {
    it('should isolate messages by tenant via conversation', async () => {
      const client = await pool.connect();
      try {
        // Create conversations
        await client.query(`SET app.tenant_id = '${tenantAId}'`);
        const convA = await client.query(
          `INSERT INTO conversations (tenant_id, title) VALUES ($1, $2) RETURNING id`,
          [tenantAId, 'Conv A'],
        );
        const convAId = convA.rows[0].id;

        await client.query(`SET app.tenant_id = '${tenantBId}'`);
        const convB = await client.query(
          `INSERT INTO conversations (tenant_id, title) VALUES ($1, $2) RETURNING id`,
          [tenantBId, 'Conv B'],
        );
        const convBId = convB.rows[0].id;

        // Create messages
        await client.query(`SET app.tenant_id = '${tenantAId}'`);
        const msgA = await client.query(
          `INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3) RETURNING id`,
          [convAId, 'user', 'Message from A'],
        );

        await client.query(`SET app.tenant_id = '${tenantBId}'`);
        const msgB = await client.query(
          `INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3) RETURNING id`,
          [convBId, 'user', 'Message from B'],
        );

        // Tenant A should only see their messages
        await client.query(`SET app.tenant_id = '${tenantAId}'`);
        const resultA = await client.query('SELECT id, content FROM messages');
        expect(resultA.rows).toHaveLength(1);
        expect(resultA.rows[0].content).toBe('Message from A');

        // Tenant B should only see their messages
        await client.query(`SET app.tenant_id = '${tenantBId}'`);
        const resultB = await client.query('SELECT id, content FROM messages');
        expect(resultB.rows).toHaveLength(1);
        expect(resultB.rows[0].content).toBe('Message from B');

        // Clean up
        await client.query('RESET app.tenant_id');
        await client.query('DELETE FROM conversations WHERE id = ANY($1)', [[convAId, convBId]]);
      } finally {
        client.release();
      }
    });
  });

  describe('Task Graphs RLS', () => {
    it('should isolate task graphs, tasks, and edges by tenant', async () => {
      const client = await pool.connect();
      try {
        // Create task graphs
        await client.query(`SET app.tenant_id = '${tenantAId}'`);
        const graphA = await client.query(
          `INSERT INTO task_graphs (tenant_id, display_name) VALUES ($1, $2) RETURNING id`,
          [tenantAId, 'Graph A'],
        );
        const graphAId = graphA.rows[0].id;

        await client.query(`SET app.tenant_id = '${tenantBId}'`);
        const graphB = await client.query(
          `INSERT INTO task_graphs (tenant_id, display_name) VALUES ($1, $2) RETURNING id`,
          [tenantBId, 'Graph B'],
        );
        const graphBId = graphB.rows[0].id;

        // Create tasks
        await client.query(`SET app.tenant_id = '${tenantAId}'`);
        const taskA1 = await client.query(
          `INSERT INTO tasks (task_graph_id, task_key, display_name, task_type)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [graphAId, 'task-a1', 'Task A1', 'test'],
        );
        const taskA2 = await client.query(
          `INSERT INTO tasks (task_graph_id, task_key, display_name, task_type)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [graphAId, 'task-a2', 'Task A2', 'test'],
        );

        await client.query(`SET app.tenant_id = '${tenantBId}'`);
        const taskB1 = await client.query(
          `INSERT INTO tasks (task_graph_id, task_key, display_name, task_type)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [graphBId, 'task-b1', 'Task B1', 'test'],
        );

        // Create edges
        await client.query(`SET app.tenant_id = '${tenantAId}'`);
        await client.query(
          `INSERT INTO task_edges (task_graph_id, from_task_id, to_task_id)
           VALUES ($1, $2, $3)`,
          [graphAId, taskA1.rows[0].id, taskA2.rows[0].id],
        );

        // Tenant A should only see their data
        await client.query(`SET app.tenant_id = '${tenantAId}'`);
        const graphsA = await client.query('SELECT id FROM task_graphs');
        const tasksA = await client.query('SELECT id FROM tasks');
        const edgesA = await client.query('SELECT id FROM task_edges');
        expect(graphsA.rows).toHaveLength(1);
        expect(tasksA.rows).toHaveLength(2);
        expect(edgesA.rows).toHaveLength(1);

        // Tenant B should only see their data
        await client.query(`SET app.tenant_id = '${tenantBId}'`);
        const graphsB = await client.query('SELECT id FROM task_graphs');
        const tasksB = await client.query('SELECT id FROM tasks');
        const edgesB = await client.query('SELECT id FROM task_edges');
        expect(graphsB.rows).toHaveLength(1);
        expect(tasksB.rows).toHaveLength(1);
        expect(edgesB.rows).toHaveLength(0);

        // Clean up
        await client.query('RESET app.tenant_id');
        await client.query('DELETE FROM task_graphs WHERE id = ANY($1)', [[graphAId, graphBId]]);
      } finally {
        client.release();
      }
    });
  });

  describe('Workflow Runs RLS', () => {
    it('should isolate workflow runs, step runs, and events by tenant', async () => {
      const client = await pool.connect();
      try {
        // Create workflow defs and versions (needed for FK)
        await client.query('RESET app.tenant_id');
        const wfDefA = await client.query(
          `INSERT INTO workflow_defs (tenant_id, slug, display_name) VALUES ($1, $2, $3) RETURNING id`,
          [tenantAId, 'wf-a', 'Workflow A'],
        );
        const wfVerA = await client.query(
          `INSERT INTO workflow_versions (workflow_def_id, spec) VALUES ($1, $2) RETURNING id`,
          [wfDefA.rows[0].id, { steps: [] }],
        );

        const wfDefB = await client.query(
          `INSERT INTO workflow_defs (tenant_id, slug, display_name) VALUES ($1, $2, $3) RETURNING id`,
          [tenantBId, 'wf-b', 'Workflow B'],
        );
        const wfVerB = await client.query(
          `INSERT INTO workflow_versions (workflow_def_id, spec) VALUES ($1, $2) RETURNING id`,
          [wfDefB.rows[0].id, { steps: [] }],
        );

        // Create workflow runs
        await client.query(`SET app.tenant_id = '${tenantAId}'`);
        const runA = await client.query(
          `INSERT INTO workflow_runs (tenant_id, workflow_version_id) VALUES ($1, $2) RETURNING id`,
          [tenantAId, wfVerA.rows[0].id],
        );

        await client.query(`SET app.tenant_id = '${tenantBId}'`);
        const runB = await client.query(
          `INSERT INTO workflow_runs (tenant_id, workflow_version_id) VALUES ($1, $2) RETURNING id`,
          [tenantBId, wfVerB.rows[0].id],
        );

        // Create step runs and events
        await client.query(`SET app.tenant_id = '${tenantAId}'`);
        const stepA = await client.query(
          `INSERT INTO step_runs (workflow_run_id, step_key, step_name) VALUES ($1, $2, $3) RETURNING id`,
          [runA.rows[0].id, 'step1', 'Step 1'],
        );
        await client.query(
          `INSERT INTO run_events (run_id, event_type, event_data) VALUES ($1, $2, $3)`,
          [runA.rows[0].id, 'started', {}],
        );

        await client.query(`SET app.tenant_id = '${tenantBId}'`);
        const stepB = await client.query(
          `INSERT INTO step_runs (workflow_run_id, step_key, step_name) VALUES ($1, $2, $3) RETURNING id`,
          [runB.rows[0].id, 'step1', 'Step 1'],
        );
        await client.query(
          `INSERT INTO run_events (run_id, event_type, event_data) VALUES ($1, $2, $3)`,
          [runB.rows[0].id, 'started', {}],
        );

        // Tenant A should only see their data
        await client.query(`SET app.tenant_id = '${tenantAId}'`);
        const runsA = await client.query('SELECT id FROM workflow_runs');
        const stepsA = await client.query('SELECT id FROM step_runs');
        const eventsA = await client.query('SELECT id FROM run_events');
        expect(runsA.rows).toHaveLength(1);
        expect(stepsA.rows).toHaveLength(1);
        expect(eventsA.rows).toHaveLength(1);

        // Tenant B should only see their data
        await client.query(`SET app.tenant_id = '${tenantBId}'`);
        const runsB = await client.query('SELECT id FROM workflow_runs');
        const stepsB = await client.query('SELECT id FROM step_runs');
        const eventsB = await client.query('SELECT id FROM run_events');
        expect(runsB.rows).toHaveLength(1);
        expect(stepsB.rows).toHaveLength(1);
        expect(eventsB.rows).toHaveLength(1);

        // Clean up
        await client.query('RESET app.tenant_id');
        await client.query('DELETE FROM workflow_defs WHERE id = ANY($1)', [
          [wfDefA.rows[0].id, wfDefB.rows[0].id],
        ]);
      } finally {
        client.release();
      }
    });
  });

  describe('Proposal Triggers RLS', () => {
    it('should isolate proposal triggers by tenant', async () => {
      const client = await pool.connect();
      try {
        // Create workflow runs (needed for FK)
        await client.query('RESET app.tenant_id');
        const wfDefA = await client.query(
          `INSERT INTO workflow_defs (tenant_id, slug, display_name) VALUES ($1, $2, $3) RETURNING id`,
          [tenantAId, 'wf-prop-a', 'Workflow Prop A'],
        );
        const wfVerA = await client.query(
          `INSERT INTO workflow_versions (workflow_def_id, spec) VALUES ($1, $2) RETURNING id`,
          [wfDefA.rows[0].id, {}],
        );
        const runA = await client.query(
          `INSERT INTO workflow_runs (tenant_id, workflow_version_id) VALUES ($1, $2) RETURNING id`,
          [tenantAId, wfVerA.rows[0].id],
        );

        const wfDefB = await client.query(
          `INSERT INTO workflow_defs (tenant_id, slug, display_name) VALUES ($1, $2, $3) RETURNING id`,
          [tenantBId, 'wf-prop-b', 'Workflow Prop B'],
        );
        const wfVerB = await client.query(
          `INSERT INTO workflow_versions (workflow_def_id, spec) VALUES ($1, $2) RETURNING id`,
          [wfDefB.rows[0].id, {}],
        );
        const runB = await client.query(
          `INSERT INTO workflow_runs (tenant_id, workflow_version_id) VALUES ($1, $2) RETURNING id`,
          [tenantBId, wfVerB.rows[0].id],
        );

        // Create proposal triggers
        await client.query(`SET app.tenant_id = '${tenantAId}'`);
        await client.query(
          `INSERT INTO proposal_triggers (tenant_id, workflow_run_id, error_fingerprint)
           VALUES ($1, $2, $3)`,
          [tenantAId, runA.rows[0].id, 'error-a'],
        );

        await client.query(`SET app.tenant_id = '${tenantBId}'`);
        await client.query(
          `INSERT INTO proposal_triggers (tenant_id, workflow_run_id, error_fingerprint)
           VALUES ($1, $2, $3)`,
          [tenantBId, runB.rows[0].id, 'error-b'],
        );

        // Tenant A should only see their triggers
        await client.query(`SET app.tenant_id = '${tenantAId}'`);
        const triggersA = await client.query('SELECT error_fingerprint FROM proposal_triggers');
        expect(triggersA.rows).toHaveLength(1);
        expect(triggersA.rows[0].error_fingerprint).toBe('error-a');

        // Tenant B should only see their triggers
        await client.query(`SET app.tenant_id = '${tenantBId}'`);
        const triggersB = await client.query('SELECT error_fingerprint FROM proposal_triggers');
        expect(triggersB.rows).toHaveLength(1);
        expect(triggersB.rows[0].error_fingerprint).toBe('error-b');

        // Clean up
        await client.query('RESET app.tenant_id');
        await client.query('DELETE FROM workflow_defs WHERE id = ANY($1)', [
          [wfDefA.rows[0].id, wfDefB.rows[0].id],
        ]);
      } finally {
        client.release();
      }
    });
  });

  describe('Run Events Append-Only Enforcement', () => {
    it('should prevent UPDATE operations on run_events', async () => {
      const client = await pool.connect();
      try {
        // Create necessary dependencies
        await client.query('RESET app.tenant_id');
        const wfDef = await client.query(
          `INSERT INTO workflow_defs (tenant_id, slug, display_name) VALUES ($1, $2, $3) RETURNING id`,
          [tenantAId, 'wf-append', 'Workflow Append Test'],
        );
        const wfVer = await client.query(
          `INSERT INTO workflow_versions (workflow_def_id, spec) VALUES ($1, $2) RETURNING id`,
          [wfDef.rows[0].id, {}],
        );
        const run = await client.query(
          `INSERT INTO workflow_runs (tenant_id, workflow_version_id) VALUES ($1, $2) RETURNING id`,
          [tenantAId, wfVer.rows[0].id],
        );

        await client.query(`SET app.tenant_id = '${tenantAId}'`);
        const event = await client.query(
          `INSERT INTO run_events (run_id, event_type, event_data)
           VALUES ($1, $2, $3) RETURNING id`,
          [run.rows[0].id, 'test', { foo: 'bar' }],
        );

        // Attempt UPDATE - should be silently ignored by RULE
        const updateResult = await client.query(
          `UPDATE run_events SET event_data = $1 WHERE id = $2`,
          [{ foo: 'modified' }, event.rows[0].id],
        );
        expect(updateResult.rowCount).toBe(0);

        // Verify original data unchanged
        const check = await client.query(
          `SELECT event_data FROM run_events WHERE id = $1`,
          [event.rows[0].id],
        );
        expect(check.rows[0].event_data.foo).toBe('bar');

        // Clean up
        await client.query('RESET app.tenant_id');
        await client.query('DELETE FROM workflow_defs WHERE id = $1', [wfDef.rows[0].id]);
      } finally {
        client.release();
      }
    });

    it('should prevent DELETE operations on run_events', async () => {
      const client = await pool.connect();
      try {
        // Create necessary dependencies
        await client.query('RESET app.tenant_id');
        const wfDef = await client.query(
          `INSERT INTO workflow_defs (tenant_id, slug, display_name) VALUES ($1, $2, $3) RETURNING id`,
          [tenantAId, 'wf-delete', 'Workflow Delete Test'],
        );
        const wfVer = await client.query(
          `INSERT INTO workflow_versions (workflow_def_id, spec) VALUES ($1, $2) RETURNING id`,
          [wfDef.rows[0].id, {}],
        );
        const run = await client.query(
          `INSERT INTO workflow_runs (tenant_id, workflow_version_id) VALUES ($1, $2) RETURNING id`,
          [tenantAId, wfVer.rows[0].id],
        );

        await client.query(`SET app.tenant_id = '${tenantAId}'`);
        const event = await client.query(
          `INSERT INTO run_events (run_id, event_type, event_data)
           VALUES ($1, $2, $3) RETURNING id`,
          [run.rows[0].id, 'test', {}],
        );

        // Attempt DELETE - should be silently ignored by RULE
        const deleteResult = await client.query(
          `DELETE FROM run_events WHERE id = $1`,
          [event.rows[0].id],
        );
        expect(deleteResult.rowCount).toBe(0);

        // Verify event still exists
        const check = await client.query(
          `SELECT id FROM run_events WHERE id = $1`,
          [event.rows[0].id],
        );
        expect(check.rows).toHaveLength(1);

        // Clean up
        await client.query('RESET app.tenant_id');
        await client.query('DELETE FROM workflow_defs WHERE id = $1', [wfDef.rows[0].id]);
      } finally {
        client.release();
      }
    });
  });
});
