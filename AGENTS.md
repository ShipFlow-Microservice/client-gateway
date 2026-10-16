# AGENTS.md

Client gateway for the ShipFlow microservices system (alongside `auth-ms`).

## Commands

| Task | Command |
|---|---|
| Dev server (watch) | `npm run start:dev` |
| Build | `npm run build` → `dist/` |
| Lint | `npm run lint` (oxlint, **not** eslint) |
| Format | `npm run format` (prettier) |
| Unit tests | `npm run test` (jest, `*.spec.ts`) |
| E2E tests | `npm run test:e2e` (separate config: `test/jest-e2e.json`) |

## Toolchain gotchas

- **oxlint**, not eslint. `@typescript-eslint/no-explicit-any` is intentionally **off**. `no-floating-promises` is warn-level.
- **Prettier**: single quotes, trailing commas (`.prettierrc`).
- **TypeScript 6** with `module: "nodenext"`. Relative imports must include `.js` extensions.
- **Jest** reads path aliases from `tsconfig.json` via `pathsToModuleNameMapper` — no separate jest-side mapping needed.
- Build uses `deleteOutDir: true`; `dist/` is fully regenerated on each build.

## Conventions

- `strict: true` but `strictPropertyInitialization: false` (NestJS constructor-injection pattern).
- `rootDir` is `src/` for builds; tests live in `test/` at repo root.
- Target `ES2023`, env `node`.

## Context7
Utiliza siempre context7 para verificar y aplicar las mejores practicas de Nest.

## Specs

Todos los specs del proyecto deben guardarse en la carpeta `specs/` en la raíz del repositorio.

- Formato: Markdown (`.md`)
- Nomenclatura: `nombre-descriptivo.md` (kebab-case)
- Los specs deben incluir: objetivo, arquitectura, implementación detallada, y checklist de tareas
- Estado inicial: **PENDING APPROVAL** hasta que el usuario revise y apruebe
- Los specs sirven como documentación viva del diseño y decisiones técnicas

