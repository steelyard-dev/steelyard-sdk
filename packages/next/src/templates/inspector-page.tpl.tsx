// Steelyard dev inspector — written by `steelyard init`.
// Lives at /steelyard, dev-only, owned by your repo (edit or delete freely).

import { resolveManifestModule } from "steelyard/next";
import manifestModule from "../../../commerce";

export const dynamic = "force-dynamic";

interface OfferRow {
  id: string;
  title: string;
  amount: number | null;
  currency: string | null;
  hasStripePriceId: boolean;
}

export default async function SteelyardInspector() {
  if (process.env.NODE_ENV === "production") {
    return <main style={{ padding: 32 }}>Not available in production.</main>;
  }

  const manifest = (await resolveManifestModule(manifestModule)) as unknown as {
    identity: { name: string; domain: string };
    catalog: {
      offers: Array<{
        id: string;
        title: string;
        pricing: Array<{ kind: string; amount?: number; currency?: string }>;
        psp?: { stripe?: { priceId?: string } };
      }>;
    };
  };

  const offers: OfferRow[] = manifest.catalog.offers.map((offer) => {
    const oneTime = offer.pricing.find((p) => p.kind === "one_time");
    return {
      id: offer.id,
      title: offer.title,
      amount: oneTime?.amount ?? null,
      currency: oneTime?.currency ?? null,
      hasStripePriceId: Boolean(offer.psp?.stripe?.priceId)
    };
  });

  return (
    <main style={{ fontFamily: "ui-sans-serif, system-ui", padding: 32, maxWidth: 960 }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Steelyard Inspector</h1>
      <p style={{ color: "#666", marginBottom: 24 }}>
        {manifest.identity.name} · {manifest.identity.domain}
      </p>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 18, marginBottom: 12 }}>Mounted surfaces</h2>
        <ul style={{ lineHeight: 1.8 }}>
          <li><a href="/.well-known/commerce.json">/.well-known/commerce.json</a></li>
          <li><a href="/mcp">/mcp</a></li>
          <li><a href="/acp/feed">/acp/feed</a></li>
          <li><a href="/.well-known/ucp">/.well-known/ucp</a></li>
        </ul>
      </section>

      <section>
        <h2 style={{ fontSize: 18, marginBottom: 12 }}>Offers ({offers.length})</h2>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
              <th style={{ padding: 8 }}>ID</th>
              <th style={{ padding: 8 }}>Title</th>
              <th style={{ padding: 8 }}>Price</th>
              <th style={{ padding: 8 }}>Stripe</th>
            </tr>
          </thead>
          <tbody>
            {offers.map((offer) => (
              <tr key={offer.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
                <td style={{ padding: 8, fontFamily: "ui-monospace, monospace" }}>{offer.id}</td>
                <td style={{ padding: 8 }}>{offer.title}</td>
                <td style={{ padding: 8 }}>
                  {offer.amount !== null
                    ? `${(offer.amount / 100).toFixed(2)} ${offer.currency}`
                    : "—"}
                </td>
                <td style={{ padding: 8 }}>{offer.hasStripePriceId ? "✓" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
