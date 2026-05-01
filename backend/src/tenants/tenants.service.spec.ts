import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { DATABASE_POOL } from '../database/database.module';

const mockPool = { query: jest.fn() };

describe('TenantsService', () => {
  let service: TenantsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantsService,
        { provide: DATABASE_POOL, useValue: mockPool },
      ],
    }).compile();
    service = module.get<TenantsService>(TenantsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('creates a tenant successfully', async () => {
      const tenant = { id: 'uuid-1', slug: 'acme', display_name: 'ACME Corp', plan: 'free' };
      mockPool.query.mockResolvedValueOnce({ rows: [tenant] });
      const result = await service.create({ slug: 'acme', displayName: 'ACME Corp' });
      expect(result).toEqual(tenant);
    });

    it('throws ConflictException on duplicate slug', async () => {
      mockPool.query.mockRejectedValueOnce({ code: '23505' });
      await expect(service.create({ slug: 'acme', displayName: 'ACME Corp' }))
        .rejects.toThrow(ConflictException);
    });
  });

  describe('findById', () => {
    it('returns tenant when found', async () => {
      const tenant = { id: 'uuid-1', slug: 'acme' };
      mockPool.query.mockResolvedValueOnce({ rows: [tenant] });
      const result = await service.findById('uuid-1');
      expect(result).toEqual(tenant);
    });

    it('throws NotFoundException when not found', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      await expect(service.findById('uuid-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findAll', () => {
    it('returns all active tenants', async () => {
      const tenants = [{ id: 'uuid-1' }, { id: 'uuid-2' }];
      mockPool.query.mockResolvedValueOnce({ rows: tenants });
      const result = await service.findAll();
      expect(result).toHaveLength(2);
    });
  });

  describe('deactivate', () => {
    it('deactivates a tenant', async () => {
      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });
      await expect(service.deactivate('uuid-1')).resolves.not.toThrow();
    });

    it('throws NotFoundException when tenant not found', async () => {
      mockPool.query.mockResolvedValueOnce({ rowCount: 0 });
      await expect(service.deactivate('uuid-1')).rejects.toThrow(NotFoundException);
    });
  });
});
