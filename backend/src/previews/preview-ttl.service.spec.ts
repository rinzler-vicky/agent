import { Test, TestingModule } from '@nestjs/testing';
import { PreviewTtlService } from './preview-ttl.service';
import { NeonApiClient } from './neon-api.client';
import { RenderApiClient } from './render-api.client';
import { AuditService } from '@/audit/audit.service';
import { DATABASE_POOL } from '@/database/database.module';

interface MockClient {
  query: jest.Mock;
  release: jest.Mock;
}

const TENANT = 'tttttttt-tttt-tttt-tttt-tttttttttttt';

const makeService = async (
  expiredRows: Array<{
    id: string;
    tenant_id: string;
    render_backend_service_id: string | null;
    neon_branch_name: string | null;
  }>,
  opts?: { renderDeleteFails?: boolean },
): Promise<{
  service: PreviewTtlService;
  audit: { log: jest.Mock };
  render: { deleteService: jest.Mock };
  queries: Array<{ sql: string; params: any[] }>;
}> => {
  const queries: Array<{ sql: string; params: any[] }> = [];
  const client: MockClient = {
    query: jest.fn().mockImplementation((sql: string, params?: any[]) => {
      queries.push({ sql, params: params ?? [] });
      if (sql.includes('FROM preview_environments') && sql.includes("status = 'ready'")) {
        return Promise.resolve({ rows: expiredRows });
      }
      return Promise.resolve({ rows: [] });
    }),
    release: jest.fn(),
  };
  const pool = { connect: jest.fn().mockResolvedValue(client) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const render = {
    deleteService: opts?.renderDeleteFails
      ? jest.fn().mockRejectedValue(new Error('render-down'))
      : jest.fn().mockResolvedValue(undefined),
  };
  const neon = { deleteBranch: jest.fn().mockResolvedValue(undefined) };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      PreviewTtlService,
      { provide: DATABASE_POOL, useValue: pool },
      { provide: AuditService, useValue: audit },
      { provide: RenderApiClient, useValue: render },
      { provide: NeonApiClient, useValue: neon },
    ],
  }).compile();

  return { service: module.get(PreviewTtlService), audit, render, queries };
};

describe('PreviewTtlService', () => {
  it('sweep is a no-op when no rows are expired', async () => {
    const { service, audit, render } = await makeService([]);
    await service.sweep();
    expect(render.deleteService).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('tears down expired rows: deletes Render service, sets expired, audits', async () => {
    const { service, audit, render, queries } = await makeService([
      {
        id: 'pe-1',
        tenant_id: TENANT,
        render_backend_service_id: 'svc-1',
        neon_branch_name: 'agent-1',
      },
    ]);
    await service.sweep();
    expect(render.deleteService).toHaveBeenCalledWith('svc-1');
    const updateQ = queries.find(
      (q) => q.sql.includes('UPDATE preview_environments') && q.sql.includes("status = 'expired'"),
    );
    expect(updateQ).toBeDefined();
    expect(updateQ!.params).toEqual(['pe-1']);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent_preview.expired',
        resourceId: 'pe-1',
      }),
      expect.anything(),
    );
  });

  it('still flips status to expired when Render deleteService fails', async () => {
    const { service, audit, queries } = await makeService(
      [
        {
          id: 'pe-2',
          tenant_id: TENANT,
          render_backend_service_id: 'svc-2',
          neon_branch_name: null,
        },
      ],
      { renderDeleteFails: true },
    );
    await service.sweep();
    const updateQ = queries.find(
      (q) => q.sql.includes('UPDATE preview_environments') && q.sql.includes("status = 'expired'"),
    );
    expect(updateQ).toBeDefined();
    expect(audit.log).toHaveBeenCalled();
  });
});
