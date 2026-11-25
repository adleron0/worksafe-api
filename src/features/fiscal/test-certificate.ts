import * as forge from 'node-forge';

/**
 * Certificado A1 de mentira, só para testes: gera um .pfx autoassinado no
 * formato do e-CNPJ (CN "RAZAO SOCIAL:CNPJ"). Nunca é aceito pelo ambiente
 * nacional, que exige ICP-Brasil.
 */
export function makeTestPfx(cnpj = '12345678000195', password = 'teste123', days = 365): Buffer {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + days * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: `EMPRESA DE TESTE LTDA:${cnpj}` }, { name: 'countryName', value: 'BR' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
}
