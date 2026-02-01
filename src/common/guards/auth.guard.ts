import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { CurrentUserData } from '../decorators/current-user.decorator';

/**
 * Authentication guard with proper JWT verification
 * Validates JWT token signature and attaches user to request
 *
 * Security features:
 * - Proper JWT signature verification using secret from environment
 * - Token expiration validation
 * - Security event logging for failed authentication attempts
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractTokenFromHeader(request);
    const clientIp = request.ip || request.socket?.remoteAddress || 'unknown';

    if (!token) {
      this.logSecurityEvent('AUTH_TOKEN_MISSING', {
        path: request.url,
        method: request.method,
        ip: clientIp,
        userAgent: request.headers['user-agent'],
      });

      throw new UnauthorizedException({
        statusCode: 401,
        errorCode: 'TOKEN_MISSING',
        message: 'Authentication token is required',
        timestamp: new Date().toISOString(),
        path: request.url,
      });
    }

    try {
      const jwtSecret = this.configService.get<string>('JWT_SECRET');
      if (!jwtSecret) {
        this.logger.error('JWT_SECRET is not configured');
        throw new Error('JWT configuration error');
      }

      const payload = await this.jwtService.verifyAsync<{
        sub: string;
        email: string;
        role?: string;
        iat?: number;
        exp?: number;
      }>(token, {
        secret: jwtSecret,
      });

      const user: CurrentUserData = {
        id: payload.sub,
        email: payload.email,
        role: payload.role || 'user',
      };

      (request as Request & { user: CurrentUserData }).user = user;

      return true;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      this.logSecurityEvent('AUTH_TOKEN_INVALID', {
        path: request.url,
        method: request.method,
        ip: clientIp,
        userAgent: request.headers['user-agent'],
        error: errorMessage,
      });

      throw new UnauthorizedException({
        statusCode: 401,
        errorCode: 'TOKEN_INVALID',
        message: 'Invalid or expired authentication token',
        timestamp: new Date().toISOString(),
        path: request.url,
      });
    }
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }

  /**
   * Log security events for monitoring and alerting
   */
  private logSecurityEvent(
    event: string,
    details: Record<string, unknown>,
  ): void {
    this.logger.warn(`[SECURITY] ${event}`, {
      event,
      timestamp: new Date().toISOString(),
      ...details,
    });
  }
}
