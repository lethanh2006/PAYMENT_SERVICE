import { IsIn } from 'class-validator';

import {
  RELEASE_REASONS,
  type ReleaseReason,
} from '../../../common/security/payment-request-context';

export class ReleaseLinksDto {
  @IsIn(RELEASE_REASONS, {
    message: `reason phải là một trong ${RELEASE_REASONS.join(', ')}`,
  })
  reason: ReleaseReason;
}
