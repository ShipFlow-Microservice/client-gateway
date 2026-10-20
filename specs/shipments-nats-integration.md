# Spec: Integración NATS — client-gateway → shipments-ms

> **Nota**: este spec fue redactado inicialmente en modo plan (`~/.opencode/plan/`)
> y aprobado por el usuario (2026-10-19); como primer paso de su implementación
> fue movido a esta ubicación definitiva (ver checklist).

## Objetivo

Conectar el client-gateway al microservicio shipments-ms vía NATS, exponiendo
endpoints HTTP REST para que los clientes gestionen envíos (crear, consultar por
id/trackingCode, listar paginado, actualizar estado y cancelar), replicando el
patrón ya probado con auth-ms.

## Estado

**Implementado** (2026-10-19)

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

- **shipments-ms ya está implementado como microservicio NATS**
  (`NestFactory.createMicroservice` + `Transport.NATS`) con 6 `@MessagePattern`.
  **No requiere cambios** en este spec.
- El gateway añade un segundo `ClientProxy` (`SHIPMENTS_SERVICE`) hacia el
  **mismo `NATS_URL`** (mismo servidor NATS).
- El gateway sigue siendo **stateless**: no conoce Prisma ni PostgreSQL.

## Dependencias de shipments-ms (ya implementadas)

Fuente: `shipments-ms/src/shipments/shipment.controller.ts`.

| Message Pattern         | Input                                          | Output              | Errores de negocio                                  |
| ----------------------- | ---------------------------------------------- | ------------------- | --------------------------------------------------- |
| `shipments.create`      | `CreateShipmentDto`                            | `Shipment`          | 409 (colisión de trackingCode, improbable)           |
| `shipments.findOne`     | `{ id: string }`                               | `Shipment`          | 404 (no encontrado)                                 |
| `shipments.findByTrackingCode` | `{ trackingCode: string }`             | `Shipment`          | 404 (no encontrado)                                 |
| `shipments.findAll`     | `{ page?, limit?, status? }`                   | `PaginatedShipments`| —                                                   |
| `shipments.cancel`      | `{ id, note? }`                                | `Shipment`          | 404, 409 (transición inválida)                      |
| `shipments.updateStatus`| `{ id, status, note? }`                       | `Shipment`          | 404, 400 (transición inválida)                      |

Estados válidos (`prisma/schema.prisma`): `CREATED`, `DISPATCHED`,
`IN_TRANSIT`, `DELIVERED`, `CANCELLED`.

## Decisiones de diseño (aprobadas por el usuario)

1. **Rutas RESTful con params**: `GET /shipments/:id`, `GET /shipments/tracking/:trackingCode`,
   `PATCH /shipments/:id/status`, `PATCH /shipments/:id/cancel`. El controller
   mapea los params a los payloads NATS (`{ id }`, `{ id, status, note }`, …).
2. **Enum `ShipmentStatus` local**: el gateway no instala `@prisma/client`; define
   un enum espejo en `src/shipments/interfaces/index.ts`, sincronizado manualmente
   con `prisma/schema.prisma` (riesgo de drift aceptado y documentado).
3. **Helper compartido de request RPC**: se extrae la lógica `request()` +
   `normalizeRpcError()` de `AuthService` a `src/common/rpc/rpc-request.helper.ts`,
   parametrizando el mensaje 503 (`'Shipments service is unavailable'` /
   `'Auth service is unavailable'`). `AuthService` se refactoriza para usarlo
   con **comportamiento idéntico** (protegido por `auth.service.spec.ts`).
4. **Unit tests del service**: `shipment.service.spec.ts` con `ClientProxy`
   mockeado (patterns enviados + normalización de errores). Añadido también
   `auth.service.spec.ts` espejo como red de seguridad de la refactorización.

## Implementación

### 1. Variables de entorno

**Sin cambios.** El módulo reutiliza `NATS_URL` (ya validado con Joi en
`src/config/envs.ts`) y `PORT`. No se añaden dependencias npm: todo lo necesario
(`@nestjs/microservices`, `@nats-io/transport-node`, `class-validator`,
`class-transformer`, `rxjs`, `jest`) ya está instalado.

