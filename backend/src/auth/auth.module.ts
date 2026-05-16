import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { TenantMiddleware } from './tenant.middleware';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET', 'change-me-in-production'),
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN', '1h') },
      }),
    }),
  ],
  providers: [JwtStrategy, AuthService, TenantMiddleware],
  controllers: [AuthController],
  exports: [JwtModule, AuthService],
})
export class AuthModule {}
