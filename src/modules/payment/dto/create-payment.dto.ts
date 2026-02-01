import {
  IsString,
  IsNotEmpty,
  IsIn,
  IsOptional,
  IsUrl,
} from 'class-validator';

/**
 * Các phương thức thanh toán được hỗ trợ cho DTO
 * (string literal type for validation)
 */
export type CreatePaymentMethod = 'momo' | 'vnpay' | 'zalopay' | 'card';

/**
 * DTO cho việc tạo payment mới
 * Yêu cầu header X-Idempotency-Key để đảm bảo không tạo duplicate payment
 */
export class CreatePaymentDto {
  /**
   * ID của booking cần thanh toán
   * Booking phải ở trạng thái 'pending' và chưa hết hạn
   */
  @IsString({ message: 'booking_id phải là chuỗi' })
  @IsNotEmpty({ message: 'booking_id không được để trống' })
  booking_id: string;

  /**
   * Phương thức thanh toán
   * Các giá trị hợp lệ: momo, vnpay, zalopay, card
   */
  @IsIn(['momo', 'vnpay', 'zalopay', 'card'], {
    message: 'payment_method phải là một trong: momo, vnpay, zalopay, card',
  })
  @IsNotEmpty({ message: 'payment_method không được để trống' })
  payment_method: CreatePaymentMethod;

  /**
   * URL để redirect sau khi thanh toán (optional)
   * Nếu không cung cấp, sẽ sử dụng URL mặc định từ config
   */
  @IsOptional()
  @IsUrl({}, { message: 'return_url phải là URL hợp lệ' })
  return_url?: string;
}
