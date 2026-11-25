import { clean, dateTimeBr, digits, money, rate, xmlText } from './fiscal.utils';

/**
 * Montagem da DPS (Declaração de Prestação de Serviço), leiaute 1.01 do Anexo I
 * do Portal NFS-e, para emissão pelo próprio prestador (tpEmit = 1).
 *
 * Função pura: recebe os dados já conferidos e devolve o XML sem assinatura.
 * A ordem dos elementos segue o XSD (TCInfDPS); qualquer troca de ordem é
 * rejeitada pelo esquema.
 */

export const DPS_VERSION = '1.01';
export const APP_VERSION = 'WorkSafe-1.0';

export interface DpsAddress {
  ibge: string; // município (7 dígitos)
  cep: string;
  street: string;
  number: string;
  complement?: string | null;
  district: string;
}

export interface DpsTaker {
  document: string; // CPF ou CNPJ
  name: string;
  municipalRegistration?: string | null;
  address?: DpsAddress | null;
  phone?: string | null;
  email?: string | null;
}

export interface DpsFederal {
  inss?: number; // vRetCP: contribuição previdenciária retida (R$)
  ir?: number; // vRetIRRF (R$)
  csll?: number; // vRetCSLL (R$)
  // PIS e COFINS retidos vão por alíquota: o ambiente nacional confere vPis = base × alíquota (E0694/E0696)
  pisRate?: number;
  cofinsRate?: number;
  pisCofinsCst?: string; // CST do PIS/COFINS (pergunta para o contador; padrão 49 no Simples)
}

export interface DpsInput {
  environment: 'restrita' | 'producao';
  issuedAt: Date;
  series: string;
  number: number;
  competence: string; // AAAA-MM-DD
  emitterIbge: string; // município do prestador (cLocEmi)
  provider: {
    cnpj: string;
    municipalRegistration?: string | null;
    simplesNacional: number; // 1, 2 ou 3
    simplesRegime?: number | null;
    specialRegime: number;
  };
  taker?: DpsTaker | null;
  service: {
    placeIbge: string; // local da prestação
    nationalCode: string; // cTribNac (6 dígitos)
    municipalCode?: string | null;
    description: string; // xDescServ
    nbs?: string | null;
    internalCode?: string | null;
  };
  info?: { reference?: string | null; order?: string | null; notes?: string | null };
  values: {
    gross: number;
    unconditionalDiscount?: number;
    issTaxation: number; // tribISSQN
    issWithheld: boolean;
    issRate?: number | null; // só vai no XML quando informada
    federal?: DpsFederal;
    simplesTotalRate?: number | null; // pTotTribSN (% aproximado dos tributos no Simples)
  };
  substitutes?: { accessKey: string; reason: string; description?: string } | null;
}

/** Valores do grupo PIS/COFINS e o tipo de retenção (TSTipoRetPISCofins). Nulo = grupo não vai. */
export function pisCofinsOf(base: number, fed: DpsFederal): { base: number; pis: number; cofins: number; retentionType: number } | null {
  const pis = fed.pisRate && fed.pisRate > 0 ? Math.round(base * fed.pisRate) / 100 : 0;
  const cofins = fed.cofinsRate && fed.cofinsRate > 0 ? Math.round(base * fed.cofinsRate) / 100 : 0;
  const csll = !!fed.csll && fed.csll > 0;
  if (!pis && !cofins) return null;
  // 3 = PIS/COFINS/CSLL retidos; 1 = PIS/COFINS retidos; 5 = só PIS; 6 = só COFINS
  const retentionType = pis && cofins ? (csll ? 3 : 1) : pis ? 5 : 6;
  return { base, pis, cofins, retentionType };
}

