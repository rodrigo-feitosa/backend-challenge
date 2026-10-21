import { IsIn, IsNotEmpty, IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { MoneyDto } from '../../../wallets/presentation/dto/wallet.dto';

/**
 * Payload de submissão (§9). `referenceExternalTransactionId` é obrigatório
 * para REFUND/ROLLBACK e opcional para WIN (validação fina no domínio e no
 * use case — aqui validamos apenas a forma).
 */
export class SubmitTransactionDto {
  @IsString()
  @IsNotEmpty()
  providerId!: string;

  @IsString()
  @IsNotEmpty()
  externalTransactionId!: string;

  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, { message: 'playerId must be a UUID' })
  playerId!: string;

  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, { message: 'walletId must be a UUID' })
  walletId!: string;

  @IsString()
  @IsNotEmpty()
  roundId!: string;

  @IsString()
  @IsNotEmpty()
  gameId!: string;

  /** OPEN é interno — nunca submissível (§6.3), rejeitado com 400 aqui e no domínio. */
  @IsIn(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'])
  kind!: string;

  @IsNotEmpty()
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  referenceExternalTransactionId?: string;
}
