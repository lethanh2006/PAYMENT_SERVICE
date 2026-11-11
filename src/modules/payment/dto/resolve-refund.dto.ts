import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import type { RefundOutcome } from '../refund.repository';

export class ResolveRefundDto {
  @IsIn(['REFUNDED', 'DISMISSED'], {
    message: 'outcome phải là REFUNDED hoặc DISMISSED',
  })
  outcome: RefundOutcome;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Ghi chú tối đa 500 ký tự' })
  note?: string;
}
