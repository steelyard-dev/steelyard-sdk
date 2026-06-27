import { PRODUCTS } from "./lib/products";

export default function Home() {
  return (
    <main style={{ fontFamily: "ui-sans-serif, system-ui", padding: 48, maxWidth: 720 }}>
      <h1 style={{ fontSize: 36 }}>Acme Coffee</h1>
      <p style={{ color: "#666", marginBottom: 32 }}>
        Espresso bar · agent-ready via Steelyard.
      </p>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {PRODUCTS.map((p) => (
          <li
            key={p.id}
            style={{ display: "flex", justifyContent: "space-between", padding: "16px 0", borderBottom: "1px solid #eee" }}
          >
            <span>{p.title}</span>
            <form action="/api/checkout" method="post">
              <input type="hidden" name="id" value={p.id} />
              <button type="submit" style={{ cursor: "pointer" }}>
                ${(p.amount / 100).toFixed(2)} →
              </button>
            </form>
          </li>
        ))}
      </ul>
      <p style={{ marginTop: 48, fontSize: 12, color: "#999" }}>
        Agents discover this shop at <code>/.well-known/commerce.json</code>.
        Dev inspector at <a href="/__steelyard">/__steelyard</a>.
      </p>
    </main>
  );
}
