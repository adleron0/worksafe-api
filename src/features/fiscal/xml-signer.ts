import { SignedXml } from 'xml-crypto';

/**
 * Assinatura XMLDSig no padrão da NFS-e Nacional (o mesmo da NF-e):
 * RSA-SHA1, canonicalização C14N 1.0, transforms enveloped + C14N, Reference
 * para o Id do elemento assinado e a Signature como irmã logo depois dele.
 */
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';

export function signXml(xml: string, elementName: 'infDPS' | 'infPedReg', privateKeyPem: string, certificatePem: string): string {
  const xpath = `//*[local-name(.)='${elementName}']`;
  const sig = new SignedXml({
    privateKey: privateKeyPem,
    publicCert: certificatePem,
    signatureAlgorithm: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    canonicalizationAlgorithm: C14N,
  });
  sig.addReference({
    xpath,
    digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', C14N],
  });
  sig.computeSignature(xml, { location: { reference: xpath, action: 'after' } });
  return sig.getSignedXml();
}

/** Confere a assinatura (usado nos testes e para validar XML recebido). */
export function verifyXml(signedXml: string, certificatePem: string): boolean {
  const match = signedXml.match(/<Signature[\s\S]*?<\/Signature>/);
  if (!match) return false;
  const sig = new SignedXml({ publicCert: certificatePem });
  sig.loadSignature(match[0]);
  try {
    return sig.checkSignature(signedXml);
  } catch {
    return false;
  }
}
