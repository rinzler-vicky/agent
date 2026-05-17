import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBody, ApiHeader, ApiOkResponse, ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString } from 'class-validator';
import { AuthService } from './auth.service';

class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;

  @IsString()
  tenantSlug: string;
}

class TokenResponseDto {
  @ApiProperty({ description: 'Signed JWT to include as `Authorization: Bearer <token>`' })
  access_token: string;
}

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login and receive JWT' })
  @ApiOkResponse({ type: TokenResponseDto })
  async login(@Body() dto: LoginDto) {
    const user = await this.authService.validateUser(dto.email, dto.password, dto.tenantSlug);
    return this.authService.login(user);
  }

  /**
   * Exchange a service-account API key for a short-lived JWT. The returned
   * token carries `type='service_account'` and a `scopes` claim drawn from
   * `service_accounts.scopes` so callers can authenticate the agent-facing
   * routes (e.g. POST /v1/workflow-proposals) with the same Bearer-token
   * pattern as human routes. The API key is the bootstrap credential; the
   * JWT is what travels on subsequent requests.
   */
  @Post('service-account/token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a service-account API key for a JWT carrying scopes',
    description:
      'Accepts the API key via either `x-api-key` header or `Authorization: Bearer <id.secret>`. ' +
      'Returns an access_token with `type=service_account` and a `scopes` array.',
  })
  @ApiHeader({ name: 'x-api-key', required: false, description: 'API key in `<id>.<secret>` format' })
  @ApiHeader({
    name: 'authorization',
    required: false,
    description: 'Alternative: `Bearer <id>.<secret>` (legacy)',
  })
  @ApiOkResponse({ type: TokenResponseDto })
  async serviceAccountToken(
    @Headers('x-api-key') apiKeyHeader: string | undefined,
    @Headers('authorization') authHeader: string | undefined,
  ): Promise<TokenResponseDto> {
    const apiKey =
      apiKeyHeader ??
      (authHeader?.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : undefined);
    if (!apiKey) {
      throw new UnauthorizedException('Missing API key (x-api-key header or Authorization: Bearer)');
    }
    const sa = await this.authService.validateServiceAccount(apiKey);
    return this.authService.loginServiceAccount(sa);
  }
}
