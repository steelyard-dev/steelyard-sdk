import { defineCommerce } from "@steelyard/core";

export const coffeeShopManifest = defineCommerce({
  identity: { name: "Steelyard Coffee" },
  offers: [
    {
      id: "single",
      title: "Single Espresso",
      description: "A focused single shot of espresso.",
      url: "https://coffee.example/single",
      availability: "in_stock",
      pricing: [{ kind: "one_time", amount: 300, currency: "USD" }]
    },
    {
      id: "double",
      title: "Double Espresso",
      description: "Two espresso shots served short.",
      url: "https://coffee.example/double",
      availability: "in_stock",
      pricing: [{ kind: "one_time", amount: 450, currency: "USD" }]
    },
    {
      id: "cappuccino",
      title: "Cappuccino",
      description: "Espresso with steamed milk and foam.",
      url: "https://coffee.example/cappuccino",
      availability: "in_stock",
      pricing: [{ kind: "one_time", amount: 500, currency: "USD" }]
    }
  ]
});
