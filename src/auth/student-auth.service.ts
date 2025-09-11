import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from 'src/prisma/prisma.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class StudentAuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async loginStudent(credential: string, password: string) {
    // Busca o aluno por email ou CPF
    const trainee = await this.prisma.trainee.findFirst({
      where: {
        OR: [{ email: credential }, { cpf: credential }],
      },
      select: {
        id: true,
        cpf: true,
        name: true,
        email: true,
        password: true,
        active: true,
        customerId: true,
      },
    });

    if (!trainee || !trainee.active) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    if (!trainee.password) {
      throw new UnauthorizedException('Senha não configurada para este aluno');
    }

    // Validar senha usando bcrypt
    const isPasswordValid = await bcrypt.compare(password, trainee.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    // Payload simplificado para alunos
    const payload = {
      traineeId: trainee.id,
      cpf: trainee.cpf,
      name: trainee.name,
      email: trainee.email,
      customerId: trainee.customerId,
      type: 'student',
    };

    return {
      accessToken: this.jwtService.sign(payload, {
        secret: process.env.JWT_STUDENT_SECRET,
        expiresIn: '7d', // Sessão mais longa para alunos
      }),
      trainee: {
        id: trainee.id,
        name: trainee.name,
        email: trainee.email,
        cpf: trainee.cpf,
      },
    };
  }

  async validateStudentToken(token: string) {
    try {
      const payload = await this.jwtService.verifyAsync(token, {
        secret: process.env.JWT_STUDENT_SECRET,
      });
      return payload;
    } catch {
      throw new UnauthorizedException('Token inválido');
    }
  }

  async getTraineeProfile(traineeId: number) {
    const trainee = await this.prisma.trainee.findUnique({
      where: { id: traineeId },
      select: {
        id: true,
        name: true,
        email: true,
        cpf: true,
        phone: true,
        birthDate: true,
        occupation: true,
        imageUrl: true,
        customerId: true,
        active: true,
      },
    });

    if (!trainee) {
      throw new UnauthorizedException('Aluno não encontrado');
    }

    return trainee;
  }
}
