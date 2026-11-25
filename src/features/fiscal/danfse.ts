import { existsSync } from 'fs';
import { join } from 'path';
import * as QRCode from 'qrcode';
// pdfkit é CommonJS com `module.exports = PDFDocument` (sem esModuleInterop)
import PDFDocument = require('pdfkit');
import { brl } from './invoice.calc';
import { cityOfIbge, digits } from './fiscal.utils';

/**
 * DANFSe: a representação em PDF da NFS-e. Desde 03/08/2026 (NT 008) o
 * ambiente nacional não gera mais o PDF, então cada sistema monta o seu. O
 * documento que vale é o XML; o PDF segue a organização do leiaute da NT 008
 * (cabeçalho com chave e QR Code, emitente, tomador, serviço, valores,
 * tributação e informações complementares).
 */

const FONTS = join(process.cwd(), 'assets', 'fonts');
const consultaUrl = (key: string) => `${process.env.FISCAL_CONSULTA_URL || 'https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave='}${key}`;

export interface DanfseData {
  environment: 'restrita' | 'producao';
  status: string;
  accessKey: string | null;
  number: string | null;
  dpsSeries: string | null;
  dpsNumber: number | null;
  issuedAt: Date | null;
  competence: Date;
  emitter: { name: string; cnpj: string; municipalRegistration?: string | null; address: string; cityName?: string | null; uf?: string | null; email?: string | null; phone?: string | null };
  taker: { document?: string; name?: string; municipalRegistration?: string | null; email?: string | null; phone?: string | null; address?: { street?: string; number?: string; complement?: string | null; district?: string; cep?: string; ibge?: string } | null };
  service: { nationalCode?: string; nationalLabel?: string | null; municipalCode?: string | null; nbsCode?: string | null };
  description: string;
  placeOfService: string;
  values: {
    gross: number; discount: number; base: number; issRate: number | null; issValue: number; issWithheld: boolean;
    federal: { inss: number; ir: number; csll: number; pis: number; cofins: number };
    net: number;
  };
  notes?: string | null;
}

const fmtDoc = (doc?: string) => {
  const d = digits(doc);
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return doc ?? '';
};
const fmtDate = (d: Date | null, withTime = false) =>
  d ? new Intl.DateTimeFormat('pt-BR', withTime ? { timeZone: 'America/Recife', dateStyle: 'short', timeStyle: 'short' } : { timeZone: 'America/Recife', dateStyle: 'short' }).format(d) : '—';
const fmtMonth = (d: Date) => d.toISOString().slice(0, 10).split('-').reverse().join('/');
const cityLabel = (ibge?: string) => {
  if (!ibge) return '—';
  const c = cityOfIbge(ibge);
  return c ? `${c.name}/${c.uf}` : ibge;
};

