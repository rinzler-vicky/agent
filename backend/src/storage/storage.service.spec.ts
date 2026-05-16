import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';

// Mock the AWS SDK
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: jest.fn(),
  })),
  PutObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://s3.example.com/signed-url'),
}));

const mockConfig = { get: jest.fn((key: string, def?: any) => def) };

describe('StorageService', () => {
  let service: StorageService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageService,
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    service = module.get<StorageService>(StorageService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('generateUploadUrl', () => {
    it('returns signed URL for valid request', async () => {
      const result = await service.generateUploadUrl({
        tenantId: 'tenant-1',
        fileName: 'test.json',
        contentType: 'application/json',
        fileSizeBytes: 1024,
      });
      expect(result.uploadUrl).toBe('https://s3.example.com/signed-url');
      expect(result.key).toContain('tenant-1');
      expect(result.expiresIn).toBe(900);
    });

    it('throws BadRequestException for disallowed content type', async () => {
      await expect(
        service.generateUploadUrl({
          tenantId: 'tenant-1',
          fileName: 'evil.sh',
          contentType: 'application/x-sh',
          fileSizeBytes: 100,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when file exceeds 100MB', async () => {
      await expect(
        service.generateUploadUrl({
          tenantId: 'tenant-1',
          fileName: 'big.bin',
          contentType: 'application/octet-stream',
          fileSizeBytes: 200 * 1024 * 1024,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
