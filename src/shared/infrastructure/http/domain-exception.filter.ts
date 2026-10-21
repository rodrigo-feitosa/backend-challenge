import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { DomainError } from '../../domain/errors';
import { createLogger } from '../logging/logger';

/**
 * Mapeamento consistente de erros de domínio → HTTP (§6 do plano):
 * 404 não encontrado · 409 conflito · 400 payload inválido ·
 * 422 rejeição por regra de negócio. O corpo carrega o código estável
 * (taxonomia §7.2) para o provedor decidir sem interpretar mensagens.
 */
const STATUS_BY_CODE: Record<string, HttpStatus> = {
  NOT_FOUND: HttpStatus.NOT_FOUND,
  WALLET_ALREADY_EXISTS: HttpStatus.CONFLICT,
  IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
  VALIDATION_ERROR: HttpStatus.BAD_REQUEST,
  AMOUNT_INVALID: HttpStatus.BAD_REQUEST,
  CURRENCY_MISMATCH: HttpStatus.BAD_REQUEST,
  LEDGER_ENTRY_INVALID: HttpStatus.BAD_REQUEST,
  INFRASTRUCTURE_ERROR: HttpStatus.SERVICE_UNAVAILABLE,
};

@Catch(DomainError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: DomainError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse() as {
      status: (code: number) => { json: (body: unknown) => unknown };
      setHeader?: (name: string, value: string) => void;
    };
    const status = STATUS_BY_CODE[exception.code] ?? HttpStatus.UNPROCESSABLE_ENTITY;
    if (status >= 500) {
      createLogger('http').error({ code: exception.code, err: exception }, 'domain error');
    }
    if (status === HttpStatus.SERVICE_UNAVAILABLE) {
      response.setHeader?.('Retry-After', '1');
    }
    response.status(status).json({
      code: exception.code,
      message: exception.message,
    });
  }
}
