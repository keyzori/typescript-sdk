# AGENTS.md

These instructions apply to the entire repository.

- Use Bun for dependency management and development commands. The published SDK targets Node.js, compiles to JavaScript, and supports ESM and CommonJS with matching declarations. Never require Bun in consumer applications. Run runtime and packaged-consumer tests under Node.
- Public HTTP types come from `@keyzori/types` in `../types`. Keep the contract centralized and verify it against the current server.
- Keep the public SDK surface and runtime validation synchronized with the Keyzori HTTP contract.
- Maintain SDK guides in the server's separate `../server/wiki` documentation repository. Keep this package README brief and link to the shared wiki; do not duplicate full guides here.
- Support ordinary hosts/VPSs, Docker, Pterodactyl, and Proxmox CT/VM deployments through portable persistent storage. Never assume the build host matches the runtime host or require Docker, root, or hypervisor APIs in consumer applications. Document cloning and storage-lifecycle limits.
- Run `bun run check` before handing off SDK changes.
- Run `bun run test:contract` against the sibling `../server` checkout when endpoint contracts change.
- Preserve unrelated changes and never commit secrets, license keys, credentials, customer data, or production logs.
- Use tabs and double quotes as configured by Biome.
