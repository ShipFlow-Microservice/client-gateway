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

  /**
   * Delega en sendRpcRequest: normaliza los errores remotos para que
   * RpcToHttpExceptionFilter los mapee a HTTP con el status correcto
   * y responde 503 si auth-ms está indisponible.
   */
  private request<T>(pattern: string, payload: unknown): Observable<T> {
    return sendRpcRequest<T>(this.authClient, pattern, payload, 'Auth');
  }
}
