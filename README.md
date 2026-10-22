# Distributed Wagering Processor

Serviço de processamento de transações de apostas (wallets, ledger imutável, idempotência persistente, mensageria at-least-once). Implementa o desafio técnico descrito em `../README.md` (enunciado), com plano em `../PLANEJAMENTO.md` e decisões em [`ARCHITECTURE.md`](./ARCHITECTURE.md).

- **Runtime:** Bun 1.x · **Framework:** NestJS · **ORM:** Mikro 6 · **Banco:** PostgreSQL 16
- **Mensageria:** SQS (LocalStack em desenvolvimento/testes) · **Linguagem:** TypeScript estrito

## Requisitos

- [Bun](https://bun.sh) 1.x
- Docker (com Compose)

## Subir o ambiente

```bash
bun install
docker compose up -d          # postgres, localstack (SQS), keycloak, app
```

O serviço sobe em `http://localhost:3000` com migrations aplicadas automaticamente (`MIGRATIONS_ON_START=true` por padrão no Compose).

Verificação rápida:

```bash
curl -s localhost:3000/health/live
curl -s localhost:3000/health/ready
```

## Configuração (variáveis de ambiente)

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | porta HTTP |
| `DATABASE_URL` | — | conexão PostgreSQL |
| `LOG_LEVEL` | `info` | nível de log (pino, JSON) |
| `MIGRATIONS_ON_START` | `true` | aplica migrations no boot |
| `CONSUMER_ENABLED` | `true` | liga/desliga o consumer SQS |
| `WORKERS_ENABLED` | `true` | liga/desliga os workers (outbox publisher, pending-reference) |
| `SQS_ENDPOINT` | — | endpoint SQS (LocalStack) |
| `SQS_QUEUE_TRANSACTIONS_URL` | — | fila de transações |
| `SQS_QUEUE_DL_URL` | — | DLQ |
| `SQS_QUEUE_EVENTS_URL` | — | fila de eventos de saída |
| `VISIBILITY_TIMEOUT_S` | `90` | visibility timeout do consumer |
| `CONSUMER_WAIT_TIME_S` | `20` | long polling |
| `DLQ_MAX_RECEIVES` | `3` | recebimentos antes de enviar à DLQ |
| `OUTBOX_POLL_INTERVAL_MS` | `1000` | intervalo do publisher |
| `OUTBOX_BATCH_SIZE` | `50` | lote do publisher |
| `OUTBOX_MAX_ATTEMPTS` | `20` | tentativas antes de DEAD |
| `PENDING_REF_POLL_INTERVAL_MS` | `5000` | intervalo do worker de pending-reference |
| `PENDING_REF_BASE_DELAY_MS` | `5000` | atraso base do backoff |
| `PENDING_REF_MAX_ATTEMPTS` | `10` | tentativas antes de rejeitar |
| `PENDING_REF_TTL_HOURS` | `24` | TTL antes de rejeitar |

## Comandos

```bash
bun run start                 # produção (bun)
bun run start:dev             # dev
bun run test:unit             # testes unitários (sem Docker)
bun run test:integration      # integração (sobe Postgres/LocalStack reais)
bun run test:concurrency      # concorrência (processos reais da aplicação)
bun run test                  # tudo
bun run migration:up          # aplica migrations
bun run migration:down        # reverte migrations
bun run lint
```

> **Nota:** os testes de integração/concorrência criam e destroem seus próprios containers via CLI do Docker (o Testcontainers quebra o Bun — ver ARCHITECTURE.md). Se sua sessão não pertence ao grupo `docker`, rode com `sg docker -c "bun run test:integration"`.

## Exemplo end-to-end (curl)

```bash
# 1. criar wallet com saldo inicial
curl -s -X POST localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"01920000-0000-7000-8000-000000000001","initialBalance":{"amount":"100.00","currency":"BRL"}}'
# => 201 {"id":"<walletId>","balance":{"amount":"100.00",...},...}

# 2. apostar (BET) — idempotency-key explícita
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'idempotency-key: provider-a:bet-001' \
  -d '{
        "providerId":"provider-a",
        "externalTransactionId":"bet-001",
        "playerId":"01920000-0000-7000-8000-000000000001",
        "walletId":"<walletId>",
        "roundId":"round-1",
        "gameId":"fortune-chimp",
        "kind":"BET",
        "money":{"amount":"10.00","currency":"BRL"}
      }'
# => 200 {"status":"PROCESSED",...} — reenvio com a mesma key devolve a mesma resposta (replay)

# 3. ganho (WIN) referenciando a aposta
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'idempotency-key: provider-a:win-001' \
  -d '{"providerId":"provider-a","externalTransactionId":"win-001","playerId":"...","walletId":"<walletId>","roundId":"round-1","gameId":"fortune-chimp","kind":"WIN","money":{"amount":"25.00","currency":"BRL"},"referenceExternalTransactionId":"bet-001"}'

# 4. consultar transação por id interno / por (provider, externalTransactionId)
curl -s localhost:3000/wagering/transactions/<transactionId>
curl -s localhost:3000/providers/provider-a/wagering/transactions/bet-001

# 5. ledger da wallet (paginação por cursor)
curl -s "localhost:3000/wallets/<walletId>/ledger?limit=20"

# 6. reconciliação (relatório; divergência NÃO é corrigida)
curl -s -X POST localhost:3000/wallets/<walletId>/reconciliation

# 7. health e métricas
curl -s localhost:3000/health/ready
curl -s localhost:3000/metrics | head
```

## Fluxo de mensagens (SQS)

- Entrada: fila `wager-transactions.fifo` — envelope `{"messageId","type":"WagerTransactionRequested","data":{...}}` com os mesmos campos do POST (o consumer usa **o mesmo use case** do HTTP; deduplicação por inbox persistente).
- Saída: fila `wagering-events.fifo` — eventos `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged` (transactional outbox; publicados **após** o commit).
- Erros: transitórios voltam para a fila (sem ack); permanentes/esgotados vão para a DLQ.

## Documentação

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — decisões (ADRs), máquina de estados, payloadHash, taxonomia de falhas, interpretações, limitações.
- `../PLANEJAMENTO.md` — plano completo com matriz de rastreabilidade.
```
