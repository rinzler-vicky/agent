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
});
