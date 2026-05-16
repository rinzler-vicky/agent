import { Test, TestingModule } from '@nestjs/testing';
import { AuditService } from './audit.service';
import { DATABASE_POOL } from '../database/database.module';

const mockPool = { query: jest.fn() };

describe('AuditService', () => {
  let service: AuditService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: DATABASE_POOL, useValue: mockPool },
      ],
    }).compile();
    service = module.get<AuditService>(AuditService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('log() inserts an audit event', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await service.log({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      action: 'CREATE',
      resourceType: 'tenant',
      resourceId: 'tenant-1',
    });
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toContain('INSERT INTO audit_events');
  });

  it('query() returns audit events with tenant filter', async () => {
    const events = [{ id: 'evt-1', action: 'CREATE' }];
    mockPool.query.mockResolvedValueOnce({ rows: events });
    const result = await service.query({ tenantId: 'tenant-1' });
    expect(result).toEqual(events);
    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toContain('tenant_id');
  });
});
