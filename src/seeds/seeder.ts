/**
 * Database Seeder Script
 *
 * This script populates the database with dummy data for testing purposes.
 * It creates Movies, Cinemas, and Showtimes with auto-generated seat maps.
 *
 * Usage: npm run seed
 *
 * Environment Variables:
 * - MONGO_URI: MongoDB connection string (required, from .env file)
 */

import mongoose from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';

// Import schemas
import { MovieSchema, MovieStatus } from '../modules/movie/movie.schema';
import {
  CinemaSchema,
  ScreenType,
  SeatLayout,
} from '../modules/cinema/cinema.schema';
import {
  ShowtimeSchema,
  SeatStatus,
  SeatType,
  ShowtimeStatus,
  SeatInfo,
} from '../modules/showtime/showtime.schema';

// Types for dummy data
interface DummyMovie {
  title: string;
  duration: number;
  genre: string[];
  poster_url: string;
  description: string;
  release_date: string;
  status: string;
}

interface DummyScreen {
  screen_id: string;
  name: string;
  type: string;
  total_seats: number;
  seat_layout: {
    rows: number;
    cols: number;
    unavailable: string[];
  };
}

interface DummyCinema {
  name: string;
  address: string;
  city: string;
  phone: string;
  is_active: boolean;
  screens: DummyScreen[];
}

interface DummyShowtime {
  movie_index: number;
  cinema_index: number;
  screen_id: string;
  start_time: string;
  price: {
    standard: number;
    vip: number;
    couple: number;
  };
}

interface DummyData {
  movies: DummyMovie[];
  cinemas: DummyCinema[];
  showtimes: DummyShowtime[];
  test_users: { user_id: string; name: string; email: string }[];
}

