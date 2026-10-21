/**
 * Invariante final exigida em TODO teste (seção 13 do desafio):
 *   wallet.balance == saldo reconstruído pelo ledger
 */

export interface LedgerEntryLike {
  direction: 'DEBIT' | 'CREDIT';
  amount: { amount: string };
}

export function ledgerSumCents(entries: LedgerEntryLike[]): bigint {
  let cents = 0n;
  for (const entry of entries) {
    const [int, frac = ''] = entry.amount.amount.split('.');
    const value = BigInt(int + frac.padEnd(2, '0'));
    cents += entry.direction === 'CREDIT' ? value : -value;
  }
  return cents;
}

export function moneyToCents(amount: string): bigint {
  const [int, frac = ''] = amount.split('.');
  return BigInt(int + frac.padEnd(2, '0'));
}

export function centsToMoney(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const body = `${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
  return negative ? `-${body}` : body;
}

/**
 * Busca saldo e ledger (paginando) e verifica a invariante.
 * Lança com mensagem detalhada em caso de divergência.
 */
export async function assertWalletLedgerInvariant(
  baseUrl: string,
  walletId: string,
  context = '',
): Promise<{ balance: string; ledgerSum: string; entries: number }> {
  const walletRes = await fetch(`${baseUrl}/wallets/${walletId}`);
  if (!walletRes.ok) throw new Error(`wallet ${walletId} not found for invariant check`);
  const wallet = (await walletRes.json()) as { balance: { amount: string } };

  const entries: LedgerEntryLike[] = [];
  let cursor: string | null = null;
  do {
    const url = `${baseUrl}/wallets/${walletId}/ledger?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page = (await (await fetch(url)).json()) as { items: LedgerEntryLike[]; nextCursor: string | null };
    entries.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);

  const balance = moneyToCents(wallet.balance.amount);
  const ledgerSum = ledgerSumCents(entries);
  if (balance !== ledgerSum) {
    throw new Error(
      `INVARIANT VIOLATED${context ? ` (${context})` : ''}: wallet ${walletId} balance ${wallet.balance.amount} != ledger sum ${centsToMoney(ledgerSum)} (${entries.length} entries)`,
    );
  }
  return { balance: wallet.balance.amount, ledgerSum: centsToMoney(ledgerSum), entries: entries.length };
}