### 2. Estructura de archivos

```
src/
├── auth/
│   ├── auth.service.ts            [MODIFICADO: usa helper compartido]
│   └── auth.service.spec.ts       [NUEVO: protege la refactorización]
├── common/
│   ├── filters/rpc-to-http.filter.ts   [existente, sin cambios]
│   └── rpc/
│       └── rpc-request.helper.ts [NUEVO]
├── shipments/
│   ├── dto/
│   │   ├── create-shipment.dto.ts
│   │   ├── find-all-shipments.dto.ts
│   │   ├── update-shipment-status.dto.ts
│   │   ├── cancel-shipment.dto.ts
│   │   └── index.ts
│   ├── interfaces/
│   │   └── index.ts               [NUEVO: ShipmentStatus espejo, Shipment, PaginatedShipments]
│   ├── shipment.controller.ts     [NUEVO]
│   ├── shipment.service.ts        [NUEVO]
│   ├── shipment.service.spec.ts   [NUEVO]
│   └── shipment.module.ts         [NUEVO]
├── app.module.ts                  [MODIFICADO: + ShipmentModule]
└── main.ts                        [sin cambios]
```

Imports relativos con extensión `.js` (convención del proyecto: TypeScript 6,
`module: nodenext`).

### 3. Implementación detallada

#### `src/common/rpc/rpc-request.helper.ts` (nuevo)

Extracción exacta de la lógica de `AuthService`, parametrizada por servicio:

```typescript
import { HttpStatus } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { catchError, Observable, throwError } from 'rxjs';

/**
 * Envía un mensaje request/response vía NATS y normaliza los errores de la
 * respuesta para que RpcToHttpExceptionFilter pueda mapearlos a HTTP con el
 * status correcto. Ante errores no reconocidos (servicio caído, "no
 * responders"), responde 503 con "<service> service is unavailable".
 */
export function sendRpcRequest<T>(
  client: ClientProxy,
  pattern: string,
  payload: unknown,
  service: string,
): Observable<T> {
  return client.send<T>(pattern, payload).pipe(
    catchError((err: unknown) =>
      throwError(() => normalizeRpcError(err, service)),
    ),
  );
}

/**
 * Las RpcException remotas llegan serializadas como objetos planos
 * ({ error: { status, message }, message }); se re-envuelven en una
 * RpcException local para conservar su status real.
 */
function normalizeRpcError(err: unknown, service: string): RpcException {
  if (err instanceof RpcException) {
    return err;
  }

  const error =
    typeof err === 'object' && err !== null && 'error' in err
      ? (err as any).error
      : null;

  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    'message' in error
  ) {
    return new RpcException(error);
  }

  return new RpcException({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: `${service} service is unavailable`,
  });
}
```

#### `src/auth/auth.service.ts` (refactor, comportamiento idéntico)

Se eliminan `normalizeRpcError()` y el manejo de `catchError`; `request()`
delega en el helper. El 503 sigue siendo exactamente `'Auth service is unavailable'`:

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Observable } from 'rxjs';
import { sendRpcRequest } from '../common/rpc/rpc-request.helper.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { AuthUser, LoginResponse } from './interfaces/index.js';

@Injectable()
export class AuthService {
  constructor(
    @Inject('AUTH_SERVICE') private readonly authClient: ClientProxy,
  ) {}

  register(registerDto: RegisterDto): Observable<AuthUser> {
    return this.request('auth.register', registerDto);
  }

  login(loginDto: LoginDto): Observable<LoginResponse> {
    return this.request('auth.login', loginDto);
  }

  getProfile(userId: string): Observable<AuthUser> {
    return this.request('auth.profile', { userId });
  }