/** Id da DPS: "DPS" + município (7) + tipo de inscrição (1 CPF, 2 CNPJ) + inscrição (14) + série (5) + número (15). */
export function dpsIdOf(emitterIbge: string, document: string, series: string, number: number): string {
  const doc = digits(document);
  const type = doc.length === 11 ? '1' : '2';
  return `DPS${digits(emitterIbge).padStart(7, '0')}${type}${doc.padStart(14, '0')}${digits(series).padStart(5, '0')}${String(number).padStart(15, '0')}`;
}

const el = (name: string, value: unknown) => `<${name}>${xmlText(value)}</${name}>`;
const opt = (name: string, value: unknown) => (value === undefined || value === null || value === '' ? '' : el(name, value));

function documentEl(document: string): string {
  const doc = digits(document);
  return doc.length === 11 ? el('CPF', doc) : el('CNPJ', doc);
}

function addressEl(address: DpsAddress): string {
  return (
    '<end>' +
    `<endNac>${el('cMun', digits(address.ibge))}${el('CEP', digits(address.cep))}</endNac>` +
    el('xLgr', clean(address.street, 255)) +
    el('nro', clean(address.number, 60) || 'S/N') +
    opt('xCpl', clean(address.complement, 156)) +
    el('xBairro', clean(address.district, 60)) +
    '</end>'
  );
}

