import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule);

  // Get configuration service
  const configService = app.get(ConfigService);

  // Configure CORS with environment-based origins
  const corsOrigins = configService.get<string>('CORS_ORIGINS', '');
  const allowedOrigins = corsOrigins
    ? corsOrigins.split(',').map((origin) => origin.trim())
    : [];

  const nodeEnv = configService.get<string>('NODE_ENV', 'development');
  const isDevelopment = nodeEnv === 'development';

  app.enableCors({
    origin: isDevelopment
      ? true // Allow all origins in development
      : allowedOrigins.length > 0
        ? allowedOrigins
        : false, // Block all if no origins configured in production
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key'],
    credentials: true,
  });

  if (!isDevelopment && allowedOrigins.length === 0) {
    logger.warn(
      'CORS_ORIGINS not configured for production. CORS is disabled.',
    );
  } else if (!isDevelopment) {
    logger.log(`CORS enabled for origins: ${allowedOrigins.join(', ')}`);
  }

  // Set global API prefix
  app.setGlobalPrefix('api');

  // Register global exception filter
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global validation pipe with transform enabled
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true, // Automatically transform payloads to DTO instances
      whitelist: true, // Strip properties not in DTO
      forbidNonWhitelisted: true, // Throw error for unknown properties
      transformOptions: {
        enableImplicitConversion: true, // Enable type coercion
      },
    }),
  );

  // Validate required environment variables in production
  if (!isDevelopment) {
    const requiredEnvVars = ['JWT_SECRET', 'MONGO_URI'];
    const missingVars = requiredEnvVars.filter(
      (varName) => !configService.get(varName),
    );

    if (missingVars.length > 0) {
      logger.error(
        `Missing required environment variables: ${missingVars.join(', ')}`,
      );
      process.exit(1);
    }
  }

  // Get port from environment or default to 3000
  const port = configService.get<number>('PORT', 3000);

  await app.listen(port);

  logger.log(`Application is running on: http://localhost:${port}/api`);
  logger.log(`Environment: ${nodeEnv}`);
}

bootstrap();
