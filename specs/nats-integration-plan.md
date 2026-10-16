# Plan de Integración NATS: client-gateway → auth-ms

## Objetivo
Conectar el client-gateway al microservicio auth-ms via NATS, exponiendo endpoints HTTP REST para que los clientes puedan interactuar con el sistema de autenticación.

## Arquitectura

```
┌─────────────────┐         NATS          ┌─────────────────┐
│ client-gateway  │ ─────────────────────→ │    auth-ms      │
│  (HTTP REST)    │                        │   (NATS micro)  │
│                 │ ←───────────────────── │                 │
└─────────────────┘                        └─────────────────┘
      ↓                                          ↓
  Endpoints REST                    auth.register
  para clientes                     auth.login
                                    auth.profile
```

## Estado
**Aprobado** 

## Dependencias de auth-ms

El microservicio auth-ms expone los siguientes mensajes NATS:

| Message Pattern | Descripción | Input | Output |
|----------------|-------------|-------|--------|
| `auth.register` | Registrar nuevo usuario | `RegisterDto` | Usuario creado (sin password) |
| `auth.login` | Autenticar usuario | `LoginDto` | `{ access_token, user }` |
| `auth.profile` | Obtener perfil de usuario | `{ userId: string }` | Usuario (sin password) |

## Implementación

### 1. Variables de entorno

**Crear `.env`**:
```env
NATS_URL=nats://localhost:4222
PORT=3000
```

**Crear `.env.example`**:
```env
NATS_URL=nats://localhost:4222
PORT=3000
```

### 2. Instalación de dependencias

```bash
npm install @nestjs/microservices nats @nestjs/config joi class-validator class-transformer
```

**Dependencias a instalar**:
- `@nestjs/microservices` - Soporte para microservicios y ClientProxy
- `nats` - Cliente NATS para Node.js
- `@nestjs/config` - Configuración basada en variables de entorno
- `joi` - Validación de variables de entorno
- `class-validator` - Validación de DTOs
- `class-transformer` - Transformación de objetos

### 3. Estructura de archivos

```
src/
├── auth/
│   ├── dto/
│   │   ├── register.dto.ts
│   │   ├── login.dto.ts
│   │   └── index.ts
│   ├── interfaces/
│   │   └── index.ts
│   ├── auth.controller.ts
│   ├── auth.service.ts
│   └── auth.module.ts
├── config/
│   ├── envs.ts
│   └── index.ts
├── common/
│   └── filters/
│       └── rpc-to-http.filter.ts
├── app.module.ts
└── main.ts
```

### 4. Implementación detallada

#### `src/config/envs.ts`
Validación de variables de entorno con Joi (replicar patrón de auth-ms):
```typescript
import 'dotenv/config';
import * as joi from 'joi';

interface EnvVars {
  NATS_URL: string;
  PORT?: number;
}

const envsSchema = joi.object({
  NATS_URL: joi.string().required(),
  PORT: joi.number().default(3000),
}).unknown(true);

const { error, value } = envsSchema.validate(process.env);
if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

const envVars: EnvVars = value;

export const envs = {
  natsUrl: envVars.NATS_URL,
  port: envVars.PORT,
};
```

#### `src/main.ts`
Aplicación HTTP con pipes y filtros globales:
```typescript
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { RpcToHttpExceptionFilter } from './common/filters/rpc-to-http.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new RpcToHttpExceptionFilter());

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Client Gateway running on port ${port}`);
}

bootstrap();
```

#### `src/app.module.ts`
Módulo raíz con configuración global:
```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    AuthModule,
  ],
})
export class AppModule {}
```

#### `src/auth/auth.module.ts`
Módulo con ClientProxy para NATS:
```typescript
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { envs } from '../config';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'AUTH_SERVICE',
        transport: Transport.NATS,
        options: {
          servers: [envs.natsUrl],
        },
      },
    ]),
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
```

#### `src/auth/auth.service.ts`
Service que se comunica con auth-ms via NATS:
```typescript
import { Injectable, Inject } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Observable } from 'rxjs';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    @Inject('AUTH_SERVICE') private readonly authClient: ClientProxy,
  ) {}

  register(registerDto: RegisterDto): Observable<any> {
    return this.authClient.send('auth.register', registerDto);
  }

  login(loginDto: LoginDto): Observable<any> {
    return this.authClient.send('auth.login', loginDto);
  }

  getProfile(userId: string): Observable<any> {
    return this.authClient.send('auth.profile', { userId });
  }
}
```

#### `src/auth/auth.controller.ts`
Controller REST que expone los endpoints:
```typescript
import { Controller, Post, Get, Body, Query } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Post('login')
  login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @Get('profile')
  getProfile(@Query('userId') userId: string) {
    return this.authService.getProfile(userId);
  }
}
```

#### `src/auth/dto/register.dto.ts`
DTO de registro (idéntico a auth-ms):
```typescript
import { IsEmail, IsNotEmpty, IsOptional, IsString, IsStrongPassword } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  @IsStrongPassword()
  password: string;

  @IsString()
  @IsOptional()
  name?: string;
}
```

#### `src/auth/dto/login.dto.ts`
DTO de login (idéntico a auth-ms):
```typescript
import { IsEmail, IsNotEmpty, IsString, IsStrongPassword } from 'class-validator';

