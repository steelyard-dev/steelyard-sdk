export const VAULT_KEY_SERVICE = "dev.steelyard.vault";

export interface Keystore {
  getMasterKey(service: string, account: string): Promise<Uint8Array | null>;
  setMasterKey(service: string, account: string, key: Uint8Array): Promise<void>;
  deleteMasterKey(service: string, account: string): Promise<void>;
}

export function memoryKeystore(): Keystore {
  const keys = new Map<string, Uint8Array>();
  const scoped = (service: string, account: string) => `${service}\0${account}`;

  return {
    async getMasterKey(service, account) {
      const key = keys.get(scoped(service, account));
      return key ? new Uint8Array(key) : null;
    },
    async setMasterKey(service, account, key) {
      keys.set(scoped(service, account), new Uint8Array(key));
    },
    async deleteMasterKey(service, account) {
      keys.delete(scoped(service, account));
    }
  };
}
