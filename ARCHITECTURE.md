# Arquitetura — Distributed Wagering Processor

Documento de decisões e rastreabilidade. Complementa o `README.md` (setup/operação) e deriva do plano em `PLANEJAMENTO.md` (ADRs, matriz §12–15).

---

## 1. Visão geral

Monólito modular por bounded context, cada módulo em quatro camadas:

```
src/
  shared/        # Money, erros, ports (Clock, IdGenerator), DB, logging, metrics, filtro de exceções
  wallets/       # domain (Wallet, WalletLedgerEntry) / application (OpenWallet, ReconcileWallet, queries)
                 # / infrastructure (MikroORM) / presentation (controller, DTOs)
  wagering/      # domain (WagerTransaction, FailureCode) / application (SubmitWagerTransaction — o ÚNICO
                 #   use case de submissão, compartilhado por HTTP e SQS; TransactionQueries; worker
                 #   de pending-reference) / infrastructure / presentation
  messaging/     # domain (InboxMessage, OutboxMessage, 4 IntegrationEvents)
                 # / application (consume handler, outbox-publisher worker)
                 # / infrastructure (SQS consumer, SQS publisher, repositórios inbox/outbox)
  health/        # /health/live, /health/ready (Terminus: PG + SQS)
migrations/      # MikroORM versionadas com down()
```

Regras de negócio só existem no domínio; controller HTTP e consumer SQS são adaptadores finos sobre o **mesmo** use case; toda dependência externa (relógio, IDs, SQS) entra por porta.

---

## 2. Decisões de arquitetura (ADRs)

### ADR-001 — ORM: Mikro 6 com EntityManager transacional

**Decisão:** MikroORM 6.x, entidades mapeadas à mão (`EntitySchema`, sem decorators no domínio), `em.fork().transactional()` **por execução**.

**Implementação e desvios:**
- Um `EntityManager` compartilhado não suporta transações concorrentes — cada execução do use case faz `fork()`; testes de concorrência provaram o problema.
- Configuração exposta como **função** (`getMikroOrmConfig()`), não constante: a config precisa ser avaliada após o `DATABASE_URL` de teste existir (bug real: avaliação no import conectava no banco errado silenciosamente).
- Repositórios expostos por módulo global (`RepositoriesModule`) com tokens (`WALLET_REPOSITORY`, etc.) para evitar dependência circular entre módulos de contexto.

**Trade-off:** mais boilerplate de mapeamento que decorators/TypeORM, aceito pelo controle transacional explícito.

### ADR-002 — Dinheiro: `Decimal` no domínio, `bigint` centavos no banco

**Decisão:** `Money` encapsula `Decimal` (decimal.js, escala 2 validada no domínio); colunas `*_cents BIGINT` + `currency CHAR(3)`; conversão via string/BigInt — exata nas duas direções. `number` banido por ESLint nos módulos de domínio e `Money` nunca expõe `number`.

**Por que bigint e não `NUMERIC(18,2)`:** exatidão estrutural (o driver pg devolve `bigint` como string); a escala 2 é convenção do mapper + CHECK de integralidade, e o banco nunca arredonda silenciosamente.

### ADR-003 / ADR-003 — Concorrência: lock pessimista por wallet + CAS

**Decisão:** duas barreiras dentro da unidade `walletId`:
1. `SELECT ... FOR UPDATE` na linha da wallet (`LockMode.PESSIMISTIC_WRITE`) no início da transação financeira;
2. `UPDATE ... WHERE id = ? AND balance_cents = <valor esperado>` (CAS) como segunda linha de defesa + `CHECK (balance_cents >= 0)` no schema.

**Observações de implementação:**
- O lock é **por linha**: wallets distintas nunca se bloqueiam (C3/C4 medem isso); hot wallet serializa por natureza — correção > throughput (ver §6 Limitações).
- O CAS usa o `balanceBefore` da entrada do ledger como valor esperado. Conflito de CAS incrementa `lock_conflicts_total`; espera de lock é medida em `lock_wait_seconds` (seção 12).

### ADR-004 — Idempotência: índice único no banco + inbox persistente

**Decisão:** duas chaves, dois mecanismos, **nenhum estado em memória**:

