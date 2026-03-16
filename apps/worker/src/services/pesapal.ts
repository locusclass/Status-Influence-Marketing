import { fetch } from 'undici';
import { config } from '../config.js';

export async function requestPayout(input: {
  amount: number;
  currency: string;
  narration: string;
  reference: string;
  receiverName: string;
  receiverPhone: string;
  receiverNetwork?: string;
}) {
  const res = await fetch(`${config.flutterwave.baseUrl}/transfers`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.flutterwave.secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      account_bank: (input.receiverNetwork ?? 'MTN').trim().toUpperCase(),
      account_number: input.receiverPhone,
      amount: input.amount,
      narration: input.narration,
      currency: input.currency,
      reference: input.reference,
      debit_currency: input.currency,
      beneficiary_name: input.receiverName,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Flutterwave transfer failed: ${res.status} ${text}`);
  }

  return res.json();
}
