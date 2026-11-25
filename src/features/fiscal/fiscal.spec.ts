import { execFileSync } from 'child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { decryptCertificate, encryptCertificate, loadCertificate } from './certificate';
import { buildCancelEvent, buildDps, dpsIdOf, DpsInput } from './dps.builder';
import { ibgeOf, money } from './fiscal.utils';
import { parseNfseXml } from './nfse-xml';
import { packXml, parseSefinResponse, unpackXml } from './sefin.client';
import { makeTestPfx } from './test-certificate';
import { signXml, verifyXml } from './xml-signer';

const XSD_DIR = join(__dirname, 'xsd');
const hasXmllint = (() => {
  try { execFileSync('xmllint', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

/**
 * Valida o XML contra o XSD oficial com o xmllint (quando a máquina tem).
 * O XSD oficial usa "^...$" no padrão da série; em XSD isso não é âncora e o
 * libxml lê os dois como caracteres. A cópia usada no teste tira as âncoras.
 */
function validate(xml: string, schema: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'nfse-'));
  for (const name of readdirSync(XSD_DIR)) {
    const text = readFileSync(join(XSD_DIR, name), 'utf8').replace(/value="\^([^"]*)\$"/g, 'value="$1"');
    writeFileSync(join(dir, name), text);
  }
  const file = join(dir, 'doc.xml');
  writeFileSync(file, xml);
  try {
    execFileSync('xmllint', ['--noout', '--schema', join(dir, schema), file], { stdio: 'pipe' });
    return 'ok';
  } catch (error) {
    return String((error as { stderr?: Buffer }).stderr ?? error);
  }
}

const base = (): DpsInput => ({
  environment: 'restrita',
  issuedAt: new Date('2026-11-25T15:00:00Z'),
  series: '900',
  number: 1,
  competence: '2026-11-25',
  emitterIbge: '2611606',
  provider: { cnpj: '12345678000195', simplesNacional: 3, simplesRegime: 1, specialRegime: 0 },
  taker: {
    document: '11222333000181',
    name: 'Cliente & Filhos <Ltda>',
    address: { ibge: '2611606', cep: '50030-230', street: 'Rua do Bom Jesus', number: '123', district: 'Recife Antigo' },
    email: 'fiscal@cliente.com.br',
  },
  service: { placeIbge: '2611606', nationalCode: '080201', description: 'Treinamento NR-35 — turma 12 (20 alunos)', nbs: '122051900' },
  values: { gross: 1500, issTaxation: 1, issWithheld: false },
});

describe('fiscal: tabelas', () => {
  it('acha o código IBGE pelo nome e UF, ignorando acento e caixa', () => {
    expect(ibgeOf('Recife', 'PE')).toBe('2611606');
    expect(ibgeOf('SAO PAULO', 'sp')).toBe('3550308');
    expect(ibgeOf("Alta Floresta D'Oeste", 'RO')).toBe('1100015');
    expect(ibgeOf('Cidade Que Não Existe', 'PE')).toBeNull();
  });
  it('formata valores no padrão da NFS-e', () => {
    expect(money(0)).toBe('0');
    expect(money(10)).toBe('10.00');
    expect(money(1234.5)).toBe('1234.50');
  });
});

describe('fiscal: certificado', () => {
  const pfx = makeTestPfx();
  it('abre o .pfx e lê o CNPJ do titular', () => {
    const cert = loadCertificate(pfx, 'teste123');
    expect(cert.document).toBe('12345678000195');
    expect(cert.privateKeyPem).toContain('PRIVATE KEY');
    expect(cert.validTo.getTime()).toBeGreaterThan(Date.now());
  });
  it('recusa senha errada com mensagem clara', () => {
    expect(() => loadCertificate(pfx, 'errada')).toThrow(/senha/);
  });
  it('cifra e decifra com FISCAL_SECRET', () => {
    process.env.FISCAL_SECRET = 'segredo-de-teste-com-32-caracteres!!';
    const stored = encryptCertificate(pfx, 'teste123');
    expect(stored).not.toContain('teste123');
    const back = decryptCertificate(stored);
    expect(back.password).toBe('teste123');
    expect(back.pfx.equals(pfx)).toBe(true);
    process.env.FISCAL_SECRET = 'outra-chave-diferente-1234567890';
    expect(() => decryptCertificate(stored)).toThrow(/FISCAL_SECRET/);
  });
});

describe('fiscal: DPS', () => {
  const cert = loadCertificate(makeTestPfx(), 'teste123');

  it('monta o Id com 45 caracteres no formato oficial', () => {
    const id = dpsIdOf('2611606', '12345678000195', '900', 1);
    expect(id).toBe('DPS261160621234567800019500900000000000000001');
    expect(id).toMatch(/^DPS\d{42}$/);
  });

  it('gera XML válido no XSD oficial, já assinado', () => {
    const { xml, id } = buildDps(base());
    expect(xml).toContain('Cliente &amp; Filhos &lt;Ltda&gt;');
    expect(xml).not.toContain('<pAliq>'); // ISS não retido no Simples: sem alíquota
    const signed = signXml(xml, 'infDPS', cert.privateKeyPem, cert.certificatePem);
    expect(signed).toContain(`URI="#${id}"`);
    expect(signed.indexOf('</infDPS>')).toBeLessThan(signed.indexOf('<Signature'));
    expect(verifyXml(signed, cert.certificatePem)).toBe(true);
    if (hasXmllint) expect(validate(signed, 'DPS_v1.01.xsd')).toBe('ok');
  });

  it('com ISS retido, retenções federais, desconto e tomador pessoa física', () => {
    const input = base();
    input.taker = { document: '52998224725', name: 'Fulano de Tal' };
    input.values = { gross: 10000, unconditionalDiscount: 500, issTaxation: 1, issWithheld: true, issRate: 5, federal: { inss: 1100, ir: 150, csll: 100, pisRate: 0.65, cofinsRate: 3 } };
    input.info = { reference: 'Proposta PC-2026-0042', order: '4500012345', notes: 'Valor líquido a pagar: R$ 7.785,00' };
    const { xml } = buildDps(input);
    expect(xml).toContain('<tpRetISSQN>2</tpRetISSQN><pAliq>5.00</pAliq>');
    expect(xml).toContain('<CPF>52998224725</CPF>');
    expect(xml).toContain('<vRetCP>1100.00</vRetCP>');
    expect(xml).toContain('<vBCPisCofins>9500.00</vBCPisCofins><pAliqPis>0.65</pAliqPis><pAliqCofins>3.00</pAliqCofins><vPis>61.75</vPis><vCofins>285.00</vCofins><tpRetPisCofins>3</tpRetPisCofins>');
    expect(xml).toContain('<regApTribSN>1</regApTribSN>');
    expect(xml).toContain('<pTotTribSN>0.00</pTotTribSN>');
    const signed = signXml(xml, 'infDPS', cert.privateKeyPem, cert.certificatePem);
    if (hasXmllint) expect(validate(signed, 'DPS_v1.01.xsd')).toBe('ok');
  });

  it('pedido de cancelamento válido no XSD', () => {
    const key = '26116062123456780001950000000000000126110000000001'.slice(0, 50);
    const { xml, id } = buildCancelEvent({ environment: 'restrita', authorDocument: '12345678000195', accessKey: key, reasonCode: 1, reason: 'Valor informado errado na emissão' });
    expect(id).toBe(`PRE${key}101101`);
    const signed = signXml(xml, 'infPedReg', cert.privateKeyPem, cert.certificatePem);
    if (hasXmllint) expect(validate(signed, 'pedRegEvento_v1.01.xsd')).toBe('ok');
  });
});

describe('fiscal: respostas da Sefin', () => {
  it('lê a NFS-e autorizada (GZip + Base64)', () => {
    const nfse = '<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS26116062123456780001950000000000000126110000000001"><xLocEmi>Recife</xLocEmi><nNFSe>17</nNFSe><cStat>100</cStat><dhProc>2026-11-25T12:00:01-03:00</dhProc><valores><vLiq>1500.00</vLiq></valores><DPS><infDPS><nDPS>1</nDPS></infDPS></DPS></infNFSe></NFSe>';
    const result = parseSefinResponse(201, JSON.stringify({ chaveAcesso: '26116062123456780001950000000000000126110000000001', nfseXmlGZipB64: packXml(nfse), alertas: [{ Codigo: 'A001', Descricao: 'Aviso' }] }));
    expect(result.ok).toBe(true);
    expect(result.accessKey).toHaveLength(50);
    expect(result.alerts[0].code).toBe('A001');
    const parsed = parseNfseXml(result.xml!);
    expect(parsed.number).toBe('17');
    expect(parsed.netValue).toBe(1500);
    expect(parsed.accessKey).toBe('26116062123456780001950000000000000126110000000001');
  });
  it('lê rejeições nas duas grafias', () => {
    const a = parseSefinResponse(400, JSON.stringify({ erros: [{ Codigo: 'E0014', Descricao: 'DPS já processada', Complemento: 'x' }] }));
    expect(a.ok).toBe(false);
    expect(a.errors[0]).toEqual({ code: 'E0014', description: 'DPS já processada', complement: 'x' });
    const b = parseSefinResponse(422, { erro: { codigo: 'E1', descricao: 'teste' } });
    expect(b.errors[0].code).toBe('E1');
  });
  it('403 em HTML vira mensagem sobre o certificado', () => {
    const r = parseSefinResponse(403, '<html><title>403 - Forbidden</title></html>');
    expect(r.errors[0].description).toMatch(/certificado/);
  });
  it('compacta e descompacta sem perder acentuação', () => {
    expect(unpackXml(packXml('<a>Ação é ótima</a>'))).toBe('<a>Ação é ótima</a>');
  });
});
