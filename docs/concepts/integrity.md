# Integrity

The v0.4 commerce manifest includes `content_hash`:

```json
{
  "content_hash": "sha256:..."
}
```

This is an integrity checksum. It helps a consumer detect that the manifest
fields they parsed do not match the canonical document body.

It is not an authenticity proof.

## How it is computed

`canonicalCommerceManifestHash(doc)`:

1. Removes `content_hash` from the document.
2. Canonicalizes the remaining JSON with RFC 8785 JSON Canonicalization Scheme.
3. Prefixes the canonical bytes with the domain tag `CommerceManifest:v0.1:`.
4. Computes SHA-256 and returns `sha256:<hex>`.

The domain tag keeps this digest scoped to Steelyard commerce manifests instead
of being a generic hash over arbitrary JSON.

## What it proves

It proves only that:

- the manifest can be canonicalized;
- the checksum matches the fields in the document;
- no field was accidentally changed after the hash was produced.

It does not prove:

- who generated the manifest;
- that the manifest came from the claimed merchant;
- that peer URLs are trusted;
- that the transport was not intercepted.

## Authenticity

Use HTTPS for transport authenticity. If you need signed offline manifests,
layer your own signature over the full `commerce.json` document or publish the
hash in a transparency log you control.

Steelyard does not treat `content_hash` as a signature, key id, certificate
chain, or trust decision.