export async function renderDanfse(data: DanfseData): Promise<Buffer> {
  const qr = data.accessKey ? await QRCode.toBuffer(consultaUrl(data.accessKey), { margin: 0, width: 220 }) : null;
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 28, info: { Title: `NFS-e ${data.number ?? ''}`.trim(), Creator: 'WorkSafe' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const regular = join(FONTS, 'inter-400.ttf');
    const bold = join(FONTS, 'inter-700.ttf');
    const R = existsSync(regular) ? regular : 'Helvetica';
    const B = existsSync(bold) ? bold : 'Helvetica-Bold';
    const W = doc.page.width - 56;
    const X = 28;
    let y = 28;

    const box = (h: number) => { doc.lineWidth(0.6).strokeColor('#9aa3ad').rect(X, y, W, h).stroke(); };
    const label = (text: string, x: number, yy: number) => doc.font(B).fontSize(6.5).fillColor('#5b6570').text(text.toUpperCase(), x, yy, { lineBreak: false });
    const value = (text: string, x: number, yy: number, width: number, size = 8.5) => doc.font(R).fontSize(size).fillColor('#111').text(text || '—', x, yy, { width });
    const section = (title: string) => {
      doc.rect(X, y, W, 13).fill('#eef1f4');
      doc.font(B).fontSize(7.5).fillColor('#222').text(title.toUpperCase(), X + 6, y + 3.5, { lineBreak: false });
      y += 13;
    };
    const grid = (cells: Array<[string, string, number]>, h = 26) => {
      box(h);
      let x = X;
      for (const [l, v, frac] of cells) {
        const w = W * frac;
        label(l, x + 5, y + 4);
        value(v, x + 5, y + 12, w - 10);
        x += w;
        if (x < X + W - 1) doc.moveTo(x, y).lineTo(x, y + h).strokeColor('#d3d8dd').stroke();
      }
      y += h;
    };

    // cabeçalho
    box(70);
    doc.font(B).fontSize(13).fillColor('#111').text('DANFSe', X + 8, y + 8);
    doc.font(R).fontSize(7.5).fillColor('#444').text('Documento Auxiliar da Nota Fiscal de Serviço Eletrônica', X + 8, y + 25, { width: 300 });
    doc.font(B).fontSize(8).fillColor('#111').text(`NFS-e nº ${data.number ?? '—'}`, X + 8, y + 40);
    doc.font(R).fontSize(7.5).text(`Emitida em ${fmtDate(data.issuedAt, true)}  ·  Competência ${fmtMonth(data.competence)}  ·  DPS ${data.dpsSeries ?? '—'}/${data.dpsNumber ?? '—'}`, X + 8, y + 52, { width: 380 });
    if (qr) doc.image(qr, X + W - 66, y + 6, { width: 58 });
    y += 70;
    grid([['Chave de acesso', data.accessKey ? data.accessKey.replace(/(\d{4})(?=\d)/g, '$1 ') : 'Ainda não autorizada', 1]], 24);
    if (data.environment !== 'producao' || data.status !== 'autorizada') {
      const warn = data.environment !== 'producao' ? 'AMBIENTE DE TESTES (PRODUÇÃO RESTRITA) — SEM VALOR FISCAL' : data.status === 'cancelada' ? 'NOTA CANCELADA' : data.status === 'substituida' ? 'NOTA SUBSTITUÍDA' : 'PRÉVIA — NOTA AINDA NÃO AUTORIZADA';
      doc.rect(X, y, W, 16).fill('#fde8e8');
      doc.font(B).fontSize(8).fillColor('#b42318').text(warn, X, y + 4.5, { width: W, align: 'center' });
      y += 16;
    }
    y += 6;

    section('Prestador do serviço');
    grid([['Razão social', data.emitter.name, 0.55], ['CNPJ', fmtDoc(data.emitter.cnpj), 0.25], ['Inscrição municipal', data.emitter.municipalRegistration ?? '—', 0.2]]);
    grid([['Endereço', data.emitter.address || '—', 0.55], ['Município', data.emitter.cityName ? `${data.emitter.cityName}/${data.emitter.uf ?? ''}` : '—', 0.25], ['Contato', [data.emitter.phone, data.emitter.email].filter(Boolean).join(' · ') || '—', 0.2]]);
    y += 6;

    section('Tomador do serviço');
    const ta = data.taker.address;
    grid([['Nome / razão social', data.taker.name ?? '—', 0.55], ['CPF/CNPJ', fmtDoc(data.taker.document), 0.25], ['Inscrição municipal', data.taker.municipalRegistration ?? '—', 0.2]]);
    grid([
      ['Endereço', ta ? [ta.street, ta.number, ta.complement, ta.district].filter(Boolean).join(', ') : '—', 0.55],
      ['Município', ta?.ibge ? cityLabel(ta.ibge) : '—', 0.25],
      ['CEP', ta?.cep ? digits(ta.cep).replace(/^(\d{5})(\d{3})$/, '$1-$2') : '—', 0.2],
    ]);
    y += 6;

    section('Serviço prestado');
    grid([['Código de tributação nacional', data.service.nationalLabel ? `${data.service.nationalCode} — ${data.service.nationalLabel}` : data.service.nationalCode ?? '—', 0.6], ['Código NBS', data.service.nbsCode ?? '—', 0.2], ['Local da prestação', cityLabel(data.placeOfService), 0.2]], 34);
    const descHeight = Math.max(40, doc.font(R).fontSize(8.5).heightOfString(data.description, { width: W - 12 }) + 20);
    box(descHeight);
    label('Discriminação do serviço', X + 5, y + 4);
    value(data.description, X + 6, y + 13, W - 12);
    y += descHeight + 6;

    section('Valores e tributação');
    const v = data.values;
    grid([
      ['Valor do serviço', brl(v.gross), 0.2],
      ['Desconto incondicionado', brl(v.discount), 0.2],
      ['Base de cálculo', brl(v.base), 0.2],
      ['Alíquota ISS', v.issRate !== null ? `${v.issRate.toFixed(2)}%` : 'Simples Nacional', 0.2],
      [v.issWithheld ? 'ISS retido pelo tomador' : 'ISS', v.issValue ? brl(v.issValue) : '—', 0.2],
    ]);
    grid([
      ['INSS retido', v.federal.inss ? brl(v.federal.inss) : '—', 0.2],
      ['IR retido', v.federal.ir ? brl(v.federal.ir) : '—', 0.2],
      ['CSLL retida', v.federal.csll ? brl(v.federal.csll) : '—', 0.2],
      ['PIS retido', v.federal.pis ? brl(v.federal.pis) : '—', 0.2],
      ['COFINS retida', v.federal.cofins ? brl(v.federal.cofins) : '—', 0.2],
    ]);
    box(30);
    label('Valor líquido da nota', X + 5, y + 5);
    doc.font(B).fontSize(13).fillColor('#111').text(brl(v.net), X + 5, y + 13);
    y += 36;

    if (data.notes) {
      section('Informações complementares');
      const h = Math.max(30, doc.font(R).fontSize(8).heightOfString(data.notes, { width: W - 12 }) + 16);
      box(h);
      doc.font(R).fontSize(8).fillColor('#111').text(data.notes, X + 6, y + 8, { width: W - 12 });
      y += h + 6;
    }

    doc.font(R).fontSize(6.5).fillColor('#6b7480').text(
      data.accessKey ? `Consulte a autenticidade em ${consultaUrl(data.accessKey)}` : 'Documento sem chave de acesso: não tem validade fiscal.',
      X, doc.page.height - 40, { width: W, align: 'center' },
    );
    doc.end();
  });
}
