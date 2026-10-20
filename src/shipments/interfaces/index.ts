// Espejo del enum ShipmentStatus de shipments-ms (prisma/schema.prisma).
// Mantener sincronizado manualmente: CREATED, DISPATCHED, IN_TRANSIT,
// DELIVERED, CANCELLED.
export enum ShipmentStatus {
  CREATED = 'CREATED',
  DISPATCHED = 'DISPATCHED',
  IN_TRANSIT = 'IN_TRANSIT',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
}

// Contrato de las respuestas de shipments-ms (serializadas como JSON vía NATS).
// Las respuestas del ms NO incluyen statusLogs (no los carga Prisma).
export interface Shipment {
  id: string;
  trackingCode: string;
  senderId: string;
  receiverName: string;
  receiverEmail: string;
  origin: string;
  destination: string;
  notes: string | null;
  status: ShipmentStatus;
  createdAt: string; // DateTime serializado a ISO 8601 vía NATS
  updatedAt: string;
}

export interface PaginatedShipments {
  items: Shipment[];
  total: number;
  page: number;
  limit: number;
}
