import { IsOptional, IsString } from 'class-validator';

export class CancelShipmentDto {
  @IsString()
  @IsOptional()
  note?: string;
}
