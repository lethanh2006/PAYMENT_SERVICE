import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { signPayosPaymentRequest, verifyPayosData } from './payos-signature';

const PAYOS_API_URL = 'https://api-merchant.payos.vn';
const REQUEST_TIMEOUT_MS = 10_000;

export interface CreatePayosLinkInput {
  orderCode: number;
  amount: number;
  description: string;
  expiresAt: Date;
}

export interface PayosPaymentLink {
  paymentLinkId: string;
  checkoutUrl: string;
  qrCode: string;
  accountNumber: string;
}

/** Một lần tiền về đã được PayOS khớp vào link. */
export interface PayosLinkTransaction {
  reference: unknown;
  amount: unknown;
  transactionDateTime: unknown;
  counterAccountBankName: unknown;
  counterAccountName: unknown;
}

/** `status` là trạng thái link theo PayOS, ví dụ PENDING, PAID, CANCELLED, EXPIRED. */
export interface PayosPaymentLinkInfo {
  status: string;
  transactions: PayosLinkTransaction[];
}

interface PayosEnvelope {
  code?: unknown;
  desc?: unknown;
  data?: unknown;
  signature?: unknown;
}

/** Gọi API kênh thanh toán PayOS và xác minh chữ ký dữ liệu PayOS gửi về. */
@Injectable()
export class PayosClient {
  private readonly clientId: string;
  private readonly apiKey: string;
  private readonly checksumKey: string;
  private readonly returnUrl: string;
  private readonly cancelUrl: string;

  constructor(configService: ConfigService) {
    const required = (key: string): string => {
      const value = configService.get<string>(key)?.trim();
      if (!value) {
        throw new Error(`Thiếu cấu hình ${key}`);
      }
      return value;
    };
    this.clientId = required('PAYOS_CLIENT_ID');
    this.apiKey = required('PAYOS_API_KEY');
    this.checksumKey = required('PAYOS_CHECKSUM_KEY');
    this.returnUrl = required('PAYOS_RETURN_URL');
    this.cancelUrl = required('PAYOS_CANCEL_URL');
  }

  async createPaymentLink(
    input: CreatePayosLinkInput,
  ): Promise<PayosPaymentLink> {
    const fields = {
      orderCode: input.orderCode,
      amount: input.amount,
      description: input.description,
      returnUrl: this.returnUrl,
      cancelUrl: this.cancelUrl,
    };
    const envelope = await this.request('POST', '/v2/payment-requests', {
      ...fields,
      expiredAt: Math.floor(input.expiresAt.getTime() / 1000),
      signature: signPayosPaymentRequest(fields, this.checksumKey),
    });

    const data = envelope.data;
    if (!verifyPayosData(data, envelope.signature, this.checksumKey)) {
      throw new BadGatewayException('Dữ liệu PayOS trả về sai chữ ký');
    }
    const { paymentLinkId, checkoutUrl, qrCode, accountNumber } = data;
    if (
      typeof paymentLinkId !== 'string' ||
      typeof checkoutUrl !== 'string' ||
      typeof qrCode !== 'string'
    ) {
      throw new BadGatewayException(
        'PayOS trả về link thanh toán thiếu dữ liệu',
      );
    }
    return {
      paymentLinkId,
      checkoutUrl,
      qrCode,
      accountNumber: typeof accountNumber === 'string' ? accountNumber : '',
    };
  }

  /** Huỷ link chưa thanh toán; PayOS từ chối nếu link đã được trả. */
  async cancelPaymentLink(paymentLinkId: string, reason: string) {
    await this.request(
      'POST',
      `/v2/payment-requests/${encodeURIComponent(paymentLinkId)}/cancel`,
      { cancellationReason: reason },
    );
  }

  /**
   * Trạng thái và các lần tiền về của link, để đối soát khi webhook không tới. Không kiểm chữ ký
   * như webhook: đây là request mình chủ động gửi tới PayOS qua HTTPS kèm API key.
   */
  async getPaymentLink(paymentLinkId: string): Promise<PayosPaymentLinkInfo> {
    const envelope = await this.request(
      'GET',
      `/v2/payment-requests/${encodeURIComponent(paymentLinkId)}`,
    );
    const { status, transactions } = envelope.data;
    if (typeof status !== 'string' || !Array.isArray(transactions)) {
      throw new BadGatewayException(
        'PayOS trả về thông tin link thiếu dữ liệu',
      );
    }
    return {
      status,
      transactions: transactions.filter(isRecord).map((transaction) => ({
        reference: transaction.reference,
        amount: transaction.amount,
        transactionDateTime: transaction.transactionDateTime,
        counterAccountBankName: transaction.counterAccountBankName,
        counterAccountName: transaction.counterAccountName,
      })),
    };
  }

  /** Trả `data` của webhook nếu chữ ký đúng checksum key, ngược lại `null`. */
  verifyWebhook(payload: unknown): Record<string, unknown> | null {
    if (!isRecord(payload) || !isRecord(payload.data)) {
      return null;
    }
    return verifyPayosData(payload.data, payload.signature, this.checksumKey)
      ? payload.data
      : null;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<PayosEnvelope & { data: Record<string, unknown> }> {
    let response: Response;
    try {
      response = await fetch(`${PAYOS_API_URL}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-client-id': this.clientId,
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ServiceUnavailableException('Không kết nối được PayOS');
    }

    let envelope: PayosEnvelope;
    try {
      envelope = (await response.json()) as PayosEnvelope;
    } catch {
      throw new BadGatewayException(
        `PayOS trả về dữ liệu không đọc được (HTTP ${response.status})`,
      );
    }
    if (envelope.code !== '00' || !isRecord(envelope.data)) {
      const reason =
        typeof envelope.desc === 'string' ? envelope.desc : 'không rõ lý do';
      throw new BadGatewayException(`PayOS từ chối yêu cầu: ${reason}`);
    }
    return envelope as PayosEnvelope & { data: Record<string, unknown> };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
