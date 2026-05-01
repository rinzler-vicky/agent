import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';

const ALLOWED_MIME_TYPES = new Set([
  'application/json',
  'text/plain',
  'application/octet-stream',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
]);

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

@Injectable()
export class StorageService {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService) {
    const accessKeyId = config.get<string>('AWS_ACCESS_KEY_ID');
    const secretAccessKey = config.get<string>('AWS_SECRET_ACCESS_KEY');

    this.s3 = new S3Client({
      region: config.get<string>('AWS_REGION', 'us-east-1'),
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
      endpoint: config.get<string>('S3_ENDPOINT'),
    });
    this.bucket = config.get<string>('S3_BUCKET', 'agent-artifacts');
  }

  async generateUploadUrl(params: {
    tenantId: string;
    fileName: string;
    contentType: string;
    fileSizeBytes: number;
  }): Promise<{ uploadUrl: string; key: string; expiresIn: number }> {
    if (!ALLOWED_MIME_TYPES.has(params.contentType)) {
      throw new BadRequestException(`Content type '${params.contentType}' not allowed`);
    }
    if (params.fileSizeBytes > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException('File size exceeds 100 MB limit');
    }

    const key = `tenants/${params.tenantId}/artifacts/${uuidv4()}/${params.fileName}`;
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: params.contentType,
      ContentLength: params.fileSizeBytes,
    });

    const expiresIn = 900; // 15 minutes
    const uploadUrl = await getSignedUrl(this.s3, command, { expiresIn });
    return { uploadUrl, key, expiresIn };
  }

  async generateDownloadUrl(key: string): Promise<{ downloadUrl: string; expiresIn: number }> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    const expiresIn = 3600; // 1 hour
    const downloadUrl = await getSignedUrl(this.s3, command, { expiresIn });
    return { downloadUrl, expiresIn };
  }

  async deleteObject(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
