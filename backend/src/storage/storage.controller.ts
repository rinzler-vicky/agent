import { Controller, Post, Body, UseGuards, Request, UnauthorizedException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsNumber, IsPositive } from 'class-validator';
import { StorageService } from './storage.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

class GenerateUploadUrlDto {
  @IsString()
  fileName: string;

  @IsString()
  contentType: string;

  @IsNumber()
  @IsPositive()
  fileSizeBytes: number;
}

@ApiTags('storage')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'storage', version: '1' })
export class StorageController {
  constructor(private readonly storageService: StorageService) {}

  @Post('upload-url')
  @ApiOperation({ summary: 'Generate a pre-signed upload URL' })
  generateUploadUrl(@Body() dto: GenerateUploadUrlDto, @Request() req: any) {
    const tenantId = req.tenantId;
    if (!tenantId) {
      throw new UnauthorizedException('Missing tenantId — ensure a valid JWT is provided');
    }
    return this.storageService.generateUploadUrl({ tenantId, ...dto });
  }
}
