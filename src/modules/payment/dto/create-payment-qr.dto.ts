import { Type } from 'class-transformer';
import { IsInt, IsMongoId, Max, Min } from 'class-validator';

export class CreatePaymentQrDto {
  @IsMongoId({ message: 'orderId không hợp lệ' })
  orderId: string;

  @IsMongoId({ message: 'orderUserId không hợp lệ' })
  orderUserId: string;

  @Type(() => Number)
  @IsInt({ message: 'Số tiền phải là số nguyên VND' })
  @Min(1, { message: 'Số tiền phải lớn hơn 0' })
  @Max(Number.MAX_SAFE_INTEGER, { message: 'Số tiền vượt giới hạn hỗ trợ' })
  amount: number;
}
