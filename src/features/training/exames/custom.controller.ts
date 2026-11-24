import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from 'src/auth/decorators/public.decorator';
import { PublicFormFields } from '../public-form';
import { ExamesService } from './service';

/**
 * Registro público de prova. O aluno se identifica por CPF + código da turma
 * (ou pela sessão aberta no validate-student) e a inscrição confirmada é
 * conferida no service. Sem upload: a rota nunca usou o arquivo.
 */
@Controller('exames')
export class ExamesCustomController {
  constructor(private readonly exames: ExamesService) {}
  @Public()
  @Post('register')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @PublicFormFields()
  register(@Body() dto: Record<string, any>) {
    return this.exames.registerExam({ ...dto }, {
      model: 'courseClassExam',
      name: 'Prova',
    } as never);
  }
}
