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
