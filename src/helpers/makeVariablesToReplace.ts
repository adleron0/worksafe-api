import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

export function makeVariablesToReplace(
  subscriptionData: any,
  expirationDate?: Date | string | null,
): any {
  const variables: any = {};

  // Validação e extração de dados seguros
  const trainee = subscriptionData?.trainee;
  const classData = subscriptionData?.class;
  const course = classData?.course;
  const instructors = classData?.instructors;

  // Dados do Aluno
  if (trainee) {
    if (trainee.name) {
      variables.aluno_nome = {
        type: 'string',
        value: trainee.name.toUpperCase(),
      };
    }

    if (trainee.cpf) {
      variables.aluno_cpf = {
        type: 'string',
        value: trainee.cpf,
      };
    }

    // if (trainee.email) {
    //   variables.aluno_email = {
    //     type: 'string',
    //     value: trainee.email,
    //   };
    // }

    // if (trainee.phone) {
    //   variables.aluno_telefone = {
    //     type: 'string',
    //     value: trainee.phone,
    //   };
    // }

    if (trainee.birthDate) {
      try {
        const birthDate =
          typeof trainee.birthDate === 'string'
            ? new Date(trainee.birthDate)
            : trainee.birthDate;

        variables.aluno_data_nascimento = {
          type: 'string',
          value: format(birthDate, 'dd/MM/yyyy', { locale: ptBR }),
        };
      } catch (e) {
        variables.aluno_data_nascimento = {
          type: 'string',
          value: '',
        };
      }
    }

    // Endereço do aluno
    const enderecoParts = [];
    // if (trainee.address) enderecoParts.push(trainee.address);
    // if (trainee.addressNumber)
    //   enderecoParts.push(`nº ${trainee.addressNumber}`);
    // if (trainee.complement) enderecoParts.push(trainee.complement);

    // if (enderecoParts.length > 0) {
    //   variables.aluno_endereco_completo = {
    //     type: 'string',
    //     value: enderecoParts.join(', '),
    //   };
    // }

    if (trainee.city?.name) {
      variables.aluno_cidade = {
        type: 'string',
        value: trainee.city.name,
      };
    }

    if (trainee.state?.name) {
      variables.aluno_estado = {
        type: 'string',
        value: trainee.state.name,
      };
    }

    if (trainee.state?.uf) {
      variables.aluno_estado_uf = {
        type: 'string',
        value: trainee.state.uf,
      };
    }

    // Foto do aluno
    if (trainee.imageUrl) {
      variables.aluno_foto = {
        type: 'url',
        value: trainee.imageUrl,
      };
    }
  }

  // Dados do Curso
  if (course) {
    if (course.name) {
      variables.curso_nome = {
        type: 'string',
        value: course.name.toUpperCase(),
      };
    }

    if (course.description) {
      variables.curso_descricao = {
        type: 'string',
        value: course.description,
      };
    }

    if (course.yearOfValidation) {
      variables.curso_validade_anos = {
        type: 'number',
        value: course.yearOfValidation,
      };
    }
  }

  // Dados da Turma
  if (classData) {
    if (classData.name) {
      variables.turma_nome = {
        type: 'string',
        value: classData.name,
      };
    }

    if (classData.hoursDuration) {
      variables.turma_carga_horaria = {
        type: 'string',
        value: `${classData.hoursDuration} horas`,
      };
    }

    if (classData.initialDate) {
      try {
        const initialDate =
          typeof classData.initialDate === 'string'
            ? new Date(classData.initialDate)
            : classData.initialDate;

        variables.turma_data_inicio = {
          type: 'string',
          value: format(initialDate, 'dd/MM/yyyy', { locale: ptBR }),
        };

        variables.turma_data_inicio_extenso = {
          type: 'string',
          value: format(initialDate, "dd 'de' MMMM 'de' yyyy", {
            locale: ptBR,
          }),
        };
      } catch (e) {
        variables.turma_data_inicio = {
          type: 'string',
          value: '',
        };
        variables.turma_data_inicio_extenso = {
          type: 'string',
          value: '',
        };
      }
    }

    if (classData.finalDate) {
      try {
        const finalDate =
          typeof classData.finalDate === 'string'
            ? new Date(classData.finalDate)
            : classData.finalDate;

        variables.turma_data_fim = {
          type: 'string',
          value: format(finalDate, 'dd/MM/yyyy', { locale: ptBR }),
        };

        variables.turma_data_fim_extenso = {
          type: 'string',
          value: format(finalDate, "dd 'de' MMMM 'de' yyyy", { locale: ptBR }),
        };
      } catch (e) {
        variables.turma_data_fim = {
          type: 'string',
          value: '',
        };
        variables.turma_data_fim_extenso = {
          type: 'string',
          value: '',
        };
      }
    }

    // Período completo da turma
    if (classData.initialDate && classData.finalDate) {
      try {
        const initialDate =
          typeof classData.initialDate === 'string'
            ? new Date(classData.initialDate)
            : classData.initialDate;
        const finalDate =
          typeof classData.finalDate === 'string'
            ? new Date(classData.finalDate)
            : classData.finalDate;

        variables.turma_periodo = {
          type: 'string',
          value: `${format(initialDate, 'dd/MM/yyyy')} a ${format(finalDate, 'dd/MM/yyyy')}`,
        };
      } catch (e) {
        variables.turma_periodo = {
          type: 'string',
          value: '',
        };
      }
    }
  }

  // Dados do(s) Instrutor(es)
  if (instructors && instructors.length > 0) {
    // Primeiro instrutor (principal)
    const mainInstructor = instructors[0]?.instructor || instructors[0];

    if (mainInstructor) {
      if (mainInstructor.name) {
        variables.instrutor_nome = {
          type: 'string',
          value: mainInstructor.name.toUpperCase(),
        };
      }

      // if (mainInstructor.email) {
      //   variables.instrutor_email = {
      //     type: 'string',
      //     value: mainInstructor.email,
      //   };
      // }

      if (mainInstructor.cpf) {
        variables.instrutor_cpf = {
          type: 'string',
          value: mainInstructor.cpf,
        };
      }

      if (mainInstructor.formation) {
        variables.instrutor_formacao = {
          type: 'string',
          value: mainInstructor.formation,
        };
      }

      if (mainInstructor.formationCode) {
        variables.instrutor_registro = {
          type: 'string',
          value: mainInstructor.formationCode,
        };
      }

      if (mainInstructor.signatureUrl) {
        variables.instrutor_assinatura = {
          type: 'url',
          value: mainInstructor.signatureUrl,
        };
      }
    }

    // Lista de todos os instrutores
    const instructorNames = instructors
      .map((inst) => {
        const instructor = inst.instructor || inst;
        return instructor?.name;
      })
      .filter(Boolean)
      .join(', ');

    if (instructorNames) {
      variables.instrutores_nomes = {
        type: 'string',
        value: instructorNames.toUpperCase(),
      };
    }

    // Assinaturas de todos os instrutores (caso precise)
    instructors.forEach((inst, index) => {
      const instructor = inst.instructor || inst;

      if (instructor?.signatureUrl) {
        variables[`instrutor_assinatura_${index + 1}`] = {
          type: 'url',
          value: instructor.signatureUrl,
        };
      }

      if (instructor?.name) {
        variables[`instrutor_nome_${index + 1}`] = {
          type: 'string',
          value: instructor.name.toUpperCase(),
        };
      }

      if (instructor?.formation) {
        variables[`instrutor_formacao_${index + 1}`] = {
          type: 'string',
          value: instructor.formation,
        };
      }

      if (instructor?.formationCode) {
        variables[`instrutor_registro_${index + 1}`] = {
          type: 'string',
          value: instructor.formationCode,
        };
      }
    });
  }

  // Data de Validade do Certificado
  if (expirationDate) {
    try {
      const expDate =
        typeof expirationDate === 'string'
          ? new Date(expirationDate)
          : expirationDate;

      variables.certificado_validade = {
        type: 'string',
        value: format(expDate, 'dd/MM/yyyy', { locale: ptBR }),
      };

      variables.certificado_validade_extenso = {
        type: 'string',
        value: format(expDate, "dd 'de' MMMM 'de' yyyy", { locale: ptBR }),
      };
    } catch (e) {
      variables.certificado_validade = {
        type: 'string',
        value: '',
      };
      variables.certificado_validade_extenso = {
        type: 'string',
        value: '',
      };
    }
  }

  // Data de Emissão (hoje)
  const today = new Date();

  variables.certificado_emissao = {
    type: 'string',
    value: format(today, 'dd/MM/yyyy', { locale: ptBR }),
  };

  variables.certificado_emissao_extenso = {
    type: 'string',
    value: format(today, "dd 'de' MMMM 'de' yyyy", { locale: ptBR }),
  };

  // Código único do certificado (pode ser gerado com base em IDs)
  if (trainee && classData && course) {
    const year = new Date().getFullYear();
    const courseId = String(course.id || 0).padStart(3, '0');
    const traineeId = String(trainee.id || 0).padStart(5, '0');
    const code = `${year}${courseId}${traineeId}`;

    variables.certificado_codigo = {
      type: 'string',
      value: code,
    };
  }

  // Dados da Inscrição
  if (subscriptionData) {
    if (subscriptionData.name) {
      variables.inscricao_nome = {
        type: 'string',
        value: subscriptionData.name,
      };
    }

    if (subscriptionData.occupation) {
      variables.inscricao_ocupacao = {
        type: 'string',
        value: subscriptionData.occupation,
      };
    }

    if (subscriptionData.workedAt) {
      variables.inscricao_empresa = {
        type: 'string',
        value: subscriptionData.workedAt,
      };
    }

    if (subscriptionData.confirmedAt) {
      try {
        const confirmedDate =
          typeof subscriptionData.confirmedAt === 'string'
            ? new Date(subscriptionData.confirmedAt)
            : subscriptionData.confirmedAt;

        variables.inscricao_data_confirmacao = {
          type: 'string',
          value: format(confirmedDate, 'dd/MM/yyyy', { locale: ptBR }),
        };
      } catch (e) {
        variables.inscricao_data_confirmacao = {
          type: 'string',
          value: '',
        };
      }
    }
  }

  return variables;
}
