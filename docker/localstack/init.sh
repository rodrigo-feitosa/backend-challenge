#!/bin/bash
# Criação das filas SQS do desafio (seção 10 do README).
# Executado pelo LocalStack quando fica "ready" (init/ready.d).
set -euo pipefail

DLQ_URL=$(awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"true"}' \
  --query 'QueueUrl' --output text)

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{
    \"FifoQueue\": \"true\",
    \"ContentBasedDeduplication\": \"true\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":5}\",
    \"VisibilityTimeout\": 90
  }" >/dev/null

awslocal sqs create-queue \
  --queue-name wagering-events.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"true"}' >/dev/null

echo "[init.sh] filas criadas: wager-transactions.fifo (redrive -> $DLQ_ARN), wagering-events.fifo"
