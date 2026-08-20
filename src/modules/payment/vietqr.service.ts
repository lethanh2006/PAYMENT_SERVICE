import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface BuildVietQrInput {
  amount: number;
  /** Payment-owned reference. Its content is treated as opaque. */
  reference: string;
}

@Injectable()
export class VietQrService {
  private readonly bankId: string;
  private readonly accountNumber: string;
  private readonly accountName: string;
  private readonly templates: readonly string[];
  private readonly descriptionPrefix: string;

  constructor(private readonly configService: ConfigService) {
    this.bankId = this.required('VIETQR_BANK_ID');
    this.accountNumber = this.required('VIETQR_ACCOUNT_NUMBER');
    this.accountName = this.required('VIETQR_ACCOUNT_NAME');
    this.templates = this.readTemplates();
    this.descriptionPrefix = this.required('VIETQR_DESCRIPTION_PREFIX');
  }

  buildQrUrl(input: BuildVietQrInput): string {
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
      throw new RangeError('Số tiền VietQR phải là số nguyên dương an toàn');
    }
    if (typeof input.reference !== 'string' || input.reference.length === 0) {
      throw new TypeError('Mã tham chiếu thanh toán không được để trống');
    }

    const template = this.pickTemplate();
    const imageName = [this.bankId, this.accountNumber, template]
      .map((segment) => encodeURIComponent(segment))
      .join('-');
    const url = new URL(`https://img.vietqr.io/image/${imageName}.jpg`);

    url.searchParams.set('amount', String(input.amount));
    url.searchParams.set(
      'addInfo',
      this.buildTransferDescription(input.reference),
    );
    url.searchParams.set('accountName', this.accountName);

    return url.toString();
  }

  buildTransferDescription(reference: string): string {
    return `${this.descriptionPrefix} ${reference}`;
  }

  getDestinationAccount(): string {
    return this.accountNumber;
  }

  private pickTemplate(): string {
    return this.templates[Math.floor(Math.random() * this.templates.length)];
  }

  private readTemplates(): readonly string[] {
    const configured = this.configService.get<string | string[]>(
      'VIETQR_TEMPLATES',
    );
    const templates = (
      Array.isArray(configured) ? configured : (configured?.split(',') ?? [])
    )
      .map((template) => template.trim())
      .filter((template) => template.length > 0);

    if (templates.length === 0) {
      throw new Error('Thiếu cấu hình VIETQR_TEMPLATES');
    }

    return [...new Set(templates)];
  }

  private required(key: string): string {
    const value = this.configService.get<string>(key)?.trim();
    if (!value) {
      throw new Error(`Thiếu cấu hình ${key}`);
    }
    return value;
  }
}
