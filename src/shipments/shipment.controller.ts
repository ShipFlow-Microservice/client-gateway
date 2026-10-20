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

// 'tracking/:trackingCode' se declara ANTES que ':id' para que no colisionen
// rutas de un solo segmento.
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
