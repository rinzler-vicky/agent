import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  N8nExecutionAdapter,
  N8nExecutionError,
} from './n8n-execution.adapter';
import { N8nApiClient, N8nApiError } from './n8n-api.client';
import { DATABASE_POOL } from '@/database/database.module';

const VERSION = '11111111-1111-1111-1111-111111111111';
const TENANT = '22222222-2222-2222-2222-222222222222';
const RUN = '33333333-3333-3333-3333-333333333333';
const N8N_WF = 'n8n-wf-abc';
const N8N_EXEC = 'n8n-exec-xyz';

const buildAdapter = async (overrides?: {
  artifactArtifact?: unknown;
  apiOverrides?: Partial<jest.Mocked<N8nApiClient>>;
  config?: Record<string, string>;
}): Promise<{
  adapter: N8nExecutionAdapter;
  api: jest.Mocked<N8nApiClient>;
  poolQuery: jest.Mock;
}> => {
  const poolQuery = jest.fn().mockResolvedValue({
    rows:
      overrides?.artifactArtifact === null
        ? []
        : [{ artifact: overrides?.artifactArtifact ?? { n8nWorkflowId: N8N_WF } }],
  });
  const api: jest.Mocked<N8nApiClient> = {
    runWorkflow: jest.fn(),
    listExecutions: jest.fn(),
  } as unknown as jest.Mocked<N8nApiClient>;
  Object.assign(api, overrides?.apiOverrides ?? {});

  const cfg = overrides?.config ?? { N8N_TRIGGER_LIST_FALLBACK_DELAY_MS: '0' };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      N8nExecutionAdapter,
      { provide: DATABASE_POOL, useValue: { query: poolQuery } },
      { provide: N8nApiClient, useValue: api },
      {
        provide: ConfigService,
        useValue: { get: (k: string) => cfg[k] },
      },
    ],
  }).compile();
  return { adapter: module.get(N8nExecutionAdapter), api, poolQuery };
};

describe('N8nExecutionAdapter', () => {
  it('returns providerExecutionId from runWorkflow response', async () => {
    const { adapter, api } = await buildAdapter();
    (api.runWorkflow as jest.Mock).mockResolvedValue({ executionId: N8N_EXEC });

    const result = await adapter.triggerExecution({
      workflowVersionId: VERSION,
      tenantId: TENANT,
      runId: RUN,
      input: { foo: 1 },
    });

    expect(api.runWorkflow).toHaveBeenCalledWith(
      N8N_WF,
      { runId: RUN, tenantId: TENANT, input: { foo: 1 } },
      expect.any(Number),
    );
    expect(result).toEqual({ providerExecutionId: N8N_EXEC, n8nWorkflowId: N8N_WF });
    // listExecutions fallback must not fire when runWorkflow returned an id
    expect(api.listExecutions).not.toHaveBeenCalled();
  });

  it('falls back to listExecutions when runWorkflow returns no executionId', async () => {
    const { adapter, api } = await buildAdapter();
    (api.runWorkflow as jest.Mock).mockResolvedValue({});
    (api.listExecutions as jest.Mock).mockResolvedValue([{ id: N8N_EXEC }]);

    const result = await adapter.triggerExecution({
      workflowVersionId: VERSION,
      tenantId: TENANT,
      runId: RUN,
    });

    expect(api.listExecutions).toHaveBeenCalledWith({ workflowId: N8N_WF, limit: 1 });
    expect(result.providerExecutionId).toBe(N8N_EXEC);
  });

  it('throws artifact_not_synced when no n8n workflow id is cached', async () => {
    const { adapter } = await buildAdapter({ artifactArtifact: null });

    await expect(
      adapter.triggerExecution({ workflowVersionId: VERSION, tenantId: TENANT, runId: RUN }),
    ).rejects.toMatchObject({ code: 'artifact_not_synced' });
  });

  it('wraps adapter HTTP errors with N8nExecutionError', async () => {
    const { adapter, api } = await buildAdapter();
    (api.runWorkflow as jest.Mock).mockRejectedValue(
      new N8nApiError(500, 'boom', 'n8n POST /workflows/x/run -> 500'),
    );

    await expect(
      adapter.triggerExecution({ workflowVersionId: VERSION, tenantId: TENANT, runId: RUN }),
    ).rejects.toMatchObject({ code: 'trigger_failed' });
  });

  it('throws execution_id_missing when both runWorkflow and listExecutions are empty', async () => {
    const { adapter, api } = await buildAdapter();
    (api.runWorkflow as jest.Mock).mockResolvedValue({});
    (api.listExecutions as jest.Mock).mockResolvedValue([]);

    await expect(
      adapter.triggerExecution({ workflowVersionId: VERSION, tenantId: TENANT, runId: RUN }),
    ).rejects.toMatchObject({ code: 'execution_id_missing' });
  });
});
