import {
  Controller,
  Post,
  Body,
  HttpStatus,
  HttpException,
  UsePipes,
  ValidationPipe,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { EmailService, EmailConfig } from './email.service';

@Controller('email')
export class EmailController {
  constructor(private readonly emailService: EmailService) {}

  @Post('test')
  @UseInterceptors(FileInterceptor('none')) // Interceptor vazio para processar FormData
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async testEmailConnection(@Body() body: any) {
    try {
      // Log para debug
      console.log('Received body:', body);

      let emailConnection: any;

      // Se os campos vieram direto no body (FormData flat)
      if (body.EMAIL_HOST) {
        emailConnection = {
          EMAIL_FROM: body.EMAIL_FROM,
          EMAIL_HOST: body.EMAIL_HOST,
          EMAIL_PORT: body.EMAIL_PORT,
          EMAIL_AUTH_USER: body.EMAIL_AUTH_USER,
          EMAIL_AUTH_PASSWORD: body.EMAIL_AUTH_PASSWORD,
        };
      }
      // Se veio com wrapper email_conection como string
      else if (typeof body.email_conection === 'string') {
        try {
          emailConnection = JSON.parse(body.email_conection);
        } catch {
          throw new HttpException(
            'Invalid JSON in email_conection field',
            HttpStatus.BAD_REQUEST,
          );
        }
      }
      // Se veio com wrapper email_conection como objeto
      else if (body.email_conection) {
        emailConnection = body.email_conection;
      } else {
        throw new HttpException(
          'Missing email configuration. Expected EMAIL_HOST, EMAIL_AUTH_USER, etc.',
          HttpStatus.BAD_REQUEST,
        );
      }

      if (
        !emailConnection?.EMAIL_HOST ||
        !emailConnection?.EMAIL_AUTH_USER ||
        !emailConnection?.EMAIL_AUTH_PASSWORD
      ) {
        throw new HttpException(
          'Missing required fields: EMAIL_HOST, EMAIL_AUTH_USER, and EMAIL_AUTH_PASSWORD are required',
          HttpStatus.BAD_REQUEST,
        );
      }

      const port = parseInt(emailConnection.EMAIL_PORT || '587', 10);
      const config: EmailConfig = {
        host: emailConnection.EMAIL_HOST,
        port: port,
        secure: port === 465,
        auth: {
          user: emailConnection.EMAIL_AUTH_USER,
          pass: emailConnection.EMAIL_AUTH_PASSWORD,
        },
        from: emailConnection.EMAIL_FROM,
      };

      const result = await this.emailService.testConnection(config);

      if (result.success) {
        return {
          success: true,
          message: 'Email connection test successful',
        };
      } else {
        throw new HttpException(
          {
            success: false,
            error: result.error,
          },
          HttpStatus.BAD_REQUEST,
        );
      }
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          success: false,
          error:
            error instanceof Error ? error.message : 'Unknown error occurred',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
