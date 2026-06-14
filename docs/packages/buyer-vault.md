# Vault (engine)

`@steelyard/buyer/vault` stores billing identity, addresses, and payment cards
in an encrypted local vault.

```ts
import { BuyerVault, passwordKeystore } from "@steelyard/buyer/vault";

const vault = await BuyerVault.open({
  path: "~/.steelyard/vault.box",
  keystore: passwordKeystore({ password: process.env.STEELYARD_PASSWORD! })
});
```

The vault uses XSalsa20-Poly1305 via `@noble/ciphers`. Each vault has a stable
UUID in a plaintext header; that header is authenticated with the ciphertext.
The master key is stored in the OS keychain by default or derived from an
explicit password with Argon2id.

## Platform support

| Platform | osKeystore | passwordKeystore | Notes |
|----------|------------|------------------|-------|
| macOS 11+ | yes | yes | Touch ID prompts on first access per process |
| Ubuntu / Debian / Fedora desktop | yes, with libsecret and a keyring daemon | yes | |
| Alpine Linux | requires GLIBC compat for `@napi-rs/keyring` native | yes | passwordKeystore recommended |
| NixOS | Secret Service depends on home-manager | yes | |
| Docker containers | requires Secret Service inside | yes | passwordKeystore recommended |
| SSH-only sessions | no DBus session | yes | passwordKeystore required |
| GitHub Actions linux | see CI keychain setup | yes | both lanes tested |
| Windows 10+ | yes via Credential Vault | yes | not in the v0.2 CI gate |

## Linux runtime packages

```bash
# Debian / Ubuntu, only for osKeystore
sudo apt-get install -y libsecret-1-0 gnome-keyring

# Fedora
sudo dnf install -y libsecret gnome-keyring

# Arch
sudo pacman -S libsecret gnome-keyring

# Alpine, NixOS, Docker, SSH:
# Use passwordKeystore; no system deps required.
```

## Recovery

Use `exportRecovery({ path, password })` on Wallet or
`vault.exportKeyToFile({ path, recoveryPassword })` on the primitive. The file
contains the master key wrapped with a recovery password. Reinstall with:

```ts
await BuyerVault.importKeyFromFile({
  path: "~/.steelyard/recovery.enc",
  vaultPath: "~/.steelyard/vault.box",
  recoveryPassword: process.env.STEELYARD_RECOVERY_PASSWORD!
});
```

## Compliance note

This SDK is a local-first tool for individuals managing their own cards. It is
not a payment processor and is not in PCI DSS scope by itself. Business users
automating purchases may incur PCI obligations through merchant agreements;
consult counsel.
