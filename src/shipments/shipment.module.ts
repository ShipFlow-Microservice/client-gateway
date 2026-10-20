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
