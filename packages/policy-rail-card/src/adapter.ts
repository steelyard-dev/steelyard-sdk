import type { PolicyRailAdapter, RailCapabilities, RailEnvironment, SettlementEvent } from "@steelyard-dev/policy";
import { mintCard, type MintArgs } from "./mint.js";
import { WebhookEventBus } from "./observe.js";
import { revokeCard } from "./revoke.js";

export interface VirtualCardPolicyRailAdapterOptions {
  stripe: MintArgs["stripe"];
  cardholderId: string;
  env: RailEnvironment;
  webhookBus: WebhookEventBus;
}

export class VirtualCardPolicyRailAdapter implements PolicyRailAdapter {
  readonly name = "virtual_card";
  readonly enforcement_level = "network_enforced";
  readonly loss_ceiling_source = "per_credential";
  readonly caveats = [
    "amount + expiry hard; MCC soft (issuer-honored, merchant-categorized); MID best-effort (depends on aggregator routing and descriptor)."
  ];
  readonly env: RailEnvironment;

  constructor(private readonly opts: VirtualCardPolicyRailAdapterOptions) {
    this.env = opts.env;
  }

  capabilities(): RailCapabilities {
    return { rails_supported: ["virtual_card"], availability_signal_source: "stripe_issuing" };
  }

  async mint(args: Parameters<PolicyRailAdapter["mint"]>[0]) {
    return mintCard({
      stripe: this.opts.stripe,
      cardholderId: this.opts.cardholderId,
      authorization_hash: args.authorization_hash,
      constraints: args.constraints
    });
  }

  async *observe(credential_id: string): AsyncIterable<SettlementEvent> {
    for (const event of this.opts.webhookBus.eventsFor(credential_id)) yield event;
  }

  async revoke(credential_id: string): Promise<void> {
    await revokeCard(this.opts.stripe, credential_id);
  }

  async ackSettlement(_credential_id: string, _event_id: string): Promise<void> {
    // Stripe webhooks are at-least-once; ingestion dedupes by event id.
  }
}

export function virtualCardRail(opts: VirtualCardPolicyRailAdapterOptions): VirtualCardPolicyRailAdapter {
  return new VirtualCardPolicyRailAdapter(opts);
}
