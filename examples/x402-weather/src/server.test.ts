import { afterEach, describe, expect, it } from "vitest";
import { parsePaymentRequiredHeader } from "@steelyard/x402";
import { startWeatherServer } from "./server.js";

const servers: Array<{ close: (cb: (error?: Error) => void) => void }> = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => error ? reject(error) : resolve());
  })));
  servers.length = 0;
});

describe("x402 weather server", () => {
  it("returns a PAYMENT-REQUIRED challenge for the paid weather route", async () => {
    const { server, url } = await startWeatherServer();
    servers.push(server);

    const response = await fetch(`${url}/weather`);

    expect(response.status).toBe(402);
    const challenge = parsePaymentRequiredHeader(response.headers);
    expect(challenge.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "eip155:84532",
      asset: "USDC",
      maxAmountRequired: "1000"
    });
  });
});
