import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Movie, MovieSchema } from './movie.schema';

/**
 * MovieModule handles all movie-related functionality
 *
 * Features:
 * - Movie CRUD operations
 * - Movie search and filtering by status, genre
 * - Movie listing for showtimes
 *
 * Dependencies:
 * - MongooseModule: For database operations
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: Movie.name, schema: MovieSchema }]),
  ],
  controllers: [],
  providers: [],
  exports: [MongooseModule],
})
export class MovieModule {}
