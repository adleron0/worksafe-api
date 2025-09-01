import { GenericService } from 'src/features/generic/generic.service';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { getExpirationDate } from 'src/utils/dataFunctions';
import { makeVariablesToReplace } from 'src/helpers/makeVariablesToReplace';
import { EmailService } from 'src/features/email/email.service';
import { getCertificateEmailTemplate } from './templates/certificate-email.template';

@Injectable()
export class TraineeCertificateService extends GenericService<
  CreateDto,
  UpdateDto,
  IEntity
> {
  constructor(
    protected prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {
    super(prisma, null);
  }

  /**
   * Gera certificados para alunos de uma turma
   * @param classId - ID da turma
   * @param companyId - ID da empresa
   * @param subscriptionId - (Opcional) ID de uma subscription específica para gerar apenas um certificado
   * @returns Objeto com informações sobre os certificados gerados
   */
  async generateCertificates(
    classId: number,
    companyId: number,
    subscriptionId?: number,
  ) {
    try {
      // Buscar a turma com todas as informações necessárias
      const classData = await this.prisma.selectFirst('courseClass', {
        where: {
          id: classId,
          inactiveAt: null,
        },
        include: {
          course: true,
          certificate: true,
          instructors: {
            include: {
              instructor: true,
            },
          },
        },
      });

      if (!classData) {
        throw new NotFoundException('Turma não encontrada');
      }

      if (!classData.certificate) {
        throw new BadRequestException(
          'Turma não possui certificado configurado',
        );
      }

      // Buscar as subscriptions - filtra por ID específico se fornecido
      const subscriptionWhere: any = {
        classId: classId,
        subscribeStatus: 'confirmed',
        inactiveAt: null,
      };

      if (subscriptionId) {
        subscriptionWhere.id = subscriptionId;
      }

      const subscriptions = await this.prisma.select(
        'courseClassSubscription',
        {
          where: subscriptionWhere,
          include: {
            trainee: {
              include: {
                city: true,
                state: true,
              },
            },
          },
        },
      );

      if (!subscriptions || subscriptions.length === 0) {
        throw new BadRequestException(
          subscriptionId
            ? 'Inscrição não encontrada ou não confirmada'
            : 'Turma não possui alunos confirmados',
        );
      }

      // Preparar dados dos certificados
      const certificatesData = [];
      const skippedStudents = [];

      for (const subscription of subscriptions) {
        // Verificar se o aluno já possui certificado para esta turma
        const existingCertificate = await this.prisma.selectFirst(
          'traineeCourseCertificate',
          {
            where: {
              traineeId: subscription.traineeId,
              classId: classId,
              inactiveAt: null,
            },
          },
        );

        if (existingCertificate) {
          skippedStudents.push({
            traineeId: subscription.traineeId,
            traineeName: subscription.trainee.name,
            reason: 'Já possui certificado',
          });
          continue;
        }

        // Se a turma requer exame, verificar se o aluno foi aprovado
        if (classData.allowExam) {
          const examResult = await this.prisma.selectFirst('courseClassExam', {
            where: {
              traineeId: subscription.traineeId,
              classId: classId,
              result: true, // Apenas aprovados
              inactiveAt: null,
            },
          });

          if (!examResult) {
            skippedStudents.push({
              traineeId: subscription.traineeId,
              traineeName: subscription.trainee.name,
              reason: 'Não foi aprovado no exame ou exame não realizado',
            });
            continue;
          }
        }

        // Calcular data de vencimento
        const expirationDate = getExpirationDate(
          classData.course.yearOfValidation,
        );

        // Preparar dados da subscription com estrutura completa
        const subscriptionWithFullData = {
          ...subscription,
          class: {
            ...classData,
            course: classData.course,
            instructors: classData.instructors,
          },
        };

        // Gerar variáveis para substituição
        const variablesToReplace = makeVariablesToReplace(
          subscriptionWithFullData,
          expirationDate,
        );

        // Adicionar dados do certificado ao array
        certificatesData.push({
          fabricJsonFront: classData.certificate.fabricJsonFront,
          fabricJsonBack: classData.certificate.fabricJsonBack,
          courseId: classData.courseId,
          traineeId: subscription.traineeId,
          classId: classId,
          expirationDate: expirationDate,
          variableToReplace: variablesToReplace,
          companyId: companyId,
          showOnWebsiteConsent: subscription.showOnWebsiteConsent || true,
        });
      }

      // Se não há certificados para gerar
      if (certificatesData.length === 0) {
        return {
          success: true,
          message: subscriptionId
            ? 'Certificado não pode ser gerado'
            : 'Nenhum certificado novo para gerar',
          data: {
            classId: classId,
            className: classData.name,
            courseName: classData.course.name,
            totalStudents: subscriptions.length,
            newCertificates: 0,
            skippedStudents: skippedStudents,
          },
        };
      }

      // Inserir certificados
      const logParams = {
        userId: 0, // Sistema
        companyId: companyId,
      };

      if (certificatesData.length === 1) {
        // Inserir único certificado
        await this.prisma.insert(
          'traineeCourseCertificate',
          certificatesData[0],
          logParams,
        );
      } else {
        // Inserir múltiplos certificados
        await this.prisma.bulkInsert(
          'traineeCourseCertificate',
          certificatesData,
        );
      }

      return {
        success: true,
        message: `${certificatesData.length} certificado(s) gerado(s) com sucesso`,
        data: {
          classId: classId,
          className: classData.name,
          courseName: classData.course.name,
          totalStudents: subscriptions.length,
          newCertificates: certificatesData.length,
          skippedStudents: skippedStudents,
        },
      };
    } catch (error) {
      console.log(
        '🚀 ~ TraineeCertificateService ~ generateCertificates ~ error:',
        error,
      );
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
      throw new BadRequestException('Erro ao gerar certificados');
    }
  }

  /**
   * Envia certificado por email para o aluno
   * @param traineeId - ID do aluno
   * @param certificateKey - Chave do certificado
   * @returns Mensagem de sucesso ou erro
   */
  async sendCertificateByEmail(
    traineeId: number,
    certificateKey: string,
  ) {
    console.log(`[CERTIFICATE EMAIL] Iniciando envio de certificado para trainee ID: ${traineeId}, Key: ${certificateKey}`);
    
    try {
      // Buscar dados do trainee
      console.log(`[CERTIFICATE EMAIL] Buscando dados do trainee ID: ${traineeId}`);
      const trainee = await this.prisma.selectFirst('trainee', {
        where: { id: traineeId },
        include: {
          subscription: {
            include: {
              class: {
                include: {
                  course: true,
                },
              },
            },
          },
        },
      });

      if (!trainee) {
        console.error(`[CERTIFICATE EMAIL] Erro: Trainee ${traineeId} não encontrado`);
        throw new HttpException('Aluno não encontrado', HttpStatus.NOT_FOUND);
      }
      console.log(`[CERTIFICATE EMAIL] Trainee encontrado: ${trainee.name}`);

      if (!trainee.email) {
        console.error(`[CERTIFICATE EMAIL] Erro: Trainee ${trainee.name} não possui email cadastrado`);
        throw new HttpException(
          'Aluno não possui email cadastrado',
          HttpStatus.BAD_REQUEST,
        );
      }
      console.log(`[CERTIFICATE EMAIL] Email do trainee: ${trainee.email}`);

      // Buscar dados da empresa
      console.log(`[CERTIFICATE EMAIL] Buscando dados da empresa ID: ${trainee.companyId}`);
      const company = await this.prisma.selectFirst('company', {
        where: { id: trainee.companyId },
      });

      if (!company) {
        console.error(`[CERTIFICATE EMAIL] Erro: Empresa ${trainee.companyId} não encontrada`);
        throw new HttpException('Empresa não encontrada', HttpStatus.NOT_FOUND);
      }
      console.log(`[CERTIFICATE EMAIL] Empresa encontrada:`, company);
      console.log(`[CERTIFICATE EMAIL] Nome comercial: ${company.comercial_name || 'NÃO ENCONTRADO'}`);
      console.log(`[CERTIFICATE EMAIL] Razão social: ${company.corporate_name || 'NÃO ENCONTRADO'}`);

      // Verificar se a empresa tem configuração de email
      if (!company.email_conection) {
        console.error(`[CERTIFICATE EMAIL] Erro: Empresa ${company.comercial_name} não possui configuração de email`);
        throw new HttpException(
          'Empresa não possui configuração de email cadastrada',
          HttpStatus.BAD_REQUEST,
        );
      }
      console.log(`[CERTIFICATE EMAIL] Configuração de email encontrada para empresa ${company.comercial_name}`);

      // Parse da configuração de email
      let emailConfig: any;
      console.log(`[CERTIFICATE EMAIL] Fazendo parse da configuração de email`);
      try {
        emailConfig =
          typeof company.email_conection === 'string'
            ? JSON.parse(company.email_conection)
            : company.email_conection;
        console.log(`[CERTIFICATE EMAIL] Parse realizado com sucesso`);
      } catch (parseError) {
        console.error(`[CERTIFICATE EMAIL] Erro ao fazer parse da configuração de email:`, parseError);
        throw new HttpException(
          'Configuração de email da empresa inválida',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      // Validar configuração de email
      console.log(`[CERTIFICATE EMAIL] Validando configuração de email`);
      if (
        !emailConfig.EMAIL_HOST ||
        !emailConfig.EMAIL_AUTH_USER ||
        !emailConfig.EMAIL_AUTH_PASSWORD
      ) {
        console.error(`[CERTIFICATE EMAIL] Erro: Configuração de email incompleta`, {
          host: !!emailConfig.EMAIL_HOST,
          user: !!emailConfig.EMAIL_AUTH_USER,
          pass: !!emailConfig.EMAIL_AUTH_PASSWORD
        });
        throw new HttpException(
          'Configuração de email da empresa incompleta',
          HttpStatus.BAD_REQUEST,
        );
      }
      console.log(`[CERTIFICATE EMAIL] Configuração validada - Host: ${emailConfig.EMAIL_HOST}, User: ${emailConfig.EMAIL_AUTH_USER}`);

      // Inicializar o serviço de email com as configurações da empresa
      const port = parseInt(emailConfig.EMAIL_PORT || '587', 10);
      console.log(`[CERTIFICATE EMAIL] Inicializando serviço de email na porta ${port}`);
      this.emailService.initialize({
        host: emailConfig.EMAIL_HOST,
        port: port,
        secure: port === 465,
        auth: {
          user: emailConfig.EMAIL_AUTH_USER,
          pass: emailConfig.EMAIL_AUTH_PASSWORD,
        },
        from: emailConfig.EMAIL_FROM || emailConfig.EMAIL_AUTH_USER,
      });

      // Montar URL do certificado
      console.log(`[CERTIFICATE EMAIL] Montando URL do certificado`);
      const systemDomain = company.system_domain || 'sistema.worksafebrasil.com.br';
      const certificateUrl = `https://${systemDomain}/certificados/${certificateKey}`;
      console.log(`[CERTIFICATE EMAIL] URL do certificado: ${certificateUrl}`);

      // Preparar dados para o template
      console.log(`[CERTIFICATE EMAIL] Preparando dados para o template de email`);
      const courseName =
        trainee.subscription?.[0]?.class?.course?.name || 'Curso';
      const certificateDate = new Date().toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
      });
      console.log(`[CERTIFICATE EMAIL] Curso: ${courseName}, Data: ${certificateDate}`);

      // Gerar HTML do email
      console.log(`[CERTIFICATE EMAIL] Gerando template HTML do email`);
      console.log(`[CERTIFICATE EMAIL] Dados da empresa para template:`, {
        comercial_name: company.comercial_name,
        corporate_name: company.corporate_name,
        logoUrl: company.logoUrl,
        primary_color: company.primary_color,
        secondary_color: company.secondary_color,
        system_domain: company.system_domain
      });
      
      const htmlContent = getCertificateEmailTemplate({
        companyName: company.comercial_name || company.corporate_name || 'Empresa',
        logoUrl: company.logoUrl,
        primaryColor: company.primary_color,
        secondaryColor: company.secondary_color,
        traineeName: trainee.name,
        courseName: courseName,
        certificateDate: certificateDate,
        certificateUrl: certificateUrl,
      });

      // Enviar email com link do certificado
      const emailData = {
        from: emailConfig.EMAIL_FROM || emailConfig.EMAIL_AUTH_USER,
        to: trainee.email,
        subject: `Seu Certificado - ${courseName} | ${company.comercial_name || company.corporate_name || 'Empresa'}`,
        html: htmlContent,
      };
      
      console.log(`[CERTIFICATE EMAIL] Enviando email para: ${emailData.to}`);
      console.log(`[CERTIFICATE EMAIL] Assunto: ${emailData.subject}`);
      console.log(`[CERTIFICATE EMAIL] Link do certificado: ${certificateUrl}`);
      
      await this.emailService.sendEmail(emailData);
      
      console.log(`[CERTIFICATE EMAIL] ✅ Email enviado com sucesso para ${trainee.email}`);

      return {
        success: true,
        message: `Certificado enviado com sucesso para ${trainee.email}`,
      };
    } catch (error) {
      console.error(`[CERTIFICATE EMAIL] ❌ Erro ao enviar certificado:`, error);
      
      if (error instanceof HttpException) {
        throw error;
      }
      
      console.error(`[CERTIFICATE EMAIL] Erro detalhado:`, {
        message: error.message,
        stack: error.stack,
        name: error.name
      });
      
      throw new HttpException(
        `Erro ao enviar certificado: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
