# ShipFlow — Client Gateway

API Gateway HTTP (REST) del sistema ShipFlow. Expone endpoints de autenticación a los clientes y los delega al microservicio `auth-ms` a través de NATS.

## Arquitectura

```
┌─────────────────┐         NATS          ┌─────────────────┐
│ client-gateway  │ ─────────────────────→ │    auth-ms       │
│  (HTTP REST)    │                        │   (NATS micro)   │
│                 │ ←───────────────────── │                  │
└─────────────────┘                        └─────────────────┘
      ↓
  Endpoints REST        auth.register · auth.login · auth.profile
  para clientes
```

El gateway es **stateless**: no accede a la base de datos ni genera JWT; todo lo delega a `auth-ms`.

## Prerequisitos

1. NATS y PostgreSQL corriendo (desde `auth-ms`):

   ```bash
   docker-compose up -d   # en el directorio de auth-ms
   ```

2. `auth-ms` corriendo (`npm run start:dev` en el directorio de auth-ms).

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

| Método | Ruta                     | Descripción      | Request Body / Query                | Response                                     |
| ------ | ------------------------ | ---------------- | ----------------------------------- | -------------------------------------------- |
| POST   | `/auth/register`        | Registrar usuario | `{ email, password, name? }`      | `{ id, email, name, roles, isActive, createdAt }` |
| POST   | `/auth/login`           | Autenticar        | `{ email, password }`              | `{ access_token, user }`                     |
| GET    | `/auth/profile?userId=` | Obtener perfil   | Query: `userId`                    | `{ id, email, name, roles, isActive, createdAt }` |

## Manejo de errores

| Origen                        | Resultado HTTP                                        |
| ----------------------------- | ----------------------------------------------------- |
| Validación de input (DTOs)    | `400` con los mensajes de class-validator              |
| Errores de negocio de auth-ms | El status original (`401`, `409`, …) vía `RpcToHttpExceptionFilter` |
| auth-ms o NATS no disponibles | `503 { "message": "Auth service is unavailable" }`     |

## Testing manual

```bash
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
```

## Estructura del proyecto

```
src/
├── auth/                    # Módulo de autenticación (proxy NATS)
│   ├── dto/                 # RegisterDto, LoginDto (idénticos a auth-ms)
│   ├── interfaces/          # Contrato de respuestas de auth-ms
│   ├── auth.controller.ts   # Endpoints REST
│   ├── auth.service.ts      # ClientProxy NATS + normalización de errores
│   └── auth.module.ts
├── common/filters/          # RpcToHttpExceptionFilter
├── config/                  # Validación de variables de entorno (Joi)
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

## Especificación

El diseño completo está documentado en [`specs/nats-integration-plan.md`](specs/nats-integration-plan.md).
