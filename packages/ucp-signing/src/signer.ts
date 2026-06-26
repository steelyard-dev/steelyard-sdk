import type { EcJwk, HmsAlgorithm } from "@steelyard/core";

export interface UcpSigner {
  sign(data: Uint8Array, alg: HmsAlgorithm): Promise<Uint8Array>;
  publicJwk(): Promise<EcJwk>;
}
