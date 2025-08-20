const financialRecordsStatus = {
  processing: 'processing',
  waiting: 'waiting',
  received: 'received',
  declined: 'declined',
  chargeback: 'chargeback',
  cancelled: 'cancelled',
  overdue: 'overdue',
};

const asaasStatus = {
  PENDING: financialRecordsStatus.waiting,
  RECEIVED: financialRecordsStatus.received,
  CONFIRMED: financialRecordsStatus.received,
  OVERDUE: financialRecordsStatus.overdue,
  REFUNDED: financialRecordsStatus.declined,
  RECEIVED_IN_CASH: financialRecordsStatus.received,
  REFUND_REQUESTED: financialRecordsStatus.chargeback,
  REFUND_IN_PROGRESS: financialRecordsStatus.chargeback,
  CHARGEBACK_REQUESTED: financialRecordsStatus.chargeback,
  CHARGEBACK_DISPUTE: financialRecordsStatus.chargeback,
  AWAITING_CHARGEBACK_REVERSAL: financialRecordsStatus.chargeback,
  DUNNING_REQUESTED: financialRecordsStatus.chargeback,
  DUNNING_RECEIVED: financialRecordsStatus.chargeback,
  AWAITING_RISK_ANALYSIS: financialRecordsStatus.waiting,
  PAID: financialRecordsStatus.received,
  SETTLED: financialRecordsStatus.received,
  PAYMENT_DELETED: financialRecordsStatus.cancelled,
};

export default {
  financialRecordsStatus,
  asaasStatus,
};
