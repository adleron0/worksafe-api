export interface IPayload {
  username: string;
  sub: number;
  companyId: number;
  profile: string;
  permissions: string[];
  iat?: number;
  exp?: number;
}
