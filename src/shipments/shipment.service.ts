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

  /**
   * Delega en sendRpcRequest: normaliza los errores remotos para que
   * RpcToHttpExceptionFilter los mapee a HTTP con el status correcto
   * y responde 503 si shipments-ms está indisponible.
   */
  private request<T>(pattern: string, payload: unknown): Observable<T> {
    return sendRpcRequest<T>(
      this.shipmentsClient,
      pattern,
      payload,
      'Shipments',
    );
  }
}
