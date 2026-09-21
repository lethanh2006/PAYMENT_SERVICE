import { UnprocessableEntityException } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

function collectFieldPaths(errors: ValidationError[], prefix = ''): string[] {
  const fields: string[] = [];

  for (const error of errors) {
    const property = String(error.property ?? '').trim();
    if (!property || !/^[A-Za-z0-9_[\]-]{1,100}$/.test(property)) {
      continue;
    }

    const path = prefix ? `${prefix}.${property}` : property;
    if (error.constraints && Object.keys(error.constraints).length > 0) {
      fields.push(path);
    }
    if (error.children?.length) {
      fields.push(...collectFieldPaths(error.children, path));
    }
  }

  return fields;
}

export function createValidationException(
  errors: ValidationError[],
): UnprocessableEntityException {
  const fields = [...new Set(collectFieldPaths(errors))].slice(0, 50);

  return new UnprocessableEntityException({
    statusCode: 422,
    code: 'VALIDATION_ERROR',
    message: 'Dữ liệu không hợp lệ',
    details: { fields },
  });
}