// Logger utility
const logger = {
  info: (message: string, data?: unknown) => {
    console.log(`[INFO] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  },
  success: (message: string, data?: unknown) => {
    console.log(
      `[SUCCESS] ${message}`,
      data ? JSON.stringify(data, null, 2) : '',
    );
  },
  error: (message: string, error?: unknown) => {
    console.error(`[ERROR] ${message}`, error);
  },
  warn: (message: string) => {
    console.warn(`[WARN] ${message}`);
  },
};

/**
 * Generate seat ID from row index and column number
 * Row 0 = A, Row 1 = B, etc.
 */
function generateSeatId(rowIndex: number, colNumber: number): string {
  const rowLetter = String.fromCharCode(65 + rowIndex); // 65 = 'A'
  return `${rowLetter}${colNumber}`;
}

/**
 * Determine seat type based on position
 * - Last 2 rows: VIP
 * - First row, pairs: COUPLE
 * - Rest: STANDARD
 */
function determineSeatType(
  rowIndex: number,
  colNumber: number,
  totalRows: number,
  totalCols: number,
): SeatType {
  // Last 2 rows are VIP
  if (rowIndex >= totalRows - 2) {
    return SeatType.VIP;
  }

  // First row, even columns are COUPLE seats (paired)
  if (rowIndex === 0 && colNumber % 2 === 0 && colNumber < totalCols) {
    return SeatType.COUPLE;
  }

  return SeatType.STANDARD;
}

/**
 * Generate seats map from seat layout configuration
 */
function generateSeatsMap(seatLayout: SeatLayout): Map<string, SeatInfo> {
  const seatsMap = new Map<string, SeatInfo>();
  const unavailableSet = new Set(seatLayout.unavailable);

  for (let row = 0; row < seatLayout.rows; row++) {
    for (let col = 1; col <= seatLayout.cols; col++) {
      const seatId = generateSeatId(row, col);

      // Skip unavailable seats
      if (unavailableSet.has(seatId)) {
        continue;
      }

      const seatType = determineSeatType(
        row,
        col,
        seatLayout.rows,
        seatLayout.cols,
      );

      seatsMap.set(seatId, {
        status: SeatStatus.AVAILABLE,
        seat_type: seatType,
      });
    }
  }

  return seatsMap;
}

/**
 * Convert Map to plain object for MongoDB storage
 */
function mapToObject(map: Map<string, SeatInfo>): Record<string, SeatInfo> {
  const obj: Record<string, SeatInfo> = {};
  map.forEach((value, key) => {
    obj[key] = value;
  });
  return obj;
}

/**
 * Main seeder function
 */
async function seed(): Promise<void> {
  // Load .env file
  const dotenv = await import('dotenv');
  dotenv.config();

  const mongoUri = process.env.MONGO_URI;

  if (!mongoUri) {
    logger.error('MONGO_URI is not defined in .env file');
    process.exit(1);
  }

  logger.info('Starting database seeder...');
  logger.info(`Connecting to MongoDB: ${mongoUri.replace(/\/\/[^:]+:[^@]+@/, '//<credentials>@')}`);

  try {
    // Connect to MongoDB
    await mongoose.connect(mongoUri);
    logger.success('Connected to MongoDB');

    // Create models
    const MovieModel = mongoose.model('Movie', MovieSchema);
    const CinemaModel = mongoose.model('Cinema', CinemaSchema);
    const ShowtimeModel = mongoose.model('Showtime', ShowtimeSchema);

    // Read dummy data
    const dummyDataPath = path.join(__dirname, 'dummy-data.json');
    const dummyDataRaw = fs.readFileSync(dummyDataPath, 'utf-8');
    const dummyData: DummyData = JSON.parse(dummyDataRaw);

    logger.info('Loaded dummy data', {
      movies: dummyData.movies.length,
      cinemas: dummyData.cinemas.length,
      showtimes: dummyData.showtimes.length,
    });

    // Clear existing data (optional - comment out if you want to append)
    logger.warn('Clearing existing data...');
    await Promise.all([
      MovieModel.deleteMany({}),
      CinemaModel.deleteMany({}),
      ShowtimeModel.deleteMany({}),
    ]);
    logger.success('Existing data cleared');

    // Seed Movies
    logger.info('Seeding movies...');
    const movieDocs = dummyData.movies.map((movie) => ({
      title: movie.title,
      duration: movie.duration,
      genre: movie.genre,
      poster_url: movie.poster_url,
      description: movie.description,
      release_date: new Date(movie.release_date),
      status: movie.status as MovieStatus,
    }));

    const createdMovies = await MovieModel.insertMany(movieDocs);
    logger.success(`Created ${createdMovies.length} movies`, {
      movies: createdMovies.map((m) => ({ id: m._id, title: m.title })),
    });

    // Seed Cinemas
    logger.info('Seeding cinemas...');
    const cinemaDocs = dummyData.cinemas.map((cinema) => ({
      name: cinema.name,
      address: cinema.address,
      city: cinema.city,
      phone: cinema.phone,
      is_active: cinema.is_active,
      screens: cinema.screens.map((screen) => ({
        screen_id: screen.screen_id,
        name: screen.name,
        type: screen.type as ScreenType,
        total_seats: screen.total_seats,
        seat_layout: {
          rows: screen.seat_layout.rows,
          cols: screen.seat_layout.cols,
          unavailable: screen.seat_layout.unavailable,
        },
      })),
    }));

    const createdCinemas = await CinemaModel.insertMany(cinemaDocs);
    logger.success(`Created ${createdCinemas.length} cinemas`, {
      cinemas: createdCinemas.map((c) => ({ id: c._id, name: c.name })),
    });

    // Seed Showtimes
    logger.info('Seeding showtimes...');
    const showtimeDocs = dummyData.showtimes.map((showtime) => {
      const movie = createdMovies[showtime.movie_index];
      const cinema = createdCinemas[showtime.cinema_index];

      // Find the screen in the cinema
      const screen = cinema.screens.find(
        (s) => s.screen_id === showtime.screen_id,
      );

      if (!screen) {
        throw new Error(
          `Screen ${showtime.screen_id} not found in cinema ${cinema.name}`,
        );
      }

      // Calculate end time based on movie duration
      const startTime = new Date(showtime.start_time);
      const endTime = new Date(
        startTime.getTime() + movie.duration * 60 * 1000,
      );

      // Generate seats map from screen layout
      const seatsMap = generateSeatsMap(screen.seat_layout);
      const availableSeats = seatsMap.size;

      return {
        movie_id: movie._id,
        cinema_id: cinema._id,
        screen_id: showtime.screen_id,
        start_time: startTime,
        end_time: endTime,
        price: {
          standard: showtime.price.standard,
          vip: showtime.price.vip,
          couple: showtime.price.couple,
        },
        total_seats: screen.total_seats,
        available_seats: availableSeats,
        seats: mapToObject(seatsMap),
        status: ShowtimeStatus.SCHEDULED,
        version: 0,
      };
    });

    const createdShowtimes = await ShowtimeModel.insertMany(showtimeDocs);
    logger.success(`Created ${createdShowtimes.length} showtimes`, {
      showtimes: createdShowtimes.map((s) => ({
        id: s._id,
        movie_id: s.movie_id,
        cinema_id: s.cinema_id,
        screen_id: s.screen_id,
        start_time: s.start_time,
        available_seats: s.available_seats,
      })),
    });

    // Summary
    logger.info('='.repeat(50));
    logger.success('Seeding completed successfully!');
    logger.info('Summary:', {
      movies_created: createdMovies.length,
      cinemas_created: createdCinemas.length,
      showtimes_created: createdShowtimes.length,
      total_screens: createdCinemas.reduce(
        (acc, c) => acc + c.screens.length,
        0,
      ),
    });

    // Log test users info
    logger.info('Test Users (for reference):', dummyData.test_users);
  } catch (error) {
    logger.error('Seeding failed', error);
    throw error;
  } finally {
    // Disconnect from MongoDB
    await mongoose.disconnect();
    logger.info('Disconnected from MongoDB');
  }
}

// Run seeder
seed()
  .then(() => {
    logger.success('Seeder finished');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Seeder failed', error);
    process.exit(1);
  });
