import { createHash } from 'node:crypto';
import type { MoneyProps } from '../../shared/domain/money';

/**
 * Algoritmo do payloadHash (seção 9 do desafio / ADR-004 do plano):
 * SHA-256 sobre JSON canônico — chaves ordenadas lexicograficamente,
 * recursivo — do SUBCONJUNTO de negócio. O header Idempotency-Key e
 * metadados de transporte ficam FORA do hash.
 */

export interface WagerPayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
}

/** Serialização estável: chaves ordenadas, recursiva, sem espaços. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalPayloadHash(fields: WagerPayloadFields): string {
  return createHash('sha256').update(stableStringify(fields), 'utf8').digest('hex');
}
