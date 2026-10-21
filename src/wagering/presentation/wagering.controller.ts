import { Body, Controller, Headers, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';
import { Money } from '../../shared/domain/money';
import { ValidationError } from '../../shared/domain/errors';
import { WagerTransactionKind } from '../domain/wager-transaction';
import { SubmitWagerTransactionUseCase } from '../application/submit-wager-transaction.use-case';
import type { SubmitWagerResult } from '../application/submit-wager-transaction.use-case';
import { SubmitTransactionDto } from './dto/submit-transaction.dto';

/**
 * POST /wagering/transactions (§9).
 *
 * Idempotência:
 * - header `Idempotency-Key` é OBRIGATÓRIO (400 se ausente);
 * - default recomendado: "{providerId}:{externalTransactionId}";
 * - requisição idêntica → mesma resposta com idempotentReplay: true;
 * - mesma key com payload diferente → 409 (não é replay).
 *
 * Mapeamento de status (§6 do plano):
 * 200 PROCESSED/replay · 202 PENDING_REFERENCE · 422 REJECTED+failureCode ·
 * 409 conflito · 400 payload inválido · 503 falha transitória.
 */
@Controller('wagering')
export class WageringController {
  constructor(private readonly submit: SubmitWagerTransactionUseCase) {}

  @Post('transactions')
  @HttpCode(HttpStatus.OK)
  async create(
    @Body() dto: SubmitTransactionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: ExpressResponse,
  ): Promise<unknown> {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw new ValidationError('Idempotency-Key header is required');
    }
    const result = await this.submit.execute(
      {
        providerId: dto.providerId,
        externalTransactionId: dto.externalTransactionId,
        idempotencyKey,
        playerId: dto.playerId,
        walletId: dto.walletId,
        roundId: dto.roundId,
        gameId: dto.gameId,
        kind: dto.kind as WagerTransactionKind,
        money: Money.from(dto.money),
        referenceExternalTransactionId: dto.referenceExternalTransactionId,
      },
      { source: 'HTTP' },
    );

    switch (result.outcome) {
      case 'PROCESSED':
        res.status(HttpStatus.OK);
        return toBody(result);
      case 'PENDING_REFERENCE':
        res.status(HttpStatus.ACCEPTED);
        return toBody(result);
      case 'REJECTED':
        res.status(HttpStatus.UNPROCESSABLE_ENTITY);
        return toBody(result);
      case 'CONFLICT':
        res.status(HttpStatus.CONFLICT);
        return {
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'same Idempotency-Key with a different payload',
          transactionId: result.transaction.id,
          idempotentReplay: false,
        };
    }
  }
}

function toBody(result: SubmitWagerResult): Record<string, unknown> {
  return {
    transactionId: result.transaction.id,
    status: result.transaction.status,
    ...(result.balanceAfter ? { balance: result.balanceAfter.toJSON() } : {}),
    ...(result.failureCode ? { failureCode: result.failureCode } : {}),
    idempotentReplay: result.idempotentReplay,
  };
}