  private request<T>(pattern: string, payload: unknown): Observable<T> {
    return sendRpcRequest<T>(this.authClient, pattern, payload, 'Auth');
  }
}
```

#### `src/shipments/interfaces/index.ts` (nuevo)

Contrato de las respuestas de shipments-ms (serializadas como JSON vía NATS).
El enum es un **espejo** de `ShipmentStatus` de `prisma/schema.prisma`:

```typescript
// Espejo del enum ShipmentStatus de shipments-ms (prisma/schema.prisma).
// Mantener sincronizado manualmente: CREATED, DISPATCHED, IN_TRANSIT,
// DELIVERED, CANCELLED.
export enum ShipmentStatus {
  CREATED = 'CREATED',
  DISPATCHED = 'DISPATCHED',
  IN_TRANSIT = 'IN_TRANSIT',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
}

// Contrato de las respuestas de shipments-ms (JSON vía NATS).
// Las respuestas del ms NO incluyen statusLogs (no los carga Prisma).
export interface Shipment {
  id: string;
  trackingCode: string;
  senderId: string;
  receiverName: string;
  receiverEmail: string;
  origin: string;
  destination: string;
  notes: string | null;
  status: ShipmentStatus;
  createdAt: string; // DateTime serializado a ISO 8601 vía NATS
  updatedAt: string;
}

export interface PaginatedShipments {
  items: Shipment[];
  total: number;
  page: number;
  limit: number;
}
```

#### `src/shipments/dto/create-shipment.dto.ts` (nuevo)

Idéntico al del ms (`senderId` se pasa en el body hasta que exista JWT Guard):

```typescript
import { IsEmail, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateShipmentDto {
  @IsUUID()
  @IsNotEmpty()
  senderId: string;

  @IsString()
  @IsNotEmpty()
  receiverName: string;

  @IsEmail()
  @IsNotEmpty()
  receiverEmail: string;

  @IsString()
  @IsNotEmpty()
  origin: string;

  @IsString()
  @IsNotEmpty()
  destination: string;

  @IsString()
  @IsOptional()
  notes?: string;
}
```

#### `src/shipments/dto/find-all-shipments.dto.ts` (nuevo)

Como query params llegan como strings, `@Type(() => Number)` los transforma
(igual que en el ms). Usa el enum local en lugar de `@prisma/client`:

```typescript
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ShipmentStatus } from '../interfaces/index.js';

export class FindAllShipmentsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsEnum(ShipmentStatus)
  status?: ShipmentStatus;
}
```

#### `src/shipments/dto/update-shipment-status.dto.ts` (nuevo)

**Sin `id`**: llega por route param. El controller reconstruye el payload
completo `{ id, status, note }` para el ms:

```typescript
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ShipmentStatus } from '../interfaces/index.js';

export class UpdateShipmentStatusDto {
  @IsEnum(ShipmentStatus)
  status: ShipmentStatus;

  @IsString()
  @IsOptional()
  note?: string;
}
```

#### `src/shipments/dto/cancel-shipment.dto.ts` (nuevo)

**Sin `id`**: llega por route param. Acepta body vacío `{}` o `{ note }`:

```typescript
import { IsOptional, IsString } from 'class-validator';

export class CancelShipmentDto {
  @IsString()
  @IsOptional()
  note?: string;
}
```

#### `src/shipments/dto/index.ts` (nuevo)

```typescript
export * from './create-shipment.dto.js';
export * from './find-all-shipments.dto.js';
export * from './update-shipment-status.dto.js';
export * from './cancel-shipment.dto.js';
```

#### `src/shipments/shipment.service.ts` (nuevo)

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Observable } from 'rxjs';
import { sendRpcRequest } from '../common/rpc/rpc-request.helper.js';
import { CreateShipmentDto } from './dto/create-shipment.dto.js';
import { FindAllShipmentsDto } from './dto/find-all-shipments.dto.js';
import {
  PaginatedShipments,
  Shipment,
  ShipmentStatus,
} from './interfaces/index.js';

@Injectable()
export class ShipmentService {
  constructor(
    @Inject('SHIPMENTS_SERVICE')
    private readonly shipmentsClient: ClientProxy,
  ) {}

  create(createShipmentDto: CreateShipmentDto): Observable<Shipment> {
    return this.request('shipments.create', createShipmentDto);
  }

  findOne(id: string): Observable<Shipment> {
    return this.request('shipments.findOne', { id });
  }

  findByTrackingCode(trackingCode: string): Observable<Shipment> {
    return this.request('shipments.findByTrackingCode', { trackingCode });
  }

  findAll(findAllDto: FindAllShipmentsDto): Observable<PaginatedShipments> {
    return this.request('shipments.findAll', findAllDto);
  }

  cancel(id: string, note?: string): Observable<Shipment> {
    return this.request('shipments.cancel', { id, note });
  }

  updateStatus(
    id: string,
    status: ShipmentStatus,
    note?: string,
  ): Observable<Shipment> {
    return this.request('shipments.updateStatus', { id, status, note });
  }

  private request<T>(pattern: string, payload: unknown): Observable<T> {
    return sendRpcRequest<T>(
      this.shipmentsClient,
      pattern,
      payload,
      'Shipments',
    );
  }
}
```

