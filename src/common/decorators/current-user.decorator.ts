import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

/**
 * User interface attached to request after authentication
 */
export interface CurrentUserData {
  id: string;
  email: string;
  role: string;
}

/**
 * Extended Express Request with user data
 */
export interface AuthenticatedRequest extends Request {
  user: CurrentUserData;
}

/**
 * Custom decorator to extract current user from request
 *
 * @example
 * ```typescript
 * @Get('/profile')
 * @UseGuards(AuthGuard)
 * async getProfile(@CurrentUser() user: CurrentUserData) {
 *   return user;
 * }
 *
 * // Get specific property
 * @Get('/my-id')
 * async getMyId(@CurrentUser('id') userId: string) {
 *   return { userId };
 * }
 * ```
 */
export const CurrentUser = createParamDecorator(
  (property: keyof CurrentUserData | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    if (!user) {
      return null;
    }

    return property ? user[property] : user;
  },
);
