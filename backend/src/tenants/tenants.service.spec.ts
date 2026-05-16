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

  describe('findBySlug', () => {
    it('returns tenant when found', async () => {
      const tenant = { id: 'uuid-1', slug: 'acme' };
      mockPool.query.mockResolvedValueOnce({ rows: [tenant] });
      const result = await service.findBySlug('acme');
      expect(result).toEqual(tenant);
    });

    it('throws NotFoundException when slug not found', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      await expect(service.findBySlug('unknown')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('updates displayName successfully', async () => {
      const updated = { id: 'uuid-1', slug: 'acme', display_name: 'New Name', plan: 'free' };
      mockPool.query.mockResolvedValueOnce({ rows: [updated] });
      const result = await service.update('uuid-1', { displayName: 'New Name' });
      expect(result).toEqual(updated);
      const [sql, params] = mockPool.query.mock.calls[0];
      expect(sql).toContain('display_name = $1');
      expect(params).toContain('New Name');
    });

    it('updates plan successfully', async () => {
      const updated = { id: 'uuid-1', slug: 'acme', plan: 'pro' };
      mockPool.query.mockResolvedValueOnce({ rows: [updated] });
      const result = await service.update('uuid-1', { plan: 'pro' });
      expect(result).toEqual(updated);
    });

    it('updates multiple fields with correct $N indexing', async () => {
      const updated = { id: 'uuid-1', display_name: 'Name', plan: 'pro' };
      mockPool.query.mockResolvedValueOnce({ rows: [updated] });
      await service.update('uuid-1', { displayName: 'Name', plan: 'pro' });
      const [sql, params] = mockPool.query.mock.calls[0];
      expect(sql).toContain('display_name = $1');
      expect(sql).toContain('plan = $2');
      // id should be the last parameter
      expect(params[params.length - 1]).toBe('uuid-1');
    });

    it('throws NotFoundException when tenant not found', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      await expect(service.update('uuid-1', { displayName: 'X' })).rejects.toThrow(NotFoundException);
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
