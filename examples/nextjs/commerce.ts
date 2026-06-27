import { defineCommerce } from "steelyard";

export default defineCommerce({
  identity: { name: "Acme Coffee", domain: "acme.coffee", currencies: ["USD"] },
  offers: [
    {
      id: "single",
      title: "Single Espresso",
      description: "A focused single shot of espresso.",
      availability: "in_stock",
      pricing: [{ kind: "one_time", amount: 300, currency: "USD" }]
    },
    {
      id: "double",
      title: "Double Espresso",
      description: "Two espresso shots served short.",
      availability: "in_stock",
      pricing: [{ kind: "one_time", amount: 450, currency: "USD" }]
    },
    {
      id: "cappuccino",
      title: "Cappuccino",
      description: "Espresso with steamed milk and foam.",
      availability: "in_stock",
      pricing: [{ kind: "one_time", amount: 500, currency: "USD" }]
    }
  ]
});
