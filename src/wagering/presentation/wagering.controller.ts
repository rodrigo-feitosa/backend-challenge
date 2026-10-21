import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Res } from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';
import { Money } from '../../shared/domain/money';
import { ValidationError } from '../../shared/domain/errors';
import { WagerTransactionKind } from '../domain/wager-transaction';
import { SubmitWagerTransactionUseCase } from '../application/submit-wager-transaction.use-case';
import type { SubmitWagerResult } from '../application/submit-wager-transaction.use-case';
import { TransactionQueries } from '../application/transaction-queries';
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
@Controller()
export class WageringController {
  constructor(
    private readonly submit: SubmitWagerTransactionUseCase,
    private readonly queries: TransactionQueries,
  ) {}

  /** GET /wagering/transactions/:transactionId — id interno. */
  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string): Promise<unknown> {
    return toTransactionBody(await this.queries.getById(transactionId));
  }

  /** GET /providers/:providerId/wagering/transactions/:externalTransactionId — id no provedor. */
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByProviderAndExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<unknown> {
    return toTransactionBody(await this.queries.getByProviderAndExternalId(providerId, externalTransactionId));
  }

  @Post('wagering/transactions')
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

function toTransactionBody(tx: {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  status: string;
  money: { toJSON(): { amount: string; currency: string } };
  referenceExternalTransactionId?: string | undefined;
  failureCode?: string | undefined;
  createdAt: Date;
  processedAt?: Date | undefined;
}): Record<string, unknown> {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    status: tx.status,
    amount: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    failureCode: tx.failureCode ?? null,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt ? tx.processedAt.toISOString() : null,
  };
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
