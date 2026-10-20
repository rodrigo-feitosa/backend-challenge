import { IsNotEmpty, IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * DTO de dinheiro nos contratos — amount é string decimal (nunca number).
 * A validação fina (escala 2, limite de dígitos) é do domínio Money.from;
 * aqui garantimos a forma básica para rejeitar 400 antes do domínio.
 */
export class MoneyDto {
  @IsString()
  @Matches(/^\d{1,18}(\.\d{1,2})?$/, { message: 'amount must be a decimal string with up to 2 fraction digits' })
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO-4217 code (3 uppercase letters)' })
  currency!: string;
}

export class CreateWalletDto {
  /**
   * UUID em qualquer versão (1–8, incluindo v7 dos exemplos do desafio).
   * class-validator IsUUID não reconhece v7 — usamos regex própria.
   */
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, {
    message: 'playerId must be a UUID',
  })
  playerId!: string;

  @IsNotEmpty()
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}

export class ListLedgerQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Matches(/^\d+$/, { message: 'limit must be a positive integer' })
  limit?: string;
}
