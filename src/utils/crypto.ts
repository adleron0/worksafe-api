import * as CryptoJS from 'crypto-js'; // Importação correta para CommonJS

// Chave secreta (precisa ter 32 bytes para AES-256)
const SECRET_KEY = CryptoJS.enc.Utf8.parse(
  process.env.PAYLOAD_ACCESS_SECRET || '12345678901234567890123456789012',
);

// Gera um IV aleatório de 16 bytes
function generateIV() {
  return CryptoJS.lib.WordArray.random(16);
}

// Função para criptografar o payload
export function encryptPayload(payload: any): string {
  const iv = generateIV();

  const encrypted = CryptoJS.AES.encrypt(JSON.stringify(payload), SECRET_KEY, {
    iv: iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  }).toString();

  // Concatena o IV e o texto criptografado
  return `${iv.toString(CryptoJS.enc.Hex)}:${encrypted}`;
}

// Função para descriptografar o payload
export function decryptPayload(ciphertext: string): any {
  const [ivHex, encrypted] = ciphertext.split(':');
  const iv = CryptoJS.enc.Hex.parse(ivHex);

  const decrypted = CryptoJS.AES.decrypt(encrypted, SECRET_KEY, {
    iv: iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });

  // Converte o texto descriptografado de WordArray para string UTF-8
  const decryptedText = decrypted.toString(CryptoJS.enc.Utf8);

  return JSON.parse(decryptedText);
}
