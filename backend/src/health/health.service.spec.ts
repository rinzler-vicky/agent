import { Test, TestingModule } from '@nestjs/testing';
import { HealthService } from './health.service';
import { DATABASE_POOL } from '../database/database.module';

const mockPool = {
  connect: jest.fn().mockResolvedValue({
    query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    release: jest.fn(),
  }),
};

describe('HealthService', () => {
  let service: HealthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: DATABASE_POOL, useValue: mockPool },
      ],
    }).compile();
    service = module.get<HealthService>(HealthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('check() returns ok when database is healthy', async () => {
    const result = await service.check();
    expect(result.status).toBe('ok');
    expect(result.checks.database).toBe('ok');
  });

  it('check() returns degraded when database is down', async () => {
    mockPool.connect.mockRejectedValueOnce(new Error('connection refused'));
    const result = await service.check();
    expect(result.status).toBe('degraded');
    expect(result.checks.database).toBe('error');
  });

  it('version() returns version info', () => {
    const result = service.version();
    expect(result.name).toBe('agent-backend');
    expect(result.phase).toBe(1);
  });
});
