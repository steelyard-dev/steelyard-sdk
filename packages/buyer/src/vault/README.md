# `@steelyard/buyer/vault`

Local-first encrypted vault for billing identity, addresses, payment card
metadata, and raw PANs. This subpath is exported for power users; the primary
developer path is the root `Wallet` facade.

The vault stores data in `vault.box`, encrypted with XSalsa20-Poly1305 from
`@noble/ciphers`. Each vault has a stable UUID in its plaintext header, and
that header is authenticated as associated data when the encrypted record is
opened. The master key is stored in the OS keychain by default, or derived with
Argon2id when the caller explicitly supplies `passwordKeystore({ password })`.

```ts
import { BuyerVault, passwordKeystore } from "@steelyard/buyer/vault";

const vault = await BuyerVault.open({
  path: "~/.steelyard/vault.box",
  keystore: passwordKeystore({ password: process.env.STEELYARD_PASSWORD! })
});
```

## Keystore options

- `osKeystore()` uses `@napi-rs/keyring` for macOS Keychain, Linux Secret
  Service, or Windows Credential Vault. It is the default.
- `passwordKeystore({ password })` derives the master key from the password and
  the vault header KDF parameters. Use it for headless Linux, Docker, SSH-only
  sessions, Alpine, NixOS without Secret Service, and CI password lanes.
- `memoryKeystore()` and `memoryBoxStore()` are for tests only.

The vault never silently falls back from OS keychain to password mode. If the OS
keychain is unreachable, open/init throws with a message that tells the caller
to pass an explicit password keystore.

## Card exposure

`listCards()` and `pickCard()` return metadata only: brand, last4, exp, name,
and tags. The only path to a raw PAN is `revealCard(id)`. Raw card objects
redact `pan` in `toJSON()` and Node's inspector, but callers should still avoid
logging them.

## Recovery

Call `exportKeyToFile({ path, recoveryPassword })` once after setup and store
the recovery file plus password separately, for example in a password manager
or encrypted backup.

```ts
await vault.exportKeyToFile({
  path: "~/.steelyard/recovery.enc",
  recoveryPassword: process.env.STEELYARD_RECOVERY_PASSWORD!
});

await BuyerVault.importKeyFromFile({
  path: "~/.steelyard/recovery.enc",
  vaultPath: "~/.steelyard/vault.box",
  recoveryPassword: process.env.STEELYARD_RECOVERY_PASSWORD!
});
```

`exportKey_UNSAFE()` exists only as an escape hatch. It returns the raw master
key as a base64 string and can leak through REPL history, logs, or terminal
scrollback.
