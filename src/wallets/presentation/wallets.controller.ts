import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Money } from '../../shared/domain/money';
import { ValidationError } from '../../shared/domain/errors';
import { OpenWalletUseCase } from '../application/open-wallet.use-case';
import { WalletQueries } from '../application/wallet-queries';
import { ReconcileWalletUseCase, type ReconciliationReport } from '../application/reconcile-wallet.use-case';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { CreateWalletDto, ListLedgerQueryDto } from './dto/wallet.dto';

/**
 * Endpoints de wallets (§9 do desafio).
 * POST /wallets            → 201
 * GET  /wallets/:id        → 200 / 404
 * GET  /wallets/:id/ledger → 200 (cursor opaco, default 50, máx 100)
 */

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

export interface LedgerResponse {
  walletId: string;
  items: LedgerItemResponse[];
  nextCursor: string | null;
}

export interface LedgerItemResponse {
  id: string;
  transactionId: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: { amount: string; currency: string };
  balanceBefore: { amount: string; currency: string };
  balanceAfter: { amount: string; currency: string };
  createdAt: string;
}

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWalletUseCase,
    private readonly queries: WalletQueries,
    private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() dto: CreateWalletDto): Promise<WalletResponse> {
    const wallet = await this.openWallet.execute({
      playerId: dto.playerId,
      initialBalance: Money.from(dto.initialBalance),
    });
    return toWalletResponse(wallet);
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<WalletResponse> {
    assertUuid(id);
    return toWalletResponse(await this.queries.getWallet(id));
  }

  @Get(':id/ledger')
  async ledger(@Param('id') id: string, @Query() query: ListLedgerQueryDto): Promise<LedgerResponse> {
    assertUuid(id);
    const page = await this.queries.listLedger({
      walletId: id,
      limit: parseLimit(query.limit),
      cursor: query.cursor,
    });
    return {
      walletId: id,
      items: page.items.map(toLedgerItem),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * POST /wallets/:walletId/reconciliation (§9) — relatório de consistência.
   * Nunca corrige silenciosamente: divergência → log + métrica + consistent: false.
   * Retorna 200 mesmo divergente.
   */
  @Post(':id/reconciliation')
  @HttpCode(200)
  async reconciliation(@Param('id') id: string): Promise<ReconciliationReport> {
    assertUuid(id);
    return this.reconcile.execute(id);
  }
}

function toWalletResponse(wallet: Wallet): WalletResponse {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

function toLedgerItem(entry: WalletLedgerEntry): LedgerItemResponse {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 50;
  const limit = Number.parseInt(raw, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ValidationError('limit must be an integer between 1 and 100');
  }
  return limit;
}

function assertUuid(value: string): void {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(value)) {
    throw new ValidationError(`wallet id must be a UUID, got: ${value}`);
  }
}