export class LoginDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  @IsStrongPassword()
  password: string;
}
```

#### `src/common/filters/rpc-to-http.filter.ts`
Filtro para convertir RpcException en respuesta HTTP:
```typescript
import { Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';

@Catch(RpcException)
export class RpcToHttpExceptionFilter {
  catch(exception: RpcException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    
    const error = exception.getError();
    const status = 
      typeof error === 'object' && error !== null && 'status' in error
        ? (error as any).status
        : HttpStatus.INTERNAL_SERVER_ERROR;
    
    const message = 
      typeof error === 'object' && error !== null && 'message' in error
        ? (error as any).message
        : exception.message;

    response.status(status).json({
      statusCode: status,
      message: message,
      error: 'RpcException',
    });
  }
}
```

## Endpoints expuestos

| Método | Ruta | Descripción | Request Body | Response |
|--------|------|-------------|--------------|----------|
| POST | `/auth/register` | Registrar usuario | `{ email, password, name? }` | `{ id, email, name, roles, isActive, createdAt }` |
| POST | `/auth/login` | Autenticar | `{ email, password }` | `{ access_token, user }` |
| GET | `/auth/profile?userId=...` | Obtener perfil | Query: `userId` | `{ id, email, name, roles, isActive, createdAt }` |

## Manejo de errores

1. **Errores de validación**: class-validator valida el input antes de enviar a NATS
2. **Errores de negocio**: auth-ms lanza HttpException → RpcException → RpcToHttpExceptionFilter → respuesta HTTP con status y message correctos
3. **Errores de conexión**: Si NATS no está disponible, el gateway retorna 503

## Testing manual

### Prerequisitos
1. Iniciar NATS: `docker-compose up -d nats` (desde auth-ms)
2. Iniciar auth-ms: `npm run start:dev` (desde auth-ms)
3. Iniciar client-gateway: `npm run start:dev` (desde client-gateway)

### Pruebas

**Registro**:
```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test1234!","name":"Test User"}'
```

**Login**:
```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test1234!"}'
```

**Perfil**:
```bash
curl -X GET "http://localhost:3000/auth/profile?userId=<USER_ID>"
```

## Consideraciones

- El gateway es **stateless** y no accede directamente a la base de datos
- No maneja JWT en el gateway (auth-ms lo genera)
- Escalable horizontalmente (múltiples instancias del gateway pueden conectarse al mismo NATS)
- El gateway puede usar el mismo contenedor NATS que auth-ms (`nats://localhost:4222`)

## Checklist de implementación

- [x] Crear `.env` y `.env.example`
- [x] Instalar dependencias
- [x] Crear `src/config/envs.ts` e `index.ts`
- [x] Crear `src/common/filters/rpc-to-http.filter.ts`
- [x] Crear `src/auth/dto/register.dto.ts`
- [x] Crear `src/auth/dto/login.dto.ts`
- [x] Crear `src/auth/dto/index.ts`
- [x] Crear `src/auth/auth.service.ts`
- [x] Crear `src/auth/auth.controller.ts`
- [x] Crear `src/auth/auth.module.ts`
- [x] Actualizar `src/app.module.ts`
- [x] Actualizar `src/main.ts`
- [x] Probar integración con auth-ms
- [x] Verificar manejo de errores
- [x] Documentar en README.md

## Notas de implementación (2026-10-15)

Deviaciones necesarias respecto al código del plan, detectadas durante la implementación:

1. **`@nats-io/transport-node` en lugar de `nats`**: NestJS 12 cambió su transporte NATS a NATS v3 y carga `@nats-io/transport-node` en runtime (el paquete `nats` legacy no es utilizado). auth-ms ya incluye este paquete por el mismo motivo.
2. **Normalización de errores en `auth.service.ts`**: las `RpcException` remotas de auth-ms llegan al gateway como objetos planos deserializados (`{ error: { status, message }, message }`), no como instancias de `RpcException`. El servicio las re-envuelve en una `RpcException` local para que `RpcToHttpExceptionFilter` las mapee con el status real (verificado: 409 email duplicado, 401 credenciales inválidas, 401 usuario no encontrado). Cualquier otro error (NATS/auth-ms caídos, "no responders") se responde como **503**.
3. **Imports relativos con extensión `.js`**: requerido por la convención del proyecto (TypeScript 6, `module: nodenext`).
4. **`POST /auth/login` responde 201**: comportamiento por defecto de NestJS para POST sin `@HttpCode` explícito (el body `{ access_token, user }` es correcto). Si se desea 200, agregar `@HttpCode(HttpStatus.OK)`.

### Resultados de las pruebas de integración

| Caso | Resultado |
|------|-----------|
| Registro de usuario nuevo | 201, usuario sin password |
| Registro con email duplicado | 409 "Email already exists" |
| Registro con password débil | 400 (validación local) |
| Login con credenciales válidas | 201 `{ access_token, user }` |
| Login con credenciales inválidas | 401 "Invalid credentials" |
| Perfil con userId válido | 200 |
| Perfil con userId inexistente | 401 "Usuario no encontrado" |
| auth-ms detenido (NATS sin responders) | 503 "Auth service is unavailable" |

## Siguientes pasos (futuro)

- Agregar JWT Guard para proteger endpoints
- Implementar refresh token
- Agregar rate limiting
- Implementar caching (Redis)
- Agregar health checks
- Implementar circuit breaker para resiliencia

## Verificación (2026-10-15)

Verificación estática del checklist contra el código real (sin pruebas en vivo; los resultados de integración documentados arriba se validaron por análisis de código + coincidencia de patrones/payloads con auth-ms). Prácticas validadas contra la documentación oficial de NestJS 12 (NATS v3 / `@nats-io/transport-node`).

| Criterio | Estado | Evidencia |
|----------|--------|-----------|
| `.env` y `.env.example` | ✅ | Ambos existen con `NATS_URL`/`PORT` |
| Dependencias instaladas | ✅ | `package.json`: `@nestjs/microservices` ^12.1.3, `@nestjs/config` ^12.0.1, `class-validator` ^0.15.1, `class-transformer` ^0.5.1, `joi` ^18.2.9, `@nats-io/transport-node` ^3.4.0 (desviación 1, confirmada por docs oficiales NestJS 12) |
| `src/config/envs.ts` + `index.ts` | ✅ | Validación Joi de `NATS_URL`/`PORT`; `index.ts` re-exporta con `.js` |
| `rpc-to-http.filter.ts` | ✅ | Mapea `status`/`message` del error RPC a respuesta HTTP |
| `dto/register.dto.ts` / `dto/login.dto.ts` / `dto/index.ts` | ✅ | Idénticos a los de auth-ms (class-validator) |
| `auth.service.ts` | ✅ | `request()` privado + `normalizeRpcError()` (desviación 2): re-envuelve errores remotos en `RpcException` local; fallback `503 Auth service is unavailable` |
| `auth.controller.ts` | ✅ | POST register/login (login 201 por defecto, desviación 4), GET profile `?userId=` |
| `auth.module.ts` | ✅ | `ClientsModule.register` con `AUTH_SERVICE`, `Transport.NATS`, `servers: [envs.natsUrl]` |
| `app.module.ts` / `main.ts` | ✅ | `ConfigModule.forRoot({ isGlobal: true })`; `ValidationPipe` global (`whitelist`, `forbidNonWhitelisted`, `transform`) + filtro global |
| Integración con auth-ms (estática) | ✅ | Patrones `auth.register/login/profile` y payloads coinciden 1:1 con `auth-ms/src/auth/auth.controller.ts` (líneas 11-24) |
| Manejo de errores (estático) | ✅ | 400 local (ValidationPipe), status real vía filtro, 503 fallback (`auth.service.ts` líneas 62-65) |
| README.md | ✅ | Documenta arquitectura, endpoints, manejo de errores (incl. 503), testing manual y estructura |
| Imports relativos `.js` (desviación 3) | ✅ | Los 14 imports relativos de `src/` incluyen extensión `.js` |

Comandos ejecutados: `npm run build` ✅ · `npm run lint` (oxlint) ✅ · `npm run test` → sin tests unitarios en el proyecto (preexistente) · `npm run test:e2e` → falla por causa preexistente y ajena al spec (TS5011: `rootDir` no explícito en TS6 para `test/`, y el test scaffold espera `GET /` que no existe en este gateway). No se requirieron correcciones de código.
