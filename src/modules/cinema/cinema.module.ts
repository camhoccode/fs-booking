import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Cinema, CinemaSchema } from './cinema.schema';

/**
 * CinemaModule handles all cinema-related functionality
 *
 * Features:
 * - Cinema CRUD operations
 * - Screen management within cinemas
 * - Cinema search by city and name
 *
 * Dependencies:
 * - MongooseModule: For database operations
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: Cinema.name, schema: CinemaSchema }]),
  ],
  controllers: [],
  providers: [],
  exports: [MongooseModule],
})
export class CinemaModule {}
