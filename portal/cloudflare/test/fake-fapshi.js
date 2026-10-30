import { recordVerifiedPaymentResult } from "../src/payments.js";

const supportedOutcomes = new Set(["pending", "successful", "failed", "expired"]);

export function createFakeFapshi({ db, clock = () => new Date() }) {
  return {
    async settleOrder({
      orderReference,
      outcome,
      amountXaf,
      providerTransactionId = `FAKE-${crypto.randomUUID()}`,
    }) {
      if (!supportedOutcomes.has(outcome)) {
        throw new Error(`Unsupported fake payment outcome: ${outcome}`);
      }

      const order = await db
        .prepare("SELECT amount_xaf FROM orders WHERE reference = ?")
        .bind(orderReference)
        .first();

      if (!order) {
        throw new Error("Fake Fapshi cannot find the requested order");
      }

      const verifiedResult = {
        orderReference,
        providerTransactionId,
        amountXaf: amountXaf ?? order.amount_xaf,
        status: outcome,
      };

      return {
        event: verifiedResult,
        processing: await recordVerifiedPaymentResult(db, verifiedResult, clock),
      };
    },
  };
}
