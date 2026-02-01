import {
  IsString,
  IsNotEmpty,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  Matches,
  IsMongoId,
} from 'class-validator';

/**
 * DTO cho việc giữ ghế (hold seats)
 *
 * Yêu cầu header X-Idempotency-Key để đảm bảo không tạo duplicate booking
 *
 * @example
 * ```json
 * {
 *   "showtime_id": "64a7b8c9d0e1f2a3b4c5d6e7",
 *   "seats": ["A1", "A2", "A3"]
 * }
 * ```
 */
export class HoldSeatsDto {
  /**
   * ID của suất chiếu
   * Phải là MongoDB ObjectId hợp lệ
   */
  @IsMongoId({ message: 'showtime_id phải là MongoDB ObjectId hợp lệ' })
  @IsNotEmpty({ message: 'showtime_id không được để trống' })
  showtime_id: string;

  /**
   * Danh sách ghế cần giữ
   * - Tối thiểu 1 ghế
   * - Tối đa 10 ghế mỗi lần đặt
   * - Format: Chữ cái + số (VD: A1, B2, C10)
   */
  @IsArray({ message: 'seats phải là mảng' })
  @ArrayMinSize(1, { message: 'Phải chọn ít nhất 1 ghế' })
  @ArrayMaxSize(10, { message: 'Tối đa 10 ghế mỗi lần đặt' })
  @IsString({ each: true, message: 'Mỗi ghế phải là chuỗi' })
  @Matches(/^[A-Z][0-9]{1,2}$/, {
    each: true,
    message: 'Mã ghế không hợp lệ. Format: A1, B2, C10...',
  })
  seats: string[];
}
