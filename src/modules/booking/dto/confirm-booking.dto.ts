import { IsIn, IsNotEmpty, IsOptional, IsUrl } from 'class-validator';

/**
 * Các phương thức thanh toán được hỗ trợ
 */
export type PaymentMethod = 'momo' | 'vnpay' | 'zalopay' | 'card';

/**
 * DTO cho việc xác nhận booking và tạo payment
 *
 * @example
 * ```json
 * {
 *   "payment_method": "momo",
 *   "return_url": "https://example.com/payment/callback"
 * }
 * ```
 */
export class ConfirmBookingDto {
  /**
   * Phương thức thanh toán
   * Các giá trị hợp lệ: momo, vnpay, zalopay, card
   */
  @IsIn(['momo', 'vnpay', 'zalopay', 'card'], {
    message: 'payment_method phải là một trong: momo, vnpay, zalopay, card',
  })
  @IsNotEmpty({ message: 'payment_method không được để trống' })
  payment_method: PaymentMethod;

  /**
   * URL để redirect sau khi thanh toán (optional)
   * Nếu không cung cấp, sẽ sử dụng URL mặc định từ config
   */
  @IsOptional()
  @IsUrl({}, { message: 'return_url phải là URL hợp lệ' })
  return_url?: string;
}
