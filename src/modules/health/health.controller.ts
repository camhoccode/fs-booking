import { Controller, Get } from '@nestjs/common';
import { HealthService, HealthCheckResult } from './health.service';

/**
 * HealthController provides health check endpoints for Docker/K8s
 *
 * Endpoints:
 * - GET /health - Full health check (MongoDB + Redis)
 * - GET /health/live - Liveness probe (app is running)
 * - GET /health/ready - Readiness probe (dependencies ready)
 */
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * Full health check - checks all dependencies
   * Used by: Docker HEALTHCHECK, monitoring systems
   */
  @Get()
  async check(): Promise<HealthCheckResult> {
    return this.healthService.check();
  }

  /**
   * Liveness probe - is the app process alive?
   * Used by: Kubernetes livenessProbe
   */
  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  /**
   * Readiness probe - is the app ready to accept traffic?
   * Used by: Kubernetes readinessProbe
   */
  @Get('ready')
  async ready(): Promise<HealthCheckResult> {
    return this.healthService.check();
  }
}
