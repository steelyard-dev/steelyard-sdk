export const PRODUCTS = [
  { id: "single", title: "Single Espresso", amount: 300, currency: "USD" },
  { id: "double", title: "Double Espresso", amount: 450, currency: "USD" },
  { id: "cappuccino", title: "Cappuccino", amount: 500, currency: "USD" }
] as const;

export type Product = (typeof PRODUCTS)[number];
