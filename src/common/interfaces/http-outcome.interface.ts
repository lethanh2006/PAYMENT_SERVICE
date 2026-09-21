import type { Response } from 'express';

export interface HttpOutcomeContext {
  errorCode: string;
  validationFields: string[];
}

export interface ResponseWithOutcome extends Response {
  locals: Response['locals'] & {
    observabilityOutcome?: HttpOutcomeContext;
  };
}
