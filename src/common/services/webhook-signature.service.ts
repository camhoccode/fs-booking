import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * Service for verifying webhook signatures from payment providers
 *
 * Supports multiple providers with different signature algorithms:
 * - MoMo: HMAC-SHA256
 * - VNPay: HMAC-SHA512
 * - ZaloPay: HMAC-SHA256
 * - Card (generic): HMAC-SHA256
 */
@Injectable()
export class WebhookSignatureService {
  private readonly logger = new Logger(WebhookSignatureService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Verify webhook signature from payment provider
   *
   * @param provider - Payment provider name
   * @param payload - Raw webhook payload
   * @param signature - Signature from X-Signature header
   * @returns true if signature is valid
   */
  verifySignature(
    provider: string,
    payload: Record<string, unknown>,
    signature: string | undefined,
  ): boolean {
    if (!signature) {
      this.logSecurityEvent('WEBHOOK_SIGNATURE_MISSING', { provider });
      return false;
    }

    const secret = this.getProviderSecret(provider);
    if (!secret) {
      this.logger.error(
        `Webhook secret not configured for provider: ${provider}`,
      );
      return false;
    }

    try {
      const expectedSignature = this.computeSignature(provider, payload, secret);
      const isValid = crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature),
      );

      if (!isValid) {
        this.logSecurityEvent('WEBHOOK_SIGNATURE_INVALID', {
          provider,
          receivedSignature: signature.substring(0, 10) + '...',
        });
      }

      return isValid;
    } catch (error) {
      this.logSecurityEvent('WEBHOOK_SIGNATURE_VERIFICATION_ERROR', {
        provider,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  /**
   * Get webhook secret for provider from environment
   */
  private getProviderSecret(provider: string): string | undefined {
    const envKey = `WEBHOOK_SECRET_${provider.toUpperCase()}`;
    return this.configService.get<string>(envKey);
  }

  /**
   * Compute expected signature based on provider's algorithm
   */
  private computeSignature(
    provider: string,
    payload: Record<string, unknown>,
    secret: string,
  ): string {
    const algorithm = this.getAlgorithm(provider);
    const dataToSign = this.prepareSignatureData(provider, payload);

    const hmac = crypto.createHmac(algorithm, secret);
    hmac.update(dataToSign);
    return hmac.digest('hex');
  }

  /**
   * Get HMAC algorithm based on provider
   */
  private getAlgorithm(provider: string): string {
    switch (provider.toLowerCase()) {
      case 'vnpay':
        return 'sha512';
      case 'momo':
      case 'zalopay':
      case 'card':
      default:
        return 'sha256';
    }
  }

  /**
   * Prepare data for signature based on provider's requirements
   */
  private prepareSignatureData(
    provider: string,
    payload: Record<string, unknown>,
  ): string {
    switch (provider.toLowerCase()) {
      case 'momo':
        // MoMo signs specific fields in order
        return [
          payload.partnerCode,
          payload.accessKey,
          payload.requestId,
          payload.amount,
          payload.orderId,
          payload.orderInfo,
          payload.orderType,
          payload.transId,
          payload.message,
          payload.localMessage,
          payload.responseTime,
          payload.errorCode,
          payload.payType,
        ].join('&');

      case 'vnpay':
        // VNPay sorts params alphabetically
        const sortedKeys = Object.keys(payload).sort();
        return sortedKeys
          .map((key) => `${key}=${payload[key]}`)
          .join('&');

      case 'zalopay':
        // ZaloPay uses JSON string
        return JSON.stringify(payload);

      default:
        // Default: JSON stringify
        return JSON.stringify(payload);
    }
  }

  /**
   * Log security events for webhook signature failures
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