Nota: `{ id, note }` con `note: undefined` serializa a `{ id }` vía NATS;
el DTO del ms declara `note` como `@IsOptional()`.

#### `src/shipments/shipment.controller.ts` (nuevo)

`tracking/:trackingCode` se declara **antes** que `:id` para evitar
colisiones de rutas de un solo segmento:

```typescript
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ShipmentService } from './shipment.service.js';
import { CreateShipmentDto } from './dto/create-shipment.dto.js';
import { FindAllShipmentsDto } from './dto/find-all-shipments.dto.js';
import { UpdateShipmentStatusDto } from './dto/update-shipment-status.dto.js';
import { CancelShipmentDto } from './dto/cancel-shipment.dto.js';

@Controller('shipments')
export class ShipmentController {
  constructor(private readonly shipmentService: ShipmentService) {}

  @Post()
  create(@Body() createShipmentDto: CreateShipmentDto) {
    return this.shipmentService.create(createShipmentDto);
  }

  @Get()
  findAll(@Query() findAllDto: FindAllShipmentsDto) {
    return this.shipmentService.findAll(findAllDto);
  }

  @Get('tracking/:trackingCode')
  findByTrackingCode(@Param('trackingCode') trackingCode: string) {
    return this.shipmentService.findByTrackingCode(trackingCode);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.shipmentService.findOne(id);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() updateStatusDto: UpdateShipmentStatusDto,
  ) {
    return this.shipmentService.updateStatus(
      id,
      updateStatusDto.status,
      updateStatusDto.note,
    );
  }

  @Patch(':id/cancel')
  cancel(@Param('id') id: string, @Body() cancelDto: CancelShipmentDto) {
    return this.shipmentService.cancel(id, cancelDto.note);
  }
}
```

#### `src/shipments/shipment.module.ts` (nuevo)

Mismo patrón que `AuthModule`, con el cliente `SHIPMENTS_SERVICE`:

```typescript
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ShipmentController } from './shipment.controller.js';
import { ShipmentService } from './shipment.service.js';
import { envs } from '../config/index.js';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'SHIPMENTS_SERVICE',
        transport: Transport.NATS,
        options: {
          servers: [envs.natsUrl],
        },
      },
    ]),
  ],
  controllers: [ShipmentController],
  providers: [ShipmentService],
})
export class ShipmentModule {}
```

#### `src/app.module.ts` (modificado)

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module.js';
import { ShipmentModule } from './shipments/shipment.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    AuthModule,
    ShipmentModule,
  ],
})
export class AppModule {}
```

#### `src/shipments/shipment.service.spec.ts` (nuevo)

Unit tests con `ClientProxy` mockeado. Cubren: patterns/payloads enviados por
cada método, re-envoltura de errores remotos conservando el status real, y
fallback 503 ante errores no reconocidos:

```typescript
import { Test } from '@nestjs/testing';
import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { ShipmentService } from './shipment.service.js';
import { CreateShipmentDto } from './dto/create-shipment.dto.js';
import { ShipmentStatus } from './interfaces/index.js';

