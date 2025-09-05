import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { Transporter } from 'nodemailer';

export interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: {
    user: string;
    pass: string;
  };
  from?: string;
}

export interface EmailOptions {
  from?: string;
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    content?: string | Buffer;
    path?: string;
    contentType?: string;
  }>;
}

export interface TestConnectionResult {
  success: boolean;
  error?: string;
}

@Injectable()
export class EmailService {
  private transporter: Transporter | null = null;
  private config: EmailConfig | null = null;

  initialize(config: EmailConfig): void {
    this.config = config;
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.auth.user,
        pass: config.auth.pass,
      },
    });
  }

  async sendEmail(options: EmailOptions): Promise<void> {
    if (!this.transporter || !this.config) {
      throw new Error(
        'Email service not initialized. Call initialize() first.',
      );
    }

    const mailOptions = {
      from: options.from || this.config.from || this.config.auth.user,
      to: Array.isArray(options.to) ? options.to.join(', ') : options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
      attachments: options.attachments,
    };

    try {
      await this.transporter.sendMail(mailOptions);
    } catch (error) {
      throw new Error(
        `Failed to send email: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async testConnection(config: EmailConfig): Promise<TestConnectionResult> {
    try {
      const testTransporter = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: {
          user: config.auth.user,
          pass: config.auth.pass,
        },
      });

      await testTransporter.verify();

      return {
        success: true,
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  getTransporter(): Transporter | null {
    return this.transporter;
  }

  isInitialized(): boolean {
    return this.transporter !== null && this.config !== null;
  }
}
