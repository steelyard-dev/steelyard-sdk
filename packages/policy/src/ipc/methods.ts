export type JsonRpcId = string | number | null;

export type RpcParams = Record<string, unknown>;

export type RpcMethod = (params: RpcParams) => Promise<unknown> | unknown;

export type RpcMethodName =
  | "proposeIntent"
  | "getApprovalStatus"
  | "cancelIntent"
  | "revokeCredential"
  | "ackSettlement"
  | "getPolicySnapshot"
  | "capabilities";

export interface RpcHandlers {
  proposeIntent?: RpcMethod;
  getApprovalStatus?: RpcMethod;
  cancelIntent?: RpcMethod;
  revokeCredential?: RpcMethod;
  ackSettlement?: RpcMethod;
  getPolicySnapshot?: RpcMethod;
  capabilities?: RpcMethod;
}

const RPC_METHOD_NAMES = new Set<RpcMethodName>([
  "proposeIntent",
  "getApprovalStatus",
  "cancelIntent",
  "revokeCredential",
  "ackSettlement",
  "getPolicySnapshot",
  "capabilities"
]);

export function isRpcMethodName(value: string): value is RpcMethodName {
  return RPC_METHOD_NAMES.has(value as RpcMethodName);
}
