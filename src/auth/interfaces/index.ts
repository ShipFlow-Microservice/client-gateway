// Contrato de las respuestas de auth-ms (serializadas como JSON vía NATS)

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  roles: string[];
  isActive: boolean;
  createdAt: string;
}

export interface LoginResponse {
  access_token: string;
  user: {
    id: string;
    email: string;
    name: string | null;
    roles: string[];
  };
}
