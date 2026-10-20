import { Test } from '@nestjs/testing';
import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { AuthService } from './auth.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';

describe('AuthService', () => {
  let service: AuthService;
  let client: { send: jest.Mock };

  const registerDto: RegisterDto = {
    email: 'test@example.com',
    password: 'Test1234!',
    name: 'Test User',
  };

  const loginDto: LoginDto = {
    email: 'test@example.com',
    password: 'Test1234!',
  };

  beforeEach(async () => {
    client = { send: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: 'AUTH_SERVICE', useValue: client },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  it('se define', () => {
    expect(service).toBeDefined();
  });

  it('envía cada método al pattern y payload NATS correctos', () => {
    client.send.mockReturnValue(of({}));

    service.register(registerDto);
    expect(client.send).toHaveBeenCalledWith('auth.register', registerDto);

    service.login(loginDto);
    expect(client.send).toHaveBeenCalledWith('auth.login', loginDto);

    service.getProfile('user-1');
    expect(client.send).toHaveBeenCalledWith('auth.profile', {
      userId: 'user-1',
    });
  });

  it('re-envuelve errores remotos serializados conservando el status real (401)', (done) => {
    client.send.mockReturnValue(
      throwError(() => ({
        error: { status: 401, message: 'Invalid credentials' },
        message: 'Invalid credentials',
      })),
    );

    service.login(loginDto).subscribe({
      error: (err) => {
        expect(err).toBeInstanceOf(RpcException);
        const error = err.getError() as { status: number; message: string };
        expect(error.status).toBe(401);
        expect(error.message).toBe('Invalid credentials');
        done();
      },
    });
  });

  it('responde 503 ante errores no reconocidos (servicio caído)', (done) => {
    client.send.mockReturnValue(throwError(() => new Error('no responders')));

    service.getProfile('user-1').subscribe({
      error: (err) => {
        expect(err).toBeInstanceOf(RpcException);
        const error = err.getError() as { status: number; message: string };
        expect(error.status).toBe(503);
        expect(error.message).toBe('Auth service is unavailable');
        done();
      },
    });
  });
});
