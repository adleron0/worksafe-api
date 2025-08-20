const BASE_URL = {
  prod: 'https://api.asaas.com/v3',
  sandbox: 'https://sandbox.asaas.com/api/v3',
};

const ENDPOINTS = {
  accounts: '/accounts',
  customers: '/customers',
  payments: '/payments',
  webhooks: '/webhooks',
};

const PAYMENT_TYPES = {
  boleto: 'BOLETO',
  pix: 'PIX',
  cartao: 'CREDIT_CARD',
};

const INVERT_PAYMENT_TYPES = {
  BOLETO: 'boleto',
  PIX: 'pix',
  CREDIT_CARD: 'cartao',
};

const WEBHOOK_EVENTS = [
  'PAYMENT_CREATED',
  'PAYMENT_AUTHORIZED',
  'PAYMENT_UPDATED',
  'PAYMENT_CONFIRMED',
  'PAYMENT_RECEIVED',
  'PAYMENT_OVERDUE',
  'PAYMENT_DELETED',
  'PAYMENT_REFUNDED',
  'PAYMENT_REFUND_IN_PROGRESS',
];

const DEFAULT_INCOME = 2500;