/**
 * Leitura dos poucos campos que o sistema precisa do XML da NFS-e autorizada
 * (leiaute TCInfNFSe). Não é um parser genérico: as tags são únicas no documento
 * fora da DPS, então a busca é feita antes do bloco <DPS>.
 */

const tag = (xml: string, name: string): string | undefined => {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:\\w+:)?${name}>`));
  return m ? decode(m[1].trim()) : undefined;
};

const decode = (text: string) =>
  text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export interface ParsedNfse {
  accessKey?: string;
  number?: string;
  status?: string; // cStat
  processedAt?: string; // dhProc
  issValue?: number;
  issRate?: number;
  netValue?: number;
  totalRetained?: number;
  incidencePlace?: string;
  emitterName?: string;
  taxDescription?: string;
}

export function parseNfseXml(xml: string): ParsedNfse {
  const head = xml.split(/<(?:\w+:)?DPS[\s>]/)[0] ?? xml;
  const id = head.match(/<(?:\w+:)?infNFSe[^>]*\sId="NFS(\d{50})"/);
  const num = (value?: string) => (value === undefined ? undefined : Number(value));
  return {
    accessKey: id?.[1],
    number: tag(head, 'nNFSe'),
    status: tag(head, 'cStat'),
    processedAt: tag(head, 'dhProc'),
    issValue: num(tag(head, 'vISSQN')),
    issRate: num(tag(head, 'pAliqAplic')),
    netValue: num(tag(head, 'vLiq')),
    totalRetained: num(tag(head, 'vTotalRet')),
    incidencePlace: tag(head, 'xLocIncid'),
    emitterName: tag(head, 'xNome'),
    taxDescription: tag(head, 'xTribNac'),
  };
}

/** cStat do evento autorizado (135 = evento registrado). */
export function parseEventXml(xml: string): { status?: string; processedAt?: string } {
  return { status: tag(xml, 'cStat'), processedAt: tag(xml, 'dhProc') };
}

export interface ParsedReceived {
  accessKey?: string;
  number?: string;
  processedAt?: string;
  competence?: string;
  issuerDocument?: string;
  issuerName?: string;
  takerDocument?: string;
  description?: string;
  gross: number;
  net: number;
  issWithheld: boolean;
  issValue: number;
  retentions: { inss: number; ir: number; csll: number; pis: number; cofins: number };
}

/** Lê uma NFS-e recebida (de fornecedor): quem emitiu, quem tomou, valores e retenções. */
export function parseReceivedXml(xml: string): ParsedReceived {
  const head = xml.split(/<(?:\w+:)?DPS[\s>]/)[0] ?? xml;
  const dps = xml.slice(head.length);
  const block = (src: string, name: string) => src.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`))?.[1] ?? '';
  const emit = block(head, 'emit');
  const toma = block(dps, 'toma');
  const id = head.match(/<(?:\w+:)?infNFSe[^>]*\sId="NFS(\d{50})"/);
  const n = (v?: string) => (v ? Number(v) : 0);
  return {
    accessKey: id?.[1],
    number: tag(head, 'nNFSe'),
    processedAt: tag(head, 'dhProc'),
    competence: tag(dps, 'dCompet'),
    issuerDocument: tag(emit, 'CNPJ') ?? tag(emit, 'CPF'),
    issuerName: tag(emit, 'xNome'),
    takerDocument: tag(toma, 'CNPJ') ?? tag(toma, 'CPF'),
    description: tag(dps, 'xDescServ'),
    gross: n(tag(dps, 'vServ')),
    net: n(tag(head, 'vLiq')),
    issWithheld: tag(dps, 'tpRetISSQN') === '2',
    issValue: n(tag(head, 'vISSQN')),
    retentions: { inss: n(tag(dps, 'vRetCP')), ir: n(tag(dps, 'vRetIRRF')), csll: n(tag(dps, 'vRetCSLL')), pis: n(tag(dps, 'vPis')), cofins: n(tag(dps, 'vCofins')) },
  };
}
