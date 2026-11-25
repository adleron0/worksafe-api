import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import * as forge from 'node-forge';

/**
 * Certificado digital A1 (e-CNPJ, arquivo .pfx/.p12).
 *
 * O arquivo e a senha ficam cifrados juntos (AES-256-GCM) com a chave da
 * variável `FISCAL_SECRET`, que só existe no servidor. Não usamos a chave do
 * payload do JWT porque ela também vai para o front.
 */

export interface CertificateInfo {
  subject: string;
  document: string | null; // CNPJ (ou CPF) do titular
  validFrom: Date;
  validTo: Date;
}

export interface LoadedCertificate extends CertificateInfo {
  pfx: Buffer;
  password: string;
  privateKeyPem: string;
  certificatePem: string;
  certificateBase64: string; // DER em base64, para o KeyInfo da assinatura
}

export class CertificateError extends Error {}

function secretKey(): Buffer {
  const secret = process.env.FISCAL_SECRET;
  if (!secret || secret.length < 16) {
    throw new CertificateError('A chave FISCAL_SECRET não está configurada no servidor (precisa de pelo menos 16 caracteres). Sem ela o certificado não pode ser guardado.');
  }
  return createHash('sha256').update(secret).digest();
}

export function encryptCertificate(pfx: Buffer, password: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  const payload = Buffer.from(JSON.stringify({ pfx: pfx.toString('base64'), password }), 'utf8');
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
}

export function decryptCertificate(stored: string): { pfx: Buffer; password: string } {
  const [version, iv, tag, data] = String(stored).split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new CertificateError('Certificado guardado em formato desconhecido. Envie o arquivo de novo.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(plain) as { pfx: string; password: string };
    return { pfx: Buffer.from(parsed.pfx, 'base64'), password: parsed.password };
  } catch (error) {
    if (error instanceof CertificateError) throw error;
    throw new CertificateError('Não foi possível abrir o certificado guardado (a chave FISCAL_SECRET mudou?). Envie o arquivo de novo.');
  }
}

/** O CNPJ do e-CNPJ fica no CN ("RAZAO SOCIAL:12345678000199") ou no OID 2.16.76.1.3.3. */
function documentOf(cert: forge.pki.Certificate): string | null {
  const cn = String(cert.subject.getField('CN')?.value ?? '');
  const fromCn = cn.match(/:(\d{14}|\d{11})$/);
  if (fromCn) return fromCn[1];
  const any = cert.subject.attributes.map((a) => String(a.value ?? '')).join(' ');
  const loose = any.match(/\b(\d{14})\b/);
  return loose ? loose[1] : null;
}

/** Abre o .pfx com a senha e devolve chave, certificado e dados do titular. */
export function loadCertificate(pfx: Buffer, password: string): LoadedCertificate {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch {
    throw new CertificateError('Não foi possível abrir o certificado: confira se o arquivo é um .pfx (A1) e se a senha está certa.');
  }
  const keyBags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const key = keyBags.find((bag) => bag.key)?.key as forge.pki.rsa.PrivateKey | undefined;
  if (!key) throw new CertificateError('O arquivo não traz a chave privada. Exporte o certificado A1 com a chave.');
  // o certificado do titular é o que casa com a chave (o arquivo pode trazer a cadeia toda)
  const publicOf = (c: forge.pki.Certificate) => (c.publicKey as forge.pki.rsa.PublicKey).n?.toString(16);
  const cert = certBags.map((bag) => bag.cert).find((c) => c && publicOf(c) === key.n.toString(16)) ?? certBags[0]?.cert;
  if (!cert) throw new CertificateError('O arquivo não traz o certificado.');
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return {
    pfx,
    password,
    privateKeyPem: forge.pki.privateKeyToPem(key),
    certificatePem: forge.pki.certificateToPem(cert),
    certificateBase64: forge.util.encode64(der),
    subject: String(cert.subject.getField('CN')?.value ?? cert.subject.attributes.map((a) => a.value).join(', ')),
    document: documentOf(cert),
    validFrom: cert.validity.notBefore,
    validTo: cert.validity.notAfter,
  };
}
