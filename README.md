# ShipFlow — Client Gateway

API Gateway HTTP (REST) del sistema ShipFlow. Expone endpoints de autenticación y de gestión de envíos a los clientes, y los delega a los microservicios `auth-ms` y `shipments-ms` a través de NATS.

## Arquitectura

```
┌─────────────────┐         NATS          ┌─────────────────┐
│ client-gateway  │ ─────────────────────→ │    auth-ms       │
│  (HTTP REST)    │                        │   (NATS micro)   │
│                 │ ←───────────────────── │                  │
│                 │                        └─────────────────┘
│                 │         NATS          ┌─────────────────┐
│                 │ ─────────────────────→ │   shipments-ms   │
│                 │ ←───────────────────── │ (NATS + Prisma)  │
└─────────────────┘                        └─────────────────┘
      ↓
  Endpoints REST
  /auth/* · /shipments/*
```

El gateway es **stateless**: no accede a la base de datos ni genera JWT; todo lo delega a `auth-ms` y `shipments-ms`. Ambos microservicios comparten el mismo servidor NATS (`NATS_URL`).

## Prerequisitos

1. NATS y PostgreSQL de auth-ms:

   ```bash
   docker-compose up -d   # en el directorio de auth-ms (incluye NATS en localhost:4222)
   ```

2. PostgreSQL de shipments-ms (puerto `5434`):

   ```bash
   docker-compose up -d   # en el directorio de shipments-ms
   ```

3. `auth-ms` y `shipments-ms` corriendo (`npm run start:dev` en cada directorio).

## Instalación

```bash
$ npm install
```

## Variables de entorno

Copia `.env.example` a `.env` y ajusta los valores:

| Variable  | Descripción                | Default                |
| --------- | -------------------------- | ---------------------- |
| `NATS_URL` | URL del servidor NATS      | `nats://localhost:4222` |
| `PORT`     | Puerto HTTP del gateway    | `3000`                 |

## Ejecución

```bash
# desarrollo (watch)
$ npm run start:dev

# producción
$ npm run start:prod
```

## Endpoints

### Autenticación (`auth-ms`)

| Método | Ruta                     | Descripción      | Request Body / Query   | Response                                            |
| ------ | ------------------------ | ---------------- | ---------------------- | --------------------------------------------------- |
| POST   | `/auth/register`         | Registrar usuario | `{ email, password, name? }` | `{ id, email, name, roles, isActive, createdAt }` |
| POST   | `/auth/login`            | Autenticar        | `{ email, password }`  | `{ access_token, user }`                            |
| GET    | `/auth/profile?userId=`  | Obtener perfil    | Query: `userId`        | `{ id, email, name, roles, isActive, createdAt }`   |

### Envíos (`shipments-ms`)

| Método | Ruta                                | Descripción                        | Request Body / Query                                             | Response                        |
| ------ | ----------------------------------- | ---------------------------------- | ---------------------------------------------------------------- | ------------------------------- |
| POST   | `/shipments`                        | Crear envío                        | `{ senderId, receiverName, receiverEmail, origin, destination, notes? }` | 201 `Shipment`       |
| GET    | `/shipments`                        | Listar envíos (paginado)           | Query: `page`, `limit`, `status`                                 | 200 `{ items, total, page, limit }` |
| GET    | `/shipments/tracking/:trackingCode` | Buscar por código de seguimiento   | —                                                                | 200 `Shipment`                  |
| GET    | `/shipments/:id`                    | Buscar por id                      | —                                                                | 200 `Shipment`                  |
| PATCH  | `/shipments/:id/status`             | Cambiar estado                     | `{ status, note? }`                                              | 200 `Shipment`                  |
| PATCH  | `/shipments/:id/cancel`            | Cancelar envío                     | `{ note? }` (body vacío `{}` válido)                             | 200 `Shipment`                  |

Estados de envío: `CREATED`, `DISPATCHED`, `IN_TRANSIT`, `DELIVERED`, `CANCELLED`. Las transiciones de estado las valida `shipments-ms` (ej. `CREATED → DISPATCHED → IN_TRANSIT → DELIVERED`; cancelable solo desde `CREATED` o `DISPATCHED`).

