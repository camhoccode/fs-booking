import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * HealthModule provides health check endpoints
 *
 * Used by:
 * - Docker HEALTHCHECK
 * - Kubernetes liveness/readiness probes
 * - Load balancer health checks
 * - Monitoring systems
 */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
