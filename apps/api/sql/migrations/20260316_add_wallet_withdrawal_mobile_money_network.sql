ALTER TABLE wallet_withdrawals
  ADD COLUMN IF NOT EXISTS mobile_money_network TEXT;
