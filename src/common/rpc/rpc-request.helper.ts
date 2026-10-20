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
