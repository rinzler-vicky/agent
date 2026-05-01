import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { DATABASE_POOL } from '../database/database.module';
import * as bcrypt from 'bcrypt';

const mockPool = { query: jest.fn() };
const mockJwtService = { sign: jest.fn().mockReturnValue('mock-token') };

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: DATABASE_POOL, useValue: mockPool },
        { provide: JwtService, useValue: mockJwtService },
      ],
    }).compile();
    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('validateUser', () => {
    it('throws UnauthorizedException when user not found', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      await expect(service.validateUser('test@example.com', 'pass', 'acme'))
        .rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when password invalid', async () => {
      const hash = await bcrypt.hash('correct-pass', 10);
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'u1', email: 'test@example.com', password_hash: hash }] });
      await expect(service.validateUser('test@example.com', 'wrong-pass', 'acme'))
        .rejects.toThrow(UnauthorizedException);
    });

    it('returns user when credentials are valid', async () => {
      const hash = await bcrypt.hash('correct-pass', 10);
      const user = { id: 'u1', email: 'test@example.com', password_hash: hash, tenant_id: 't1', role: 'member' };
      mockPool.query.mockResolvedValueOnce({ rows: [user] });
      const result = await service.validateUser('test@example.com', 'correct-pass', 'acme');
      expect(result).toEqual(user);
    });
  });

  describe('login', () => {
    it('returns access_token', async () => {
      const user = { id: 'u1', email: 'test@example.com', tenant_id: 't1', role: 'member' };
      const result = await service.login(user);
      expect(result.access_token).toBe('mock-token');
    });
  });

  describe('validateServiceAccount', () => {
    it('throws UnauthorizedException for missing separator', async () => {
      await expect(service.validateServiceAccount('nodothere'))
        .rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when id is empty', async () => {
      await expect(service.validateServiceAccount('.secret'))
        .rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when service account not found', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      await expect(service.validateServiceAccount('sa-id.my-secret'))
        .rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when bcrypt compare fails', async () => {
      const hash = await bcrypt.hash('correct-secret', 10);
      const sa = { id: 'sa-id', api_key_hash: hash, is_active: true, tenant_id: 't1' };
      mockPool.query.mockResolvedValueOnce({ rows: [sa] });
      await expect(service.validateServiceAccount('sa-id.wrong-secret'))
        .rejects.toThrow(UnauthorizedException);
    });

    it('returns service account when credentials are valid', async () => {
      const hash = await bcrypt.hash('correct-secret', 10);
      const sa = { id: 'sa-id', api_key_hash: hash, is_active: true, tenant_id: 't1' };
      mockPool.query.mockResolvedValueOnce({ rows: [sa] });
      const result = await service.validateServiceAccount('sa-id.correct-secret');
      expect(result).toEqual(sa);
    });

    it('handles secrets containing dots correctly', async () => {
      const secretWithDots = 'secret.with.dots.inside';
      const hash = await bcrypt.hash(secretWithDots, 10);
      const sa = { id: 'sa-id', api_key_hash: hash, is_active: true, tenant_id: 't1' };
      mockPool.query.mockResolvedValueOnce({ rows: [sa] });
      const result = await service.validateServiceAccount(`sa-id.${secretWithDots}`);
      expect(result).toEqual(sa);
    });
  });
});
