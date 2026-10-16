import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { catchError, Observable, throwError } from 'rxjs';
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

  /**
   * Envía un mensaje a auth-ms vía NATS y normaliza los errores de la
   * respuesta para que RpcToHttpExceptionFilter pueda mapearlos a HTTP
   * con el status correcto.
   */
  private request<T>(pattern: string, payload: unknown): Observable<T> {
    return this.authClient
      .send<T>(pattern, payload)
      .pipe(catchError((err) => throwError(() => this.normalizeRpcError(err))));
  }

  /**
   * Las RpcException de auth-ms llegan serializadas como objetos planos
   * ({ error: { status, message }, message }); se re-envuelven en una
   * RpcException local para conservar su status real. Cualquier otro
   * error se interpreta como indisponibilidad del servicio (503).
   */
  private normalizeRpcError(err: unknown): RpcException {
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
      message: 'Auth service is unavailable',
    });
  }
}