| Canal | Mecanismo | Chave |
|---|---|---|
| Ambos (fonte da verdade) | `UNIQUE (provider_id, idempotency_key)` em `wager_transactions` | header `Idempotency-Key` (default `{providerId}:{externalTransactionId}`) |
| SQS | `UNIQUE (consumer_name, message_id)` em `inbox_messages` | `messageId` do envelope |

- Corrida de inserts concorrentes da mesma key: a segunda bloqueia no índice até a primeira commitar; em conflito, catch de `unique violation` → re-leitura e classificação (replay × payload divergente).
- Replay devolve o **resultado original** incluindo o saldo da época (regra 7.7): a transação persiste snapshot de saldo; o replay lê o snapshot, não o saldo atual. A leitura usa a **conexão transacional** (um fork extra aqui causou deadlock de pool sob carga).
- Mesma key com payload diferente → `IDEMPOTENCY_CONFLICT` (HTTP 409), nunca replay.

### ADR-005 — Transactional Outbox com worker `SKIP LOCKED`

**Decisão:** tabela `outbox_messages` escrita na **mesma transação SQL** da mudança financeira; publisher em polling em TODAS as instâncias: claim `FOR UPDATE SKIP LOCKED` → publish no SQS → marca `PUBLISHED` na mesma transação do claim.

- Falha de publicação → rollback + `scheduleRetry` (backoff exponencial 2^n, teto) em transação própria; após `OUTBOX_MAX_ATTEMPTS` → `DEAD` (nunca apagada, auditável) + métrica `outbox_dead_total`.
- Crash entre publish e marcação → republicação: segura porque o consumidor deduplica por `eventId` (at-least-once declarado).
- Métrica `outbox_lag_seconds` = idade da mensagem PENDING mais antiga (seção 12).

### ADR-006 — SQS: FIFO como otimização, banco como garantia

**Decisão:** três filas FIFO (transações, DLQ com redrive, eventos). `MessageGroupId = walletId` alinha o broker à unidade de concorrência; **as garantias vivem no banco** (índices únicos, inbox, lock por wallet) — a fila pode repetir/reordenar sem corromper estado (C7 entrega ROLLBACK antes da BET de propósito).

- Ack (delete) **somente após o commit**; erros transitórios → sem ack (redelivery por visibility timeout) até `DLQ_MAX_RECEIVES`; permanentes → DLQ + ack. SIGTERM: para o polling e espera in-flight até 30s (conclui e acka) ou deixa voltar.

---

## 3. Máquina de estados da transação

```
                 ┌────────────────────────────────────────────┐
                 │              PENDING (transitório)         │
                 │  criada no INSERT da submissão             │
                 └───────┬──────────────┬─────────────────────┘
        regra de negócio │              │ aplicação ok (BET/WIN/LOSS/REFUND/ROLLBACK)
        falha            ▼              ▼
                 ┌────────────┐   ┌─────────────┐
                 │  REJECTED  │   │  PROCESSED  │ (terminal)
                 │ (terminal) │   └─────────────┘
                 └────────────┘
                 PENDING ── referência ausente/não-processada (regra 7.8) ──▶ PENDING_REFERENCE
                 PENDING_REFERENCE ── worker resolve ──▶ PROCESSED
                                    └─ worker esgota tentativas/TTL ──▶ REJECTED (REFERENCE_NOT_FOUND)
```

- `PENDING` nunca é observável de fora: insert + aplicação são **atômicos** (uma transação SQL). Único estado intermediário visível é `PENDING_REFERENCE` (intencional, com 202).
- `REJECTED` persiste `failureCode` + evento; não toca wallet/ledger (regra 7.6).
- Reenvio de `REFUND`/`ROLLBACK` sobre referência já revertida → `REJECTED` com `REFERENCE_ALREADY_REVERTED` (determinístico no replay).

## 4. Algoritmo do payloadHash

```
canonicalPayloadHash({
  providerId, externalTransactionId, playerId, walletId,
  roundId, gameId, kind, money: { amount, currency }
}) = SHA-256( canonicalJson(...) )
```

- `canonicalJson`: serialização com **chaves ordenadas lexicograficamente, recursiva** (estável entre processos/execuções).
- Entrada: apenas o **subconjunto de negócio** acima — header `Idempotency-Key` e metadados de transporte ficam de fora.
- Persistido em `wager_transactions.payload_hash`; comparado byte a byte no conflito de idempotência.
```

The file has been updated successfully. Here is the current state of the file:
</content>
