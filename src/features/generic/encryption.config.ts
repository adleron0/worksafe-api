// Configuração de campos que devem ser criptografados/ofuscados por entidade
export interface EncryptionConfig {
  [entity: string]: {
    fields?: string[]; // Campos diretos da entidade
    relations?: {
      [relationName: string]: string[]; // Campos das relações
    };
  };
}

// Função para codificar em base64
export function encodeBase64(value: any): string {
  if (value === null || value === undefined) return value;
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

// Função para decodificar base64
export function decodeBase64(value: string): any {
  if (!value) return value;
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf-8'));
  } catch {
    return value; // Retorna o valor original se não conseguir decodificar
  }
}

// Função recursiva para aplicar encriptação em objetos
export function applyEncryption(
  data: any,
  fieldsToEncrypt: string[],
  relationsConfig?: { [key: string]: string[] },
): any {
  if (!data) return data;

  // Se for um array, aplica em cada item
  if (Array.isArray(data)) {
    return data.map((item) =>
      applyEncryption(item, fieldsToEncrypt, relationsConfig),
    );
  }

  // Clona o objeto para não modificar o original
  const result = { ...data };

  // Criptografa campos diretos
  for (const field of fieldsToEncrypt) {
    if (field in result) {
      result[field] = encodeBase64(result[field]);
    }
  }

  // Criptografa campos nas relações
  if (relationsConfig) {
    for (const [relationName, relationFields] of Object.entries(
      relationsConfig,
    )) {
      if (result[relationName]) {
        result[relationName] = applyEncryption(
          result[relationName],
          relationFields,
          undefined,
        );
      }
    }
  }

  return result;
}

// Função para aplicar encriptação dinâmica baseada em campos específicos
export function applyDynamicEncryption(
  data: any,
  fieldsToEncrypt: string[],
): any {
  if (!data) return data;
  if (!fieldsToEncrypt || fieldsToEncrypt.length === 0) return data;

  // Se for um array, aplica em cada item
  if (Array.isArray(data)) {
    return data.map((item) => applyDynamicEncryption(item, fieldsToEncrypt));
  }

  // Clona o objeto para não modificar o original
  const result = { ...data };

  // Processa cada campo a ser encriptado
  for (const fieldPath of fieldsToEncrypt) {
    // Suporta campos aninhados usando notação de ponto
    const pathParts = fieldPath.split('.');

    if (pathParts.length === 1) {
      // Campo direto
      if (fieldPath in result) {
        result[fieldPath] = encodeBase64(result[fieldPath]);
      }
    } else {
      // Campo aninhado (ex: "trainee.cpf")
      let current = result;
      const lastField = pathParts[pathParts.length - 1];

      // Navega até o penúltimo nível
      for (let i = 0; i < pathParts.length - 1; i++) {
        if (current[pathParts[i]]) {
          if (i === pathParts.length - 2) {
            // Chegou no objeto pai do campo
            if (Array.isArray(current[pathParts[i]])) {
              // Se for array, aplica em cada item
              current[pathParts[i]] = current[pathParts[i]].map((item: any) => {
                if (item && lastField in item) {
                  return {
                    ...item,
                    [lastField]: encodeBase64(item[lastField]),
                  };
                }
                return item;
              });
            } else if (current[pathParts[i]][lastField] !== undefined) {
              // Se for objeto, encripta o campo
              current[pathParts[i]] = {
                ...current[pathParts[i]],
                [lastField]: encodeBase64(current[pathParts[i]][lastField]),
              };
            }
          } else {
            current = current[pathParts[i]];
          }
        } else {
          break; // Campo não existe, pula
        }
      }
    }
  }

  return result;
}

// Configuração exemplo - você pode personalizar conforme necessário
export const encryptionConfig: EncryptionConfig = {
  // Exemplo para User
  user: {
    fields: ['password', 'email'], // Campos do user que serão criptografados
    relations: {
      profile: ['phone', 'address'], // Campos do profile relacionado
    },
  },

  // Exemplo para Trainee
  trainee: {
    fields: ['cpf', 'rg'], // Campos sensíveis do trainee
    relations: {
      contact: ['phone', 'emergencyPhone'],
    },
  },

  // Exemplo para TraineeCourseCertificate
  traineeCourseCertificate: {
    fields: ['variableToReplace'], // Pode conter dados sensíveis
    relations: {
      trainee: ['cpf', 'rg'], // Quando incluir trainee, criptografa esses campos
    },
  },

  // Adicione mais entidades conforme necessário
};
