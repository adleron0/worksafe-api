export interface EmailConnectionDto {
  EMAIL_FROM: string;
  EMAIL_HOST: string;
  EMAIL_PORT: string;
  EMAIL_AUTH_USER: string;
  EMAIL_AUTH_PASSWORD: string;
}

export interface TestEmailDto {
  email_conection: EmailConnectionDto | string;
}
