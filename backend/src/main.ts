import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  // Fail fast if critical secrets are missing or still at insecure defaults
  const jwtSecret = config.get<string>('JWT_SECRET', '');
  if (!jwtSecret || jwtSecret === 'change-me-in-production') {
    if (config.get<string>('NODE_ENV') === 'production') {
      throw new Error('JWT_SECRET must be set to a strong secret in production');
    }
    console.warn('⚠️  JWT_SECRET not set — using insecure default (development only)');
  }

  // Security
  app.use(helmet());

  // CORS
  app.enableCors({
    origin: config.get<string>('CORS_ORIGINS', 'http://localhost:3001').split(','),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  // API versioning
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  // Swagger / OpenAPI
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Agent Backend API')
    .setDescription('Phase 1: Foundation & Database Layer')
    .setVersion('1.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', name: 'x-api-key', in: 'header' }, 'api-key')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = config.get<number>('PORT', 3000);
  await app.listen(port);
  console.log(`🚀 Backend API running on http://localhost:${port}`);
  console.log(`📚 Swagger docs: http://localhost:${port}/api/docs`);
}

bootstrap();
