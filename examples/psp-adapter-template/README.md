# Steelyard PSP Adapter Template

This example is shaped like a standalone third-party adapter repository. Its
runtime dependency is only `steelyard/psp`.

```sh
pnpm install
pnpm test
```

Replace the toy token format in `src/index.ts` with your PSP's token minting and
capture calls, then keep the conformance test as part of your CI.
