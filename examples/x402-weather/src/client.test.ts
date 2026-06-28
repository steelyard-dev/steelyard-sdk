import { afterEach, describe, expect, it } from "vitest";
import { createPaidWeatherFetch } from "./client.js";
import { startWeatherServer } from "./server.js";

const servers: Array<{ close: (cb: (error?: Error) => void) => void }> = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => error ? reject(error) : resolve());
  })));
  servers.length = 0;
});

describe("x402 weather client", () => {
  it("pays the offline server and exposes the x402 receipt", async () => {
    const { server, url } = await startWeatherServer();
    servers.push(server);

    const paidFetch = createPaidWeatherFetch();
    const response = await paidFetch(`${url}/weather`);

    await expect(response.json()).resolves.toEqual({ city: "London", condition: "sunny", paid: true });
    expect(response.x402?.receipt).toMatchObject({
      network: "eip155:84532",
      transaction: "mock_1"
    });
  });
});
