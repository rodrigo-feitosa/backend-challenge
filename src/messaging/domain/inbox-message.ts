export interface ReceiveInboxProps {
  id: string;
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date | undefined;
}

/**
 * Mensagem da inbox (§6.5/§10) — deduplicação persistente por
 * (consumerName, messageId). A linha é inserida NA MESMA transação do
 * processamento, com markProcessed ainda dentro dela: "linha existe"
 * ⇒ "processada" (simplificação documentada — não há estado intermediário).
 * Se o processamento falhar e a transação rolar back, a linha some e a
 * redelivery reprocessa.
 */
export class InboxMessage {
  private constructor(
    public readonly id: string,
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(props.id, props.messageId, props.consumerName, props.payloadHash, props.receivedAt, undefined);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.id, state.messageId, state.consumerName, state.payloadHash, state.receivedAt, state.processedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this._processedAt !== undefined) {
      throw new Error(`inbox message ${this.messageId} is already processed`);
    }
    this._processedAt = at;
  }
}
