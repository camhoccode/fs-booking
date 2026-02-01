import { Global, Module } from '@nestjs/common';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { WebhookSignatureService } from './services/webhook-signature.service';

/**
 * CommonModule provides shared services across the application
 *
 * Services:
 * - WebhookSignatureService: Verify webhook signatures from payment providers
 *
 * Also configures:
 * - JwtModule: For JWT token verification in AuthGuard
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService): JwtModuleOptions => {
        const expiresIn = configService.get<string>('JWT_EXPIRES_IN') || '1h';
        return {
          secret: configService.get<string>('JWT_SECRET'),
          signOptions: {
            expiresIn: expiresIn as `${number}${'s' | 'm' | 'h' | 'd'}` | number,
          },
        };
      },
      inject: [ConfigService],
    }),
  ],
  providers: [WebhookSignatureService],
  exports: [JwtModule, WebhookSignatureService],
})
export class CommonModule {}
