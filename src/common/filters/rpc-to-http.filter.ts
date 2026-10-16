import { ArgumentsHost, Catch, HttpStatus } from '@nestjs/common';
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
