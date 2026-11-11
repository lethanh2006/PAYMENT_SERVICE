import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

import type { RefundStatus } from '../refund.repository';

export class RefundQueryDto {
  @IsOptional()
  @IsIn(['OPEN', 'REFUNDED', 'DISMISSED'], {
    message: 'status phải là OPEN, REFUNDED hoặc DISMISSED',
  })
  status?: RefundStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}
