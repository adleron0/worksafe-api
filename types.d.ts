// types.d.ts
import 'express';

// Extensão da interface Request do Express
declare module 'express' {
  export interface Request {
    user?: any;
    companyId?: string;
    role?: string;
  }
}

// Declaração dos módulos do CryptoJS
declare module 'crypto-js/aes';
declare module 'crypto-js/enc-utf8';
