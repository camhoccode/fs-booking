import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { CurrentUserData } from '../decorators/current-user.decorator';

/**
 * Authentication guard
 * Validates JWT token and attaches user to request
 *
 * Note: This is a simplified implementation.
 * In production, integrate with your JWT/Auth service
 */
@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException({
        statusCode: 401,
        errorCode: 'TOKEN_MISSING',
        message: 'Authentication token is required',
        timestamp: new Date().toISOString(),
        path: request.url,
      });
    }

    try {
      // TODO: Replace with actual JWT verification
      // const payload = await this.jwtService.verifyAsync(token);
      // For now, decode a simple mock token format: userId:email:role
      const user = this.decodeToken(token);
      (request as Request & { user: CurrentUserData }).user = user;
    } catch {
      throw new UnauthorizedException({
        statusCode: 401,
        errorCode: 'TOKEN_INVALID',
        message: 'Invalid or expired authentication token',
        timestamp: new Date().toISOString(),
        path: request.url,
      });
    }

    return true;
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }

  /**
   * Mock token decoder - Replace with JWT verification in production
   */
  private decodeToken(token: string): CurrentUserData {
    // This is a placeholder. In production, use proper JWT verification
    // Expected format for testing: base64(JSON.stringify({ id, email, role }))
    try {
      const decoded = Buffer.from(token, 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);

      if (!parsed.id || !parsed.email) {
        throw new Error('Invalid token payload');
      }

      return {
        id: parsed.id,
        email: parsed.email,
        role: parsed.role || 'user',
      };
    } catch {
      throw new Error('Token decode failed');
    }
  }
}
