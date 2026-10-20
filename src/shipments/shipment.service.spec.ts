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
