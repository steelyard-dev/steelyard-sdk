import { pathToFileURL } from "node:url";
import { createCoffeeShopServer } from "./server.js";

export { coffeeShopManifest } from "./catalog.js";
export {
  startCoffeeShopCheckoutServer,
  startMockDelegatePaymentServer
} from "./checkout-server.js";
export { createCoffeeShopHandler, createCoffeeShopServer } from "./server.js";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT ?? 3000);
  const server = createCoffeeShopServer();
  server.listen(port, () => {
    console.log(`Steelyard coffee shop listening on http://127.0.0.1:${port}`);
  });
}
