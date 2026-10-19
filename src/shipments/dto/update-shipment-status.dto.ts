import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ShipmentStatus } from '../interfaces/index.js';

export class UpdateShipmentStatusDto {
  @IsEnum(ShipmentStatus)
  status: ShipmentStatus;

  @IsString()
  @IsOptional()
  note?: string;
}
