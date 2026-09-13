# @keyzori/sdk

Node.js SDK for Keyzori licensing, with compiled JavaScript and TypeScript declarations for ESM and CommonJS. Supports Node 18.18+ and TypeScript 5+; consumer applications do not need Bun.

```sh
npm install @keyzori/sdk
```

```js
import { LicenseClient } from "@keyzori/sdk";
// CommonJS: const { LicenseClient } = require("@keyzori/sdk");
```

The [SDK reference](https://github.com/keyzori/Keyzori/wiki/SDK-Reference) covers activation, metering, events, configuration, development, and releases. Shared HTTP types come from `@keyzori/types`.

Identity is stored in persistent application data on ordinary hosts, VPSs, containers, and VMs. Preserve it through replacement or migration; copied identity files remain copyable. See [device identity and hosting](https://github.com/keyzori/Keyzori/wiki/SDK-Device-Identity) and the reference's hosting examples.

SDK documentation is maintained alongside the server documentation in the [Keyzori wiki](https://github.com/keyzori/Keyzori/wiki). [Verification results](https://github.com/keyzori/Keyzori/wiki/SDK-Verification) distinguish local checks from untested deployments.
