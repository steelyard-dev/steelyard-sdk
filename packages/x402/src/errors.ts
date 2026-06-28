export class X402Error extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class X402PaymentRequiredParseError extends X402Error {}
export class X402NoSupportedRequirement extends X402Error {}
export class X402PaymentNotAllowed extends X402Error {}
export class X402SignerUnavailable extends X402Error {}
export class X402PaymentRetryFailed extends X402Error {}
export class X402SettlementMissing extends X402Error {}
export class X402SettlementAmbiguous extends X402Error {
  constructor(
    message: string,
    readonly recovery: { idempotencyKey: string; requirementHash: string }
  ) {
    super(message);
  }
}
