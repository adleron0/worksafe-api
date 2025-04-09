export interface IPayload {
  username: string;
  sub: number;
  companyId: number;
  role: string;
  permissions: string[];
  iat?: number;
  exp?: number;
}