## Manejo de errores

| Origen                                       | Resultado HTTP                                                      |
| -------------------------------------------- | ------------------------------------------------------------------- |
| Validación de input (DTOs del gateway)       | `400` con los mensajes de class-validator                           |
| Errores de negocio de auth-ms / shipments-ms | El status original (`401`, `404`, `409`, …) vía `RpcToHttpExceptionFilter` |
| shipments-ms o NATS no disponibles           | `503 { "message": "Shipments service is unavailable" }`             |
| auth-ms o NATS no disponibles                | `503 { "message": "Auth service is unavailable" }`                  |

## Testing manual

```bash
# --- auth ---

# Registro
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test1234!","name":"Test User"}'

# Login
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test1234!"}'

# Perfil
curl -X GET "http://localhost:3000/auth/profile?userId=<USER_ID>"

# --- shipments ---

# Crear envío
curl -X POST http://localhost:3000/shipments \
  -H "Content-Type: application/json" \
  -d '{"senderId":"<USER_UUID>","receiverName":"Ana","receiverEmail":"ana@example.com","origin":"Madrid","destination":"Barcelona","notes":"Fragil"}'

# Listar (paginado y filtrado por estado)
curl "http://localhost:3000/shipments?page=1&limit=10&status=CREATED"

# Por id
curl http://localhost:3000/shipments/<ID>

# Por trackingCode
curl http://localhost:3000/shipments/tracking/SHP-XXXXXXXX

# Cambiar estado
curl -X PATCH http://localhost:3000/shipments/<ID>/status \
  -H "Content-Type: application/json" \
  -d '{"status":"DISPATCHED","note":"En reparto"}'

# Cancelar
curl -X PATCH http://localhost:3000/shipments/<ID>/cancel \
  -H "Content-Type: application/json" \
  -d '{"note":"Cancelado por el cliente"}'
```

## Estructura del proyecto

```
src/
├── auth/                        # Módulo de autenticación (proxy NATS → auth-ms)
│   ├── dto/                     # RegisterDto, LoginDto
│   ├── interfaces/              # Contrato de respuestas de auth-ms
│   ├── auth.controller.ts       # Endpoints REST
│   ├── auth.service.ts          # ClientProxy NATS (delega en sendRpcRequest)
│   ├── auth.service.spec.ts     # Unit tests (patterns + normalización de errores)
│   └── auth.module.ts
├── shipments/                   # Módulo de envíos (proxy NATS → shipments-ms)
│   ├── dto/                     # Create, FindAll, UpdateStatus, Cancel (sin id: llega por param)
│   ├── interfaces/              # ShipmentStatus (espejo de Prisma), Shipment, PaginatedShipments
│   ├── shipment.controller.ts   # Endpoints REST (tracking/ antes de :id)
│   ├── shipment.service.ts      # ClientProxy NATS (delega en sendRpcRequest)
│   ├── shipment.service.spec.ts # Unit tests (patterns + normalización de errores)
│   └── shipment.module.ts
├── common/
│   ├── filters/                 # RpcToHttpExceptionFilter
│   └── rpc/                     # sendRpcRequest: request NATS + normalización de errores (503)
├── config/                      # Validación de variables de entorno (Joi)
├── app.module.ts
└── main.ts
```

## Comandos

| Task              | Command                |
| ----------------- | ---------------------- |
| Dev server        | `npm run start:dev`    |
| Build             | `npm run build`        |
| Lint              | `npm run lint`         |
| Format            | `npm run format`       |
| Unit tests        | `npm run test`         |
| E2E tests         | `npm run test:e2e`     |

Los scripts de test ejecutan Jest con `node --experimental-vm-modules` (requerido para que Jest pueda `require()`r los paquetes ESM de Nest 12 en Node ≥ 24.9).

## Especificación

- [`specs/nats-integration-plan.md`](specs/nats-integration-plan.md) — integración con `auth-ms`
- [`specs/shipments-nats-integration.md`](specs/shipments-nats-integration.md) — integración con `shipments-ms`
