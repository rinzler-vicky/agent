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

interface ExpiredRow {
  id: string;
  tenant_id: string;
  render_backend_service_id: string | null;
  neon_branch_id: string | null;
  neon_branch_name: string | null;
}

const makeService = async (
  expiredRows: ExpiredRow[],
  opts?: { renderDeleteFails?: boolean; neonDeleteFails?: boolean },
): Promise<{
  service: PreviewTtlService;
  audit: { log: jest.Mock };
  render: { deleteService: jest.Mock };
  neon: { deleteBranch: jest.Mock };
  queries: Array<{ sql: string; params: any[] }>;
}> => {
  const queries: Array<{ sql: string; params: any[] }> = [];
  const client: MockClient = {
    query: jest.fn().mockImplementation((sql: string, params?: any[]) => {
      queries.push({ sql, params: params ?? [] });
      if (sql.includes('get_expired_agent_previews()')) {
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
  const neon = {
    deleteBranch: opts?.neonDeleteFails
      ? jest.fn().mockRejectedValue(new Error('neon-down'))
      : jest.fn().mockResolvedValue(undefined),
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      PreviewTtlService,
      { provide: DATABASE_POOL, useValue: pool },
      { provide: AuditService, useValue: audit },
      { provide: RenderApiClient, useValue: render },
      { provide: NeonApiClient, useValue: neon },
    ],
  }).compile();

  return { service: module.get(PreviewTtlService), audit, render, neon, queries };
};

describe('PreviewTtlService', () => {
  it('sweep is a no-op when no rows are expired', async () => {
    const { service, audit, render } = await makeService([]);
    await service.sweep();
    expect(render.deleteService).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('tears down expired rows: deletes Render service + Neon branch, sets expired, audits', async () => {
    const { service, audit, render, neon, queries } = await makeService([
      {
        id: 'pe-1',
        tenant_id: TENANT,
        render_backend_service_id: 'svc-1',
        neon_branch_id: 'br-1',
        neon_branch_name: 'agent-1',
      },
    ]);
    await service.sweep();
    expect(render.deleteService).toHaveBeenCalledWith('svc-1');
    expect(neon.deleteBranch).toHaveBeenCalledWith('br-1');
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
          neon_branch_id: null,
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

  it('skips Neon delete when neon_branch_id is null (PR-driven legacy rows)', async () => {
    const { service, neon } = await makeService([
      {
        id: 'pe-3',
        tenant_id: TENANT,
        render_backend_service_id: 'svc-3',
        neon_branch_id: null,
        neon_branch_name: 'left-over-name',
      },
    ]);
    await service.sweep();
    expect(neon.deleteBranch).not.toHaveBeenCalled();
  });

  it('still flips status to expired when Neon deleteBranch fails', async () => {
    const { service, audit, neon, queries } = await makeService(
      [
        {
          id: 'pe-4',
          tenant_id: TENANT,
          render_backend_service_id: null,
          neon_branch_id: 'br-4',
          neon_branch_name: 'agent-4',
        },
      ],
      { neonDeleteFails: true },
    );
    await service.sweep();
    expect(neon.deleteBranch).toHaveBeenCalledWith('br-4');
    const updateQ = queries.find(
      (q) => q.sql.includes('UPDATE preview_environments') && q.sql.includes("status = 'expired'"),
    );
    expect(updateQ).toBeDefined();
    expect(audit.log).toHaveBeenCalled();
  });
});
