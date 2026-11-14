import { testDb } from './db';

/**
 * Factories mínimas para o fluxo financeiro. Cada uma cria só o que o
 * checkout realmente exige, com overrides para o caso sob teste.
 */

let cnpjSeq = 0;
let sellerSeq = 0;
const nextCnpj = () => String(10000000000000 + ++cnpjSeq);

export async function makeCompany(overrides: Record<string, any> = {}) {
  return testDb().company.create({
    data: {
      cnpj: nextCnpj(),
      comercial_name: 'WorkSafe Teste',
      corporate_name: 'WorkSafe Teste LTDA',
      lp_domain: 'teste.local',
      ...overrides,
    },
  });
}

/** Gateway ativo da empresa. O `payload.token` é o que o AsaasService resolve. */
export async function makeGateway(
  companyId: number,
  overrides: Record<string, any> = {},
) {
  return testDb().companyGateWays.create({
    data: {
      companyId,
      gateway: 'asaas',
      payload: { token: 'tok_teste_asaas', webhookId: 'wh_teste' },
      active: true,
      ...overrides,
    },
  });
}

export async function makeCourse(
  companyId: number,
  overrides: Record<string, any> = {},
) {
  return testDb().course.create({
    data: {
      name: 'NR-35 Trabalho em Altura',
      companyId,
      gradeTheory: 'Conteúdo teórico',
      gradePracticle: 'Conteúdo prático',
      hoursDuration: 8,
      ...overrides,
    },
  });
}

/**
 * Turma pronta para checkout. Os defaults refletem o caminho feliz:
 * checkout habilitado, inscrições abertas, os três métodos aceitos.
 */
export async function makeCourseClass(
  companyId: number,
  courseId: number,
  overrides: Record<string, any> = {},
) {
  return testDb().courseClass.create({
    data: {
      name: 'Turma Teste',
      companyId,
      courseId,
      price: 500.0,
      dividedIn: 12,
      allowCheckout: true,
      allowSubscriptions: true,
      unlimitedSubscriptions: true,
      paymentMethods: ['pix', 'boleto', 'cartaoCredito'],
      periodSubscriptionsType: 'UNLIMITED',
      periodClass: 'UNLIMITED',
      ...overrides,
    },
  });
}

/** Cenário completo em uma chamada: empresa + gateway + curso + turma. */
export async function makeCheckoutScenario(
  classOverrides: Record<string, any> = {},
) {
  const company = await makeCompany();
  const gateway = await makeGateway(company.id);
  const course = await makeCourse(company.id);
  const courseClass = await makeCourseClass(
    company.id,
    course.id,
    classOverrides,
  );
  return { company, gateway, course, courseClass };
}

export async function makeCoupon(
  companyId: number,
  overrides: Record<string, any> = {},
) {
  return testDb().coupon.create({
    data: {
      companyId,
      code: 'DESCONTO10',
      discountType: 'percentage',
      discountValue: 10,
      active: true,
      ...overrides,
    },
  });
}

/** Vendedor: um usuário marcado como vendedor. A carteira nasce na primeira comissão. */
export async function makeSeller(
  companyId: number,
  overrides: Record<string, any> = {},
) {
  return testDb().user.create({
    data: {
      name: 'Vendedor Teste',
      email: `vendedor${++sellerSeq}@teste.local`,
      password: 'hash-irrelevante-para-checkout',
      phone: '81988887777',
      cpf: String(90000000000 + sellerSeq),
      companyId,
      isSeller: true,
      sellerStatus: 'ACTIVE',
      ...overrides,
    },
  });
}