export function buildDps(input: DpsInput): { id: string; xml: string } {
  const id = dpsIdOf(input.emitterIbge, input.provider.cnpj, input.series, input.number);
  const v = input.values;
  const fed = v.federal ?? {};
  const has = (n?: number) => typeof n === 'number' && n > 0;

  const prest =
    '<prest>' +
    documentEl(input.provider.cnpj) +
    opt('IM', clean(input.provider.municipalRegistration, 15)) +
    '<regTrib>' +
    el('opSimpNac', input.provider.simplesNacional) +
    // obrigatório para ME/EPP (E0166) e proibido para os outros (E0162)
    (input.provider.simplesNacional === 3 ? el('regApTribSN', input.provider.simplesRegime || 1) : '') +
    el('regEspTrib', input.provider.specialRegime ?? 0) +
    '</regTrib>' +
    '</prest>';

  const t = input.taker;
  const toma = t
    ? '<toma>' +
      documentEl(t.document) +
      opt('IM', clean(t.municipalRegistration, 15)) +
      el('xNome', clean(t.name, 300)) +
      (t.address ? addressEl(t.address) : '') +
      opt('fone', digits(t.phone).length >= 6 ? digits(t.phone).slice(0, 20) : '') +
      opt('email', clean(t.email, 80)) +
      '</toma>'
    : '';

  const info = input.info ?? {};
  const infoCompl =
    info.reference || info.order || info.notes
      ? '<infoCompl>' + opt('docRef', clean(info.reference, 255)) + opt('xPed', clean(info.order, 60)) + opt('xInfComp', clean(info.notes, 2000)) + '</infoCompl>'
      : '';

  const serv =
    '<serv>' +
    `<locPrest>${el('cLocPrestacao', digits(input.service.placeIbge))}</locPrest>` +
    '<cServ>' +
    el('cTribNac', digits(input.service.nationalCode).padStart(6, '0')) +
    opt('cTribMun', clean(input.service.municipalCode, 3)) +
    el('xDescServ', clean(input.service.description, 2000)) +
    opt('cNBS', digits(input.service.nbs)) +
    opt('cIntContrib', clean(input.service.internalCode, 20)) +
    '</cServ>' +
    infoCompl +
    '</serv>';

  const discount = v.unconditionalDiscount && v.unconditionalDiscount > 0 ? `<vDescCondIncond>${el('vDescIncond', money(v.unconditionalDiscount))}</vDescCondIncond>` : '';

  const tribMun =
    '<tribMun>' +
    el('tribISSQN', v.issTaxation) +
    el('tpRetISSQN', v.issWithheld ? 2 : 1) +
    (typeof v.issRate === 'number' && v.issRate > 0 ? el('pAliq', rate(v.issRate)) : '') +
    '</tribMun>';

  let piscofins = '';
  const pisCofins = pisCofinsOf(v.gross - (v.unconditionalDiscount ?? 0), fed);
  if (pisCofins) {
    piscofins =
      '<piscofins>' +
      el('CST', fed.pisCofinsCst || '49') +
      el('vBCPisCofins', money(pisCofins.base)) +
      (pisCofins.pis ? el('pAliqPis', rate(fed.pisRate!)) : '') +
      (pisCofins.cofins ? el('pAliqCofins', rate(fed.cofinsRate!)) : '') +
      (pisCofins.pis ? el('vPis', money(pisCofins.pis)) : '') +
      (pisCofins.cofins ? el('vCofins', money(pisCofins.cofins)) : '') +
      el('tpRetPisCofins', pisCofins.retentionType) +
      '</piscofins>';
  }
  const tribFedInner = piscofins + (has(fed.inss) ? el('vRetCP', money(fed.inss!)) : '') + (has(fed.ir) ? el('vRetIRRF', money(fed.ir!)) : '') + (has(fed.csll) ? el('vRetCSLL', money(fed.csll!)) : '');
  const tribFed = tribFedInner ? `<tribFed>${tribFedInner}</tribFed>` : '';

  // ME/EPP: indTotTrib é proibido (E0712); vai o % aproximado dos tributos do Simples
  const totTrib =
    input.provider.simplesNacional === 3
      ? `<totTrib>${el('pTotTribSN', rate(v.simplesTotalRate ?? 0))}</totTrib>`
      : `<totTrib>${el('indTotTrib', 0)}</totTrib>`;

  const valores = '<valores>' + `<vServPrest>${el('vServ', money(v.gross))}</vServPrest>` + discount + `<trib>${tribMun}${tribFed}${totTrib}</trib>` + '</valores>';

  const subst = input.substitutes
    ? '<subst>' + el('chSubstda', digits(input.substitutes.accessKey)) + el('cMotivo', input.substitutes.reason) + opt('xMotivo', clean(input.substitutes.description, 255)) + '</subst>'
    : '';

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="${DPS_VERSION}">` +
    `<infDPS Id="${id}">` +
    el('tpAmb', input.environment === 'producao' ? 1 : 2) +
    el('dhEmi', dateTimeBr(input.issuedAt)) +
    el('verAplic', APP_VERSION) +
    el('serie', digits(input.series)) +
    el('nDPS', input.number) +
    el('dCompet', input.competence) +
    el('tpEmit', 1) +
    el('cLocEmi', digits(input.emitterIbge)) +
    subst +
    prest +
    toma +
    serv +
    valores +
    '</infDPS>' +
    '</DPS>';
  return { id, xml };
}

/** Pedido de registro do evento de cancelamento (e101101). */
export function buildCancelEvent(input: {
  environment: 'restrita' | 'producao';
  authorDocument: string;
  accessKey: string;
  reasonCode: 1 | 2 | 9;
  reason: string;
  at?: Date;
}): { id: string; xml: string } {
  const id = `PRE${digits(input.accessKey)}101101`;
  const doc = digits(input.authorDocument);
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<pedRegEvento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="${DPS_VERSION}">` +
    `<infPedReg Id="${id}">` +
    el('tpAmb', input.environment === 'producao' ? 1 : 2) +
    el('verAplic', APP_VERSION) +
    el('dhEvento', dateTimeBr(input.at ?? new Date())) +
    (doc.length === 11 ? el('CPFAutor', doc) : el('CNPJAutor', doc)) +
    el('chNFSe', digits(input.accessKey)) +
    '<e101101>' +
    el('xDesc', 'Cancelamento de NFS-e') +
    el('cMotivo', input.reasonCode) +
    el('xMotivo', clean(input.reason, 255)) +
    '</e101101>' +
    '</infPedReg>' +
    '</pedRegEvento>';
  return { id, xml };
}