describe('ShipmentService', () => {
  let service: ShipmentService;
  let client: { send: jest.Mock };

  const createDto: CreateShipmentDto = {
    senderId: 'b3c1a2d4-0000-0000-0000-000000000000',
    receiverName: 'Ana',
    receiverEmail: 'ana@example.com',
    origin: 'Madrid',
    destination: 'Barcelona',
  };

  beforeEach(async () => {
    client = { send: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        ShipmentService,
        { provide: 'SHIPMENTS_SERVICE', useValue: client },
      ],
    }).compile();

    service = module.get(ShipmentService);
  });

  it('se define', () => {
    expect(service).toBeDefined();
  });

  it('envía cada método al pattern y payload NATS correctos', () => {
    client.send.mockReturnValue(of({}));

    service.create(createDto);
    expect(client.send).toHaveBeenCalledWith('shipments.create', createDto);

    service.findOne('id-1');
    expect(client.send).toHaveBeenCalledWith('shipments.findOne', {
      id: 'id-1',
    });

    service.findByTrackingCode('SHP-1234ABCD');
    expect(client.send).toHaveBeenCalledWith('shipments.findByTrackingCode', {
      trackingCode: 'SHP-1234ABCD',
    });

    service.findAll({ page: 1, limit: 10 });
    expect(client.send).toHaveBeenCalledWith('shipments.findAll', {
      page: 1,
      limit: 10,
    });

    service.cancel('id-1', 'motivo');
    expect(client.send).toHaveBeenCalledWith('shipments.cancel', {
      id: 'id-1',
      note: 'motivo',
    });

    service.updateStatus('id-1', ShipmentStatus.DISPATCHED, 'en reparto');
    expect(client.send).toHaveBeenCalledWith('shipments.updateStatus', {
      id: 'id-1',
      status: ShipmentStatus.DISPATCHED,
      note: 'en reparto',
    });
  });

  it('re-envuelve errores remotos serializados conservando el status real (404)', (done) => {
    client.send.mockReturnValue(
      throwError(() => ({
        error: { status: 404, message: 'Shipment with id id-1 not found' },
        message: 'Shipment with id id-1 not found',
      })),
    );

    service.findOne('id-1').subscribe({
      error: (err) => {
        expect(err).toBeInstanceOf(RpcException);
        const error = err.getError() as { status: number; message: string };
        expect(error.status).toBe(404);
        expect(error.message).toBe('Shipment with id id-1 not found');
        done();
      },
    });
  });

  it('responde 503 ante errores no reconocidos (servicio caído)', (done) => {
    client.send.mockReturnValue(throwError(() => new Error('no responders')));

    service.findAll({}).subscribe({
      error: (err) => {
        expect(err).toBeInstanceOf(RpcException);
        const error = err.getError() as { status: number; message: string };
        expect(error.status).toBe(503);
        expect(error.message).toBe('Shipments service is unavailable');
        done();
      },
    });
  });
});
```

#### `src/auth/auth.service.spec.ts` (nuevo)

Espejo del anterior para `AuthService` (patterns `auth.register/login/profile`,
401 remoto conservado, 503 `'Auth service is unavailable'`). Protege la
refactorización del helper compartido.

## Endpoints expuestos

| Método | Ruta                               | Pattern NATS              | Body / Query                       | Response               |
| ------ | ---------------------------------- | ------------------------- | ---------------------------------- | ---------------------- |
| POST   | `/shipments`                       | `shipments.create`        | Body `CreateShipmentDto`           | 201 `Shipment`         |
| GET    | `/shipments`                       | `shipments.findAll`       | Query `page`/`limit`/`status`      | 200 `PaginatedShipments` |
| GET    | `/shipments/tracking/:trackingCode`| `shipments.findByTrackingCode` | —                           | 200 `Shipment`         |
| GET    | `/shipments/:id`                   | `shipments.findOne`       | —                                  | 200 `Shipment`         |
| PATCH  | `/shipments/:id/status`            | `shipments.updateStatus`  | Body `{ status, note? }`           | 200 `Shipment`         |
| PATCH  | `/shipments/:id/cancel`           | `shipments.cancel`        | Body `{ note? }` (vacío `{}` válido)| 200 `Shipment`         |

`POST /shipments` responde **201** por defecto de NestJS (mismo comportamiento
que `/auth/*`).

## Manejo de errores

| Origen                                        | Resultado HTTP                                                  |
| --------------------------------------------- | --------------------------------------------------------------- |
| Validación de input (DTOs del gateway)        | `400` con mensajes de class-validator                            |
| `404` envío no encontrado (shipments-ms)      | `404` con el mensaje del ms, vía `RpcToHttpExceptionFilter`      |
| `400` transición de estado inválida (ms)      | `400`                                                            |
| `409` cancelación inválida (ms)               | `409`                                                            |
| shipments-ms o NATS no disponibles            | `503 { "message": "Shipments service is unavailable" }`          |
| auth-ms o NATS no disponibles (sin cambios)   | `503 { "message": "Auth service is unavailable" }`               |

## Testing manual

### Prerequisitos

1. NATS corriendo (`docker-compose` de **auth-ms** o `nats-server` en `localhost:4222`).
2. PostgreSQL de shipments-ms: `docker-compose up -d` (puerto `5434`) y
   migraciones aplicadas (`npx prisma migrate deploy` si hace falta).
3. `shipments-ms`: `npm run start:dev`.
4. `client-gateway`: `npm run start:dev`.

### Pruebas

```bash
# Crear envío (201)
curl -X POST http://localhost:3000/shipments \
  -H "Content-Type: application/json" \
  -d '{"senderId":"<USER_UUID>","receiverName":"Ana","receiverEmail":"ana@example.com","origin":"Madrid","destination":"Barcelona","notes":"Fragil"}'

# Listar (200, paginado y filtrable)
curl "http://localhost:3000/shipments?page=1&limit=10&status=CREATED"

# Por id (200 / 404)
curl http://localhost:3000/shipments/<ID>

# Por trackingCode (200 / 404)
curl http://localhost:3000/shipments/tracking/SHP-1234ABCD

# Actualizar estado (200 / 400 transición inválida)
curl -X PATCH http://localhost:3000/shipments/<ID>/status \
  -H "Content-Type: application/json" \
  -d '{"status":"DISPATCHED","note":"En reparto"}'

# Cancelar (200 / 409 si ya no es cancelable)
curl -X PATCH http://localhost:3000/shipments/<ID>/cancel \
  -H "Content-Type: application/json" \
  -d '{"note":"Cancelado por el cliente"}'

# 503: detener shipments-ms y repetir cualquier llamada
```

### Regresión de auth tras la refactorización

```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test1234!","name":"Test"}'
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test1234!"}'
# auth-ms detenido → 503 "Auth service is unavailable"
```

## Consideraciones

- El gateway es **stateless**: no accede a la base de datos ni conoce Prisma.
- Ambos microservicios comparten el **mismo servidor NATS** (`NATS_URL`).
- El enum local `ShipmentStatus` es un espejo de `prisma/schema.prisma`:
  si el ms añade un estado, hay que actualizarlo manualmente (riesgo de drift
  documentado).
- Los DTOs de gateway **no son idénticos** a los del ms en `updateStatus` y
  `cancel` (el `id` llega por route param); el controller reconstruye el
  payload completo esperado por el ms.
- `senderId` viaja en el body; cuando exista JWT Guard debería derivarse del
  token (futuro).
- Las respuestas no incluyen `statusLogs` (el ms no los carga).
- Escalable horizontalmente (múltiples instancias del gateway contra el mismo NATS).

## Actualización de AGENTS.md (solicitada por el usuario)

La sección `## Specs` de `AGENTS.md` ya exige que los specs vivan en `specs/`;
se añade un bullet para cerrar el hueco detectado en esta sesión (el borrador
quedó fuera del repo, en el directorio de planes de OpenCode). Añadir tras el
último bullet de la sección:

```markdown
- Los borradores redactados en modo plan (`.opencode/plan/`) deben moverse a `specs/` al aprobarse o implementarse: `specs/` es la única ubicación definitiva y versionada de los specs
```

## Checklist de tareas

- [x] Mover este spec a `specs/shipments-nats-integration.md` (client-gateway) y eliminar el borrador de `.opencode/plan/`
- [x] Actualizar `AGENTS.md` (sección Specs): añadir el bullet sobre borradores de modo plan
- [x] Crear `src/common/rpc/rpc-request.helper.ts` (`sendRpcRequest`)
- [x] Refactorizar `src/auth/auth.service.ts` para usar el helper (comportamiento idéntico)
- [x] Crear `src/auth/auth.service.spec.ts` (red de seguridad del refactor)
- [x] Crear `src/shipments/interfaces/index.ts` (enum espejo + contratos)
- [x] Crear DTOs: `create`, `find-all`, `update-status` (sin id), `cancel` (sin id) + `index.ts`
- [x] Crear `src/shipments/shipment.service.ts` (cliente `SHIPMENTS_SERVICE`)
- [x] Crear `src/shipments/shipment.controller.ts` (rutas RESTful; `tracking/` antes de `:id`)
- [x] Crear `src/shipments/shipment.module.ts`
- [x] Registrar `ShipmentModule` en `src/app.module.ts`
- [x] Crear `src/shipments/shipment.service.spec.ts`
- [x] `npm run build` sin errores
- [x] `npm run lint` (oxlint) sin errores
- [x] `npm run test` en verde (specs nuevos de auth y shipments)
- [x] Pruebas de integración manual (curl): crear, listar, por id, por trackingCode, updateStatus, cancel
- [x] Verificar errores: 404, 400 transición inválida, 409 cancel inválida, 503 con shipments-ms detenido
- [x] Verificar regresión de `/auth/*` (201 registro, 409 duplicado, 401 login, 503 auth-ms caído)
- [x] Actualizar `README.md` (arquitectura con shipments-ms, endpoints, errores, testing manual, estructura)

## Notas de implementación (2026-10-19)

Deviaciones necesarias respecto al plan del spec, detectadas durante la implementación (ninguna cambia el diseño aprobado):

1. **`rootDir: "."` explícito en `tsconfig.json` (TS5011)**: TypeScript 6 ya no calcula `rootDir` implícito en las compilaciones por archivo de ts-jest, así que los specs nuevos fallaban con TS5011. El valor `.` coincide con el `tsconfig.json` de referencia de Nest 12 (ESM). El layout de `dist/` no cambia: lo sigue gobernando `tsconfig.build.json` (`rootDir: ./src`). De paso desbloquea el TS5011 preexistente de `test/`.
2. **Jest + paquetes ESM de Nest 12**: los paquetes `@nestjs/*` v12 son ESM-only (`"type": "module"`). Jest 30 solo puede `require()`rlos nativamente en Node ≥ 24.9 **y** con `--experimental-vm-modules` (sin el flag no existe `vm.SourceTextModule` y jest lanza `ERR_REQUIRE_ESM`). Los scripts `test*` de `package.json` ahora ejecutan `node --experimental-vm-modules node_modules/jest/bin/jest.js` (la sintaxis `NODE_OPTIONS=…` previa al comando no funciona en el `cmd` de Windows). Coherente con la guía oficial de Nest 12: "Jest can load the ESM-only v12 packages only on Node.js v24.9 or later".
3. **`jest.config.ts` y `test/jest-e2e.json`**: `moduleNameMapper` añade `'^(\\.{1,2}/.*)\\.js$': '$1'` — ts-jest compila a CJS y los imports relativos con extensión `.js` (convención nodenext) deben resolverse a los archivos `.ts` de origen.
4. **`AGENTS.md`**: además del bullet acordado sobre borradores de modo plan, se documentaron los gotchas 2 y 3 en la sección "Toolchain gotchas" para futuros agentes.

### Resultados de las pruebas de integración (en vivo, 2026-10-19)

Infra: contenedores `auth-ms-nats` (4222) y `shipments-ms-postgres` (5434) ya corriendo; `shipments-ms`, `auth-ms` y `client-gateway` levantados para la prueba y detenidos al terminar.

| Caso | Resultado |
|------|-----------|
| Crear envío | 201, `id` UUID, `trackingCode` `SHP-XXXXXXXX`, status `CREATED` |
| Listar (`?page=1&limit=10&status=CREATED`) | 200 `{ items, total, page, limit }` |
| Buscar por id | 200 `Shipment` |
| Buscar por trackingCode | 200 `Shipment` |
| Cambiar estado (`CREATED → DISPATCHED`) | 200, status `DISPATCHED` |
| Transición inválida (`DISPATCHED → DELIVERED`) | 400 "Invalid transition from DISPATCHED to DELIVERED" |
| Cancelar (`DISPATCHED → CANCELLED`) | 200, status `CANCELLED` |
| Cancelar de nuevo | 409 "Shipment with status CANCELLED cannot be cancelled" |
| trackingCode inexistente | 404 "Shipment with trackingCode SHP-00000000 not found" |
| Validación local (body sin `receiverEmail`) | 400 (class-validator en el gateway; ni llega a NATS) |
| shipments-ms detenido | 503 "Shipments service is unavailable" |
| Regresión `/auth/*` (registro 201 con password oculto, duplicado 409, login inválido 401, login válido 201 + token, perfil 200, validación 400) | 6/6 correctos tras la refactorización |
| auth-ms detenido | 503 "Auth service is unavailable" |

### Comandos ejecutados (verificación final)

`npm run build` ✅ · `npm run lint` (oxlint) ✅ · `npm run test` → **2 suites / 8 tests en verde** (`shipment.service.spec.ts` 4, `auth.service.spec.ts` 4) · `npm run test:e2e` → compila y arranca el `AppModule` correctamente, pero falla por causa preexistente y ajena al spec: el scaffold `test/app.e2e-spec.ts` espera `GET /` → 200 "Hello World!", ruta que no existe en este gateway.

## Verificación (spec-verify, 2026-10-19)

Auditoría de los 19 criterios del checklist contra el código real del repo: **19/19 en verde**, sin correcciones necesarias. Detalle adicional de la verificación:

- **Patrones y contratos verificados contra shipments-ms real**: los 6 patterns enviados por el gateway coinciden con los `@MessagePattern` de `shipments-ms/src/shipments/shipment.controller.ts`; el enum espejo `ShipmentStatus` coincide exactamente con `prisma/schema.prisma`; las respuestas no incluyen `statusLogs` (confirmado en la respuesta de `create`).
- **Prácticas NestJS validadas con Context7 (docs oficiales Nest 12 / NATS v3)**: `ClientsModule.register` + `Transport.NATS` + `servers` + `@Inject` + `client.send` (patrón documentado en microservices/nats y microservices/basics); uso de `@nats-io/transport-node` (requisito de NATS v3 en Nest 12); re-lanzado de `RpcException` con objeto `{ status, message }` y mapeo en `RpcToHttpExceptionFilter` (comportamiento documentado: el objeto se devuelve tal cual).
- **Re-ejecución en vivo de las pruebas de integración** (infra: NATS 4222, PostgreSQL de ambos ms, y los tres servicios levantados y detenidos al terminar): **16/16 casos en verde** — create 201 (`SHP-D60A981E`, status `CREATED`, sin `statusLogs`), listado filtrado 200 `{ items, total, page, limit }`, por id 200, por trackingCode 200, transición `CREATED→DISPATCHED` 200, transición inválida `DISPATCHED→DELIVERED` 400, cancelar 200, re-cancelar 409, tracking inexistente 404, validación local (sin `receiverEmail`) 400, y regresión completa de `/auth/*` (registro 201 con password oculto, duplicado 409, login inválido 401, login válido 201 + token, perfil 200, validación 400).
- **503 re-verificados en vivo** (deteniendo cada ms por su árbol de procesos): shipments-ms detenido → `503 "Shipments service is unavailable"`; auth-ms detenido → `503 "Auth service is unavailable"`.
- **Comandos re-ejecutados**: `npm run build` ✅ · `npm run lint` (oxlint) ✅ · `npm run test` → 2 suites / 8 tests en verde.
- Nota: los cambios de la implementación (8 archivos modificados y 4 rutas nuevas) aún no estaban commiteados en git al momento de esta auditoría.

## Siguientes pasos (futuro)

- JWT Guard: proteger endpoints de shipments y derivar `senderId` del token
- Rate limiting
- Health checks
- Circuit breaker para resiliencia
